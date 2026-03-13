//! ANSI-aware text measurement and slicing utilities.
//!
//! Optimized for JS string interop (UTF-16).
//! - Single-pass ANSI scanning (no O(n^2) `next_ansi` rescans)
//! - ASCII fast-path (no grapheme segmentation, no UTF-8 conversion)
//! - Non-ASCII uses a reused scratch String for grapheme segmentation
//! - Width checks early-exit
//! - Ellipsis decoded lazily
//! - truncateToWidth returns the original `JsString` when possible

use std::cell::RefCell;

use napi::{JsString, bindgen_prelude::*};
use napi_derive::napi;
use smallvec::{SmallVec, smallvec};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

const DEFAULT_TAB_WIDTH: usize = 3;
const MIN_TAB_WIDTH: usize = 1;
const MAX_TAB_WIDTH: usize = 16;
const ESC: u16 = 0x1b;

#[inline]
const fn clamp_tab_width(tab_width: Option<u32>) -> usize {
	let width = match tab_width {
		Some(tab_width) => tab_width as usize,
		None => DEFAULT_TAB_WIDTH,
	};
	if width < MIN_TAB_WIDTH {
		MIN_TAB_WIDTH
	} else if width > MAX_TAB_WIDTH {
		MAX_TAB_WIDTH
	} else {
		width
	}
}

/// Clamp a u64 to u32::MAX, returning as u32.
#[inline]
const fn clamp_u32(v: u64) -> u32 {
	if v > u32::MAX as u64 {
		u32::MAX
	} else {
		v as u32
	}
}

fn utf16_to_string(data: impl AsRef<[u16]>) -> String {
	let mut slice = data.as_ref();
	// Strip trailing null terminators (from JsStringUtf16::as_slice())
	while slice.last() == Some(&0) {
		slice = &slice[..slice.len() - 1];
	}
	String::from_utf16_lossy(slice)
}

// ============================================================================
// Results
// ============================================================================

#[napi(object)]
pub struct SliceResult {
	/// UTF-16 slice containing the selected text.
	pub text: String,
	/// Visible width of the slice in terminal cells.
	pub width: u32,
}

#[napi(object)]
pub struct ExtractSegmentsResult {
	/// UTF-16 content before the overlay region.
	pub before: String,
	#[napi(js_name = "beforeWidth")]
	/// Visible width of the `before` segment.
	pub before_width: u32,
	/// UTF-16 content after the overlay region.
	pub after: String,
	#[napi(js_name = "afterWidth")]
	/// Visible width of the `after` segment.
	pub after_width: u32,
}

// ============================================================================
// ANSI State Tracking - Zero Allocation
// ============================================================================

const ATTR_BOLD: u16 = 1 << 0;
const ATTR_DIM: u16 = 1 << 1;
const ATTR_ITALIC: u16 = 1 << 2;
const ATTR_UNDERLINE: u16 = 1 << 3;
const ATTR_BLINK: u16 = 1 << 4;
const ATTR_INVERSE: u16 = 1 << 6;
const ATTR_HIDDEN: u16 = 1 << 7;
const ATTR_STRIKE: u16 = 1 << 8;

type ColorVal = u32;
const COLOR_NONE: ColorVal = 0;

#[derive(Clone, Copy, Default)]
struct AnsiState {
	attrs: u16,
	fg: ColorVal,
	bg: ColorVal,
}

impl AnsiState {
	#[inline]
	const fn new() -> Self {
		Self { attrs: 0, fg: COLOR_NONE, bg: COLOR_NONE }
	}

	#[inline]
	const fn is_empty(&self) -> bool {
		self.attrs == 0 && self.fg == COLOR_NONE && self.bg == COLOR_NONE
	}

	#[inline]
	const fn reset(&mut self) {
		*self = Self::new();
	}

	fn apply_sgr_u16(&mut self, params: &[u16]) {
		if params.is_empty() {
			self.reset();
			return;
		}

		let mut i = 0;
		while i < params.len() {
			let (code, next_i) = parse_sgr_num_u16(params, i);
			i = next_i;

			match code {
				0 => self.reset(),
				1 => self.attrs |= ATTR_BOLD,
				2 => self.attrs |= ATTR_DIM,
				3 => self.attrs |= ATTR_ITALIC,
				4 => self.attrs |= ATTR_UNDERLINE,
				5 => self.attrs |= ATTR_BLINK,
				7 => self.attrs |= ATTR_INVERSE,
				8 => self.attrs |= ATTR_HIDDEN,
				9 => self.attrs |= ATTR_STRIKE,

				21 => self.attrs &= !ATTR_BOLD,
				22 => self.attrs &= !(ATTR_BOLD | ATTR_DIM),
				23 => self.attrs &= !ATTR_ITALIC,
				24 => self.attrs &= !ATTR_UNDERLINE,
				25 => self.attrs &= !ATTR_BLINK,
				27 => self.attrs &= !ATTR_INVERSE,
				28 => self.attrs &= !ATTR_HIDDEN,
				29 => self.attrs &= !ATTR_STRIKE,

				30..=37 => self.fg = (code - 29) as ColorVal,
				39 => self.fg = COLOR_NONE,
				40..=47 => self.bg = (code - 39) as ColorVal,
				49 => self.bg = COLOR_NONE,
				90..=97 => self.fg = (code - 81) as ColorVal,
				100..=107 => self.bg = (code - 91) as ColorVal,

				38 | 48 => {
					let (mode, ni) = parse_sgr_num_u16(params, i);
					i = ni;

					let color = match mode {
						5 => {
							let (idx, ni) = parse_sgr_num_u16(params, i);
							i = ni;
							0x100 | (idx as ColorVal & 0xff)
						},
						2 => {
							let (r, ni) = parse_sgr_num_u16(params, i);
							let (g, ni) = parse_sgr_num_u16(params, ni);
							let (b, ni) = parse_sgr_num_u16(params, ni);
							i = ni;
							0x1000000
								| ((r as ColorVal & 0xff) << 16)
								| ((g as ColorVal & 0xff) << 8)
								| (b as ColorVal & 0xff)
						},
						_ => continue,
					};

					if code == 38 {
						self.fg = color;
					} else {
						self.bg = color;
					}
				},

				_ => {},
			}
		}
	}

	fn write_restore_u16(&self, out: &mut Vec<u16>) {
		if self.is_empty() {
			return;
		}

		out.extend_from_slice(&[ESC, b'[' as u16]);
		let mut first = true;

		macro_rules! push_code {
			($code:expr) => {{
				if !first {
					out.push(b';' as u16);
				}
				first = false;
				write_u32_u16(out, $code);
			}};
		}

		if self.attrs & ATTR_BOLD != 0 {
			push_code!(1);
		}
		if self.attrs & ATTR_DIM != 0 {
			push_code!(2);
		}
		if self.attrs & ATTR_ITALIC != 0 {
			push_code!(3);
		}
		if self.attrs & ATTR_UNDERLINE != 0 {
			push_code!(4);
		}
		if self.attrs & ATTR_BLINK != 0 {
			push_code!(5);
		}
		if self.attrs & ATTR_INVERSE != 0 {
			push_code!(7);
		}
		if self.attrs & ATTR_HIDDEN != 0 {
			push_code!(8);
		}
		if self.attrs & ATTR_STRIKE != 0 {
			push_code!(9);
		}

		write_color_u16(out, self.fg, 38, &mut first);
		write_color_u16(out, self.bg, 48, &mut first);

		out.push(b'm' as u16);
	}
}

#[inline]
fn write_color_u16(out: &mut Vec<u16>, color: ColorVal, base: u32, first: &mut bool) {
	if color == COLOR_NONE {
		return;
	}

	if !*first {
		out.push(b';' as u16);
	}
	*first = false;

	if color < 0x100 {
		let code = if color <= 8 { color + 29 } else { color + 81 };
		let code = if base == 48 { code + 10 } else { code };
		write_u32_u16(out, code);
	} else if color < 0x1000000 {
		write_u32_u16(out, base);
		out.extend_from_slice(&[b';' as u16, b'5' as u16, b';' as u16]);
		write_u32_u16(out, color & 0xff);
	} else {
		write_u32_u16(out, base);
		out.extend_from_slice(&[b';' as u16, b'2' as u16, b';' as u16]);
		write_u32_u16(out, (color >> 16) & 0xff);
		out.push(b';' as u16);
		write_u32_u16(out, (color >> 8) & 0xff);
		out.push(b';' as u16);
		write_u32_u16(out, color & 0xff);
	}
}

#[inline]
fn parse_sgr_num_u16(params: &[u16], mut i: usize) -> (u32, usize) {
	while i < params.len() && params[i] == b';' as u16 {
		i += 1;
	}

	let mut val: u32 = 0;
	while i < params.len() {
		let b = params[i];
		if b == b';' as u16 {
			i += 1;
			break;
		}
		if (b'0' as u16..=b'9' as u16).contains(&b) {
			val = val
				.saturating_mul(10)
				.saturating_add((b - b'0' as u16) as u32);
		}
		i += 1;
	}
	(val, i)
}

#[inline]
fn write_u32_u16(out: &mut Vec<u16>, mut val: u32) {
	if val == 0 {
		out.push(b'0' as u16);
		return;
	}
	let start = out.len();
	while val > 0 {
		out.push(b'0' as u16 + (val % 10) as u16);
		val /= 10;
	}
	out[start..].reverse();
}

// ============================================================================
// ANSI Sequence Detection - UTF-16
// ============================================================================

#[inline]
fn ansi_seq_len_u16(data: &[u16], pos: usize) -> Option<usize> {
	if pos >= data.len() || data[pos] != ESC {
		return None;
	}
	if pos + 1 >= data.len() {
		return None;
	}

	match data[pos + 1] {
		0x5b => {
			// '[' CSI
			for (i, b) in data[pos + 2..].iter().enumerate() {
				if (0x40..=0x7e).contains(b) {
					return Some(i + 3);
				}
			}
			None
		},
		0x5d => {
			// ']' OSC
			for (i, &b) in data[pos + 2..].iter().enumerate() {
				if b == 0x07 {
					return Some(i + 3);
				}
				if b == ESC && data.get(pos + 2 + i + 1) == Some(&0x5c) {
					return Some(i + 4);
				}
			}
			None
		},
		0x50 | 0x58 | 0x5e | 0x5f => {
			// 'P' DCS, 'X' SOS, '^' PM, '_' APC (terminated by ST)
			for (i, &b) in data[pos + 2..].iter().enumerate() {
				if b == ESC && data.get(pos + 2 + i + 1) == Some(&0x5c) {
					return Some(i + 4);
				}
			}
			None
		},
		0x20..=0x2f => {
			// ESC + intermediates + final byte
			for (i, b) in data[pos + 2..].iter().enumerate() {
				if (0x30..=0x7e).contains(b) {
					return Some(i + 3);
				}
			}
			None
		},
		0x40..=0x7e => Some(2),
		_ => None,
	}
}

#[inline]
fn is_sgr_u16(seq: &[u16]) -> bool {
	seq.len() >= 3 && seq[1] == b'[' as u16 && *seq.last().unwrap() == b'm' as u16
}

// ============================================================================
// Grapheme / Width
// ============================================================================

#[inline]
const fn ascii_cell_width_u16(u: u16, tab_width: usize) -> usize {
	let b = u as u8;
	match b {
		b'\t' => tab_width,
		0x20..=0x7e => 1,
		_ => 0,
	}
}

#[inline]
fn grapheme_width_str(g: &str, tab_width: usize) -> usize {
	if g == "\t" {
		return tab_width;
	}
	let mut it = g.chars();
	let Some(c0) = it.next() else {
		return 0;
	};
	if it.next().is_none() {
		return UnicodeWidthChar::width(c0).unwrap_or(0);
	}
	UnicodeWidthStr::width(g)
}

thread_local! {
	static SCRATCH: RefCell<String> = const { RefCell::new(String::new()) };
}

/// Iterate graphemes in a non-ASCII UTF-16 segment.
///
/// Callback returns `true` to continue, `false` to stop early.
#[inline]
fn for_each_grapheme_u16_slow<F>(segment: &[u16], tab_width: usize, mut f: F) -> bool
where
	F: FnMut(&[u16], usize) -> bool,
{
	if segment.is_empty() {
		return true;
	}

	SCRATCH.with_borrow_mut(|scratch| {
		scratch.clear();
		scratch.reserve(segment.len());

		for r in std::char::decode_utf16(segment.iter().copied()) {
			scratch.push(r.unwrap_or('\u{FFFD}'));
		}

		let mut utf16_pos = 0usize;
		for g in scratch.graphemes(true) {
			let w = grapheme_width_str(g, tab_width);

			let g_u16_len: usize = g.chars().map(|c| c.len_utf16()).sum();
			let u16_slice = &segment[utf16_pos..utf16_pos + g_u16_len];
			utf16_pos += g_u16_len;

			if !f(u16_slice, w) {
				return false;
			}
		}

		true
	})
}

/// Visible width, with early-exit if width exceeds `limit`.
fn visible_width_u16_up_to(data: &[u16], limit: usize, tab_width: usize) -> (usize, bool) {
	let mut width = 0usize;
	let mut i = 0usize;
	let len = data.len();

	while i < len {
		if data[i] == ESC {
			if let Some(seq_len) = ansi_seq_len_u16(data, i) {
				i += seq_len;
				continue;
			}
			i += 1;
			continue;
		}

		let start = i;
		let mut is_ascii = true;
		while i < len && data[i] != ESC {
			if data[i] > 0x7f {
				is_ascii = false;
			}
			i += 1;
		}
		let seg = &data[start..i];

		if is_ascii {
			for &u in seg {
				width += ascii_cell_width_u16(u, tab_width);
				if width > limit {
					return (width, true);
				}
			}
		} else {
			let ok = for_each_grapheme_u16_slow(seg, tab_width, |_, w| {
				width += w;
				width <= limit
			});
			if !ok {
				return (width, true);
			}
		}
	}

	(width, width > limit)
}

fn visible_width_u16(data: &[u16], tab_width: usize) -> usize {
	visible_width_u16_up_to(data, usize::MAX, tab_width).0
}

// ============================================================================
// wrapTextWithAnsi
// ============================================================================

#[inline]
fn write_active_codes(state: &AnsiState, out: &mut Vec<u16>) {
	if !state.is_empty() {
		state.write_restore_u16(out);
	}
}

#[inline]
fn write_line_end_reset(state: &AnsiState, out: &mut Vec<u16>) {
	let has_underline = state.attrs & ATTR_UNDERLINE != 0;
	let has_strike = state.attrs & ATTR_STRIKE != 0;
	if !has_underline && !has_strike {
		return;
	}

	out.extend_from_slice(&[ESC, b'[' as u16]);
	if has_underline {
		out.extend_from_slice(&[b'2' as u16, b'4' as u16]);
		if has_strike {
			out.push(b';' as u16);
		}
	}
	if has_strike {
		out.extend_from_slice(&[b'2' as u16, b'9' as u16]);
	}
	out.push(b'm' as u16);
}

fn update_state_from_text(data: &[u16], state: &mut AnsiState) {
	let mut i = 0usize;
	while i < data.len() {
		if data[i] == ESC {
			if let Some(seq_len) = ansi_seq_len_u16(data, i) {
				let seq = &data[i..i + seq_len];
				if is_sgr_u16(seq) {
					state.apply_sgr_u16(&seq[2..seq_len - 1]);
				}
				i += seq_len;
				continue;
			}
		}
		i += 1;
	}
}

fn token_is_whitespace(token: &[u16]) -> bool {
	let mut i = 0usize;
	while i < token.len() {
		if token[i] == ESC {
			if let Some(seq_len) = ansi_seq_len_u16(token, i) {
				i += seq_len;
				continue;
			}
		}
		if token[i] != b' ' as u16 {
			return false;
		}
		i += 1;
	}
	true
}

fn trim_end_spaces_in_place(line: &mut Vec<u16>) {
	while let Some(&last) = line.last() {
		if last == b' ' as u16 {
			line.pop();
		} else {
			break;
		}
	}
}

fn split_into_tokens_with_ansi(line: &[u16]) -> SmallVec<[Vec<u16>; 4]> {
	let mut tokens = SmallVec::<[Vec<u16>; 4]>::new();
	let mut current = Vec::<u16>::new();
	let mut pending_ansi = SmallVec::<[u16; 32]>::new();
	let mut in_whitespace = false;
	let mut i = 0usize;

	while i < line.len() {
		if line[i] == ESC {
			if let Some(seq_len) = ansi_seq_len_u16(line, i) {
				pending_ansi.extend_from_slice(&line[i..i + seq_len]);
				i += seq_len;
				continue;
			}
		}

		let ch = line[i];
		let char_is_space = ch == b' ' as u16;
		if char_is_space != in_whitespace && !current.is_empty() {
			tokens.push(current);
			current = Vec::new();
		}

		if !pending_ansi.is_empty() {
			current.extend_from_slice(&pending_ansi);
			pending_ansi.clear();
		}

		in_whitespace = char_is_space;
		current.push(ch);
		i += 1;
	}

	if !pending_ansi.is_empty() {
		current.extend_from_slice(&pending_ansi);
	}

	if !current.is_empty() {
		tokens.push(current);
	}

	tokens
}

fn break_long_word(
	word: &[u16],
	width: usize,
	tab_width: usize,
	state: &mut AnsiState,
) -> SmallVec<[Vec<u16>; 4]> {
	let mut lines = SmallVec::<[Vec<u16>; 4]>::new();
	let mut current_line = Vec::<u16>::new();
	write_active_codes(state, &mut current_line);
	let mut current_width = 0usize;
	let mut i = 0usize;

	while i < word.len() {
		if word[i] == ESC {
			if let Some(seq_len) = ansi_seq_len_u16(word, i) {
				let seq = &word[i..i + seq_len];
				current_line.extend_from_slice(seq);
				if is_sgr_u16(seq) {
					state.apply_sgr_u16(&seq[2..seq_len - 1]);
				}
				i += seq_len;
				continue;
			}
		}

		let start = i;
		let mut is_ascii = true;
		while i < word.len() && word[i] != ESC {
			if word[i] > 0x7f {
				is_ascii = false;
			}
			i += 1;
		}
		let seg = &word[start..i];

		if is_ascii {
			for &u in seg {
				let gw = ascii_cell_width_u16(u, tab_width);
				if current_width + gw > width {
					write_line_end_reset(state, &mut current_line);
					lines.push(current_line);
					current_line = Vec::new();
					write_active_codes(state, &mut current_line);
					current_width = 0;
				}
				current_line.push(u);
				current_width += gw;
			}
		} else {
			let _ = for_each_grapheme_u16_slow(seg, tab_width, |gu16, gw| {
				if current_width + gw > width {
					write_line_end_reset(state, &mut current_line);
					lines.push(std::mem::take(&mut current_line));
					write_active_codes(state, &mut current_line);
					current_width = 0;
				}
				current_line.extend_from_slice(gu16);
				current_width += gw;
				true
			});
		}
	}

	if !current_line.is_empty() {
		lines.push(current_line);
	}

	lines
}

fn wrap_single_line(line: &[u16], width: usize, tab_width: usize) -> SmallVec<[Vec<u16>; 4]> {
	if line.is_empty() {
		return smallvec![Vec::new()];
	}

	if visible_width_u16(line, tab_width) <= width {
		return smallvec![line.to_vec()];
	}

	let tokens = split_into_tokens_with_ansi(line);
	let mut wrapped = SmallVec::<[Vec<u16>; 4]>::new();
	let mut current_line = Vec::<u16>::new();
	let mut current_width = 0usize;
	let mut state = AnsiState::new();

	for token in tokens {
		let token_width = visible_width_u16(&token, tab_width);
		let is_whitespace = token_is_whitespace(&token);

		if token_width > width && !is_whitespace {
			if !current_line.is_empty() {
				write_line_end_reset(&state, &mut current_line);
				wrapped.push(current_line);
				current_line = Vec::new();
				current_width = 0;
			}

			let mut broken = break_long_word(&token, width, tab_width, &mut state);
			if let Some(last) = broken.pop() {
				wrapped.extend(broken);
				current_line = last;
				current_width = visible_width_u16(&current_line, tab_width);
			}
			continue;
		}

		let total_needed = current_width + token_width;
		if total_needed > width && current_width > 0 {
			let mut line_to_wrap = current_line;
			trim_end_spaces_in_place(&mut line_to_wrap);
			write_line_end_reset(&state, &mut line_to_wrap);
			wrapped.push(line_to_wrap);

			current_line = Vec::new();
			write_active_codes(&state, &mut current_line);
			if is_whitespace {
				current_width = 0;
			} else {
				current_line.extend_from_slice(&token);
				current_width = token_width;
			}
		} else {
			current_line.extend_from_slice(&token);
			current_width += token_width;
		}

		update_state_from_text(&token, &mut state);
	}

	if !current_line.is_empty() {
		wrapped.push(current_line);
	}

	for line in &mut wrapped {
		trim_end_spaces_in_place(line);
	}

	if wrapped.is_empty() {
		wrapped.push(Vec::new());
	}

	wrapped
}

fn wrap_text_with_ansi_impl(
	text: &[u16],
	width: usize,
	tab_width: usize,
) -> SmallVec<[Vec<u16>; 4]> {
	if text.is_empty() {
		return smallvec![Vec::new()];
	}

	let mut result = SmallVec::<[Vec<u16>; 4]>::new();
	let mut state = AnsiState::new();
	let mut line_start = 0usize;

	for i in 0..=text.len() {
		if i == text.len() || text[i] == b'\n' as u16 {
			let line = &text[line_start..i];
			let mut line_with_prefix: Vec<u16> = Vec::new();
			if !result.is_empty() {
				write_active_codes(&state, &mut line_with_prefix);
			}
			line_with_prefix.extend_from_slice(line);

			let wrapped = wrap_single_line(&line_with_prefix, width, tab_width);
			result.extend(wrapped);
			update_state_from_text(line, &mut state);
			line_start = i + 1;
		}
	}

	if result.is_empty() {
		result.push(Vec::new());
	}

	result
}

/// Wrap text to a visible width, preserving ANSI escape codes across line
/// breaks.
///
/// Returns UTF-16 lines with active SGR codes carried across line boundaries.
#[napi(js_name = "wrapTextWithAnsi")]
pub fn wrap_text_with_ansi(
	text: JsString,
	width: u32,
	tab_width: Option<u32>,
) -> Result<Vec<String>> {
	let text_u16 = text.into_utf16()?;
	let tab_width = clamp_tab_width(tab_width);
	let lines = wrap_text_with_ansi_impl(text_u16.as_slice(), width as usize, tab_width);
	Ok(lines.into_iter().map(utf16_to_string).collect())
}

// ============================================================================
// truncateToWidth
// ============================================================================

/// Truncate text to a visible width, preserving ANSI codes.
///
/// `ellipsis_kind`: 0 = "\u{2026}", 1 = "...", 2 = "" (omit); pads with
/// spaces when requested.
#[napi(js_name = "truncateToWidth")]
pub fn truncate_to_width(
	text: JsString,
	max_width: u32,
	ellipsis_kind: u8,
	pad: bool,
	tab_width: Option<u32>,
) -> Result<String> {
	let max_width = max_width as usize;
	let tab_width = clamp_tab_width(tab_width);

	let text_u16 = text.into_utf16()?;
	let text = text_u16.as_slice();

	// Fast path: early-exit width check
	let (text_w, exceeded) = visible_width_u16_up_to(text, max_width, tab_width);
	if !exceeded {
		if !pad || text_w == max_width {
			return Ok(utf16_to_string(text.to_vec()));
		}

		let mut out = Vec::with_capacity(text.len() + (max_width - text_w));
		out.extend_from_slice(text);
		out.resize(out.len() + (max_width - text_w), b' ' as u16);
		return Ok(utf16_to_string(out));
	}

	const ELLIPSIS_UNICODE: &[u16] = &[0x2026];
	const ELLIPSIS_ASCII: &[u16] = &[0x2e, 0x2e, 0x2e];
	const ELLIPSIS_OMIT: &[u16] = &[];

	let (ellipsis, ellipsis_w): (&[u16], usize) = match ellipsis_kind {
		0 => (ELLIPSIS_UNICODE, 1),
		1 => (ELLIPSIS_ASCII, 3),
		2 => (ELLIPSIS_OMIT, 0),
		_ => (ELLIPSIS_UNICODE, 1),
	};

	let target_w = max_width.saturating_sub(ellipsis_w);

	if target_w == 0 {
		let mut out = Vec::with_capacity(ellipsis.len().min(max_width * 2));
		let mut w = 0usize;
		let _ = for_each_grapheme_u16_slow(ellipsis, tab_width, |gu16, gw| {
			if w + gw > max_width {
				return false;
			}
			out.extend_from_slice(gu16);
			w += gw;
			true
		});

		if pad && w < max_width {
			out.resize(out.len() + (max_width - w), b' ' as u16);
		}
		return Ok(utf16_to_string(out));
	}

	let mut out = Vec::with_capacity(text.len().min(max_width * 2) + ellipsis.len() + 8);
	let mut w = 0usize;
	let mut i = 0usize;
	let text_len = text.len();

	let mut saw_sgr = false;

	while i < text_len {
		if text[i] == ESC {
			if let Some(seq_len) = ansi_seq_len_u16(text, i) {
				let seq = &text[i..i + seq_len];
				out.extend_from_slice(seq);
				if is_sgr_u16(seq) {
					saw_sgr = true;
				}
				i += seq_len;
				continue;
			}
			out.push(ESC);
			i += 1;
			continue;
		}

		let start = i;
		let mut is_ascii = true;
		while i < text_len && text[i] != ESC {
			if text[i] > 0x7f {
				is_ascii = false;
			}
			i += 1;
		}
		let seg = &text[start..i];

		if is_ascii {
			for &u in seg {
				let gw = ascii_cell_width_u16(u, tab_width);
				if w + gw > target_w {
					break;
				}
				out.push(u);
				w += gw;
			}
			if w >= target_w {
				break;
			}
		} else {
			let keep_going = for_each_grapheme_u16_slow(seg, tab_width, |gu16, gw| {
				if w + gw > target_w {
					return false;
				}
				out.extend_from_slice(gu16);
				w += gw;
				true
			});
			if !keep_going {
				break;
			}
		}
	}

	if saw_sgr {
		out.extend_from_slice(&[ESC, b'[' as u16, b'0' as u16, b'm' as u16]);
	}
	out.extend_from_slice(ellipsis);

	if pad {
		let out_w = w + ellipsis_w;
		if out_w < max_width {
			out.resize(out.len() + (max_width - out_w), b' ' as u16);
		}
	}

	Ok(utf16_to_string(out))
}

// ============================================================================
// sliceWithWidth
// ============================================================================

fn slice_with_width_impl(
	line: &[u16],
	start_col: usize,
	length: usize,
	strict: bool,
	tab_width: usize,
) -> (Vec<u16>, usize) {
	let end_col = start_col.saturating_add(length);

	let mut out = Vec::with_capacity(length * 2);
	let mut out_w = 0usize;

	let mut current_col = 0usize;
	let mut i = 0usize;
	let line_len = line.len();

	let mut pending_ansi: SmallVec<[(usize, usize); 4]> = SmallVec::new();

	while i < line_len && current_col < end_col {
		if line[i] == ESC {
			if let Some(seq_len) = ansi_seq_len_u16(line, i) {
				if current_col >= start_col {
					out.extend_from_slice(&line[i..i + seq_len]);
				} else {
					pending_ansi.push((i, seq_len));
				}
				i += seq_len;
				continue;
			}
			if current_col >= start_col {
				out.push(ESC);
			}
			i += 1;
			continue;
		}

		let start = i;
		let mut is_ascii = true;
		while i < line_len && line[i] != ESC {
			if line[i] > 0x7f {
				is_ascii = false;
			}
			i += 1;
		}
		let seg = &line[start..i];

		if is_ascii {
			for &u in seg {
				if current_col >= end_col {
					break;
				}
				let gw = ascii_cell_width_u16(u, tab_width);
				let in_range = current_col >= start_col;
				let fits = !strict || current_col + gw <= end_col;

				if in_range && fits {
					if !pending_ansi.is_empty() {
						for &(p, l) in &pending_ansi {
							out.extend_from_slice(&line[p..p + l]);
						}
						pending_ansi.clear();
					}
					out.push(u);
					out_w += gw;
				}
				current_col += gw;
			}
		} else {
			let _ = for_each_grapheme_u16_slow(seg, tab_width, |gu16, gw| {
				if current_col >= end_col {
					return false;
				}

				let in_range = current_col >= start_col;
				let fits = !strict || current_col + gw <= end_col;

				if in_range && fits {
					if !pending_ansi.is_empty() {
						for &(p, l) in &pending_ansi {
							out.extend_from_slice(&line[p..p + l]);
						}
						pending_ansi.clear();
					}
					out.extend_from_slice(gu16);
					out_w += gw;
				}

				current_col += gw;
				current_col < end_col
			});
		}
	}

	// Include trailing ANSI sequences (e.g., reset codes) that immediately follow
	while i < line.len() {
		if line[i] == ESC {
			if let Some(len) = ansi_seq_len_u16(line, i) {
				out.extend_from_slice(&line[i..i + len]);
				i += len;
				continue;
			}
		}
		break;
	}

	(out, out_w)
}

/// Slice a range of visible columns from a line.
///
/// Counts terminal cells, skipping ANSI escapes, and optionally enforces strict
/// width.
#[napi(js_name = "sliceWithWidth")]
pub fn slice_with_width(
	line: JsString,
	start_col: u32,
	length: u32,
	strict: bool,
	tab_width: Option<u32>,
) -> Result<SliceResult> {
	let line_u16 = line.into_utf16()?;
	let line = line_u16.as_slice();

	let tab_width = clamp_tab_width(tab_width);
	let (out, w) =
		slice_with_width_impl(line, start_col as usize, length as usize, strict, tab_width);

	Ok(SliceResult { text: utf16_to_string(out), width: clamp_u32(w as u64) })
}

// ============================================================================
// extractSegments
// ============================================================================

fn extract_segments_impl(
	line: &[u16],
	before_end: usize,
	after_start: usize,
	after_len: usize,
	strict_after: bool,
	tab_width: usize,
) -> (Vec<u16>, usize, Vec<u16>, usize) {
	let after_end = after_start.saturating_add(after_len);

	let mut before = Vec::with_capacity(before_end * 2);
	let mut before_w = 0usize;

	let mut after = Vec::with_capacity(after_len * 2);
	let mut after_w = 0usize;

	let mut current_col = 0usize;
	let mut i = 0usize;
	let line_len = line.len();

	let mut pending_before_ansi: SmallVec<[(usize, usize); 4]> = SmallVec::new();

	let mut after_started = false;
	let mut state = AnsiState::new();

	let done_col = if after_len == 0 { before_end } else { after_end };

	while i < line_len && current_col < done_col {
		if line[i] == ESC {
			if let Some(seq_len) = ansi_seq_len_u16(line, i) {
				let seq = &line[i..i + seq_len];
				if is_sgr_u16(seq) {
					state.apply_sgr_u16(&seq[2..seq_len - 1]);
				}

				if current_col < before_end {
					pending_before_ansi.push((i, seq_len));
				} else if current_col >= after_start && current_col < after_end && after_started {
					after.extend_from_slice(seq);
				}

				i += seq_len;
				continue;
			}

			if current_col < before_end {
				before.push(ESC);
			} else if current_col >= after_start && current_col < after_end && after_started {
				after.push(ESC);
			}
			i += 1;
			continue;
		}

		let start = i;
		let mut is_ascii = true;
		while i < line_len && line[i] != ESC {
			if line[i] > 0x7f {
				is_ascii = false;
			}
			i += 1;
		}
		let seg = &line[start..i];

		if is_ascii {
			for &u in seg {
				if current_col >= done_col {
					break;
				}
				let gw = ascii_cell_width_u16(u, tab_width);

				if current_col < before_end {
					if !pending_before_ansi.is_empty() {
						for &(p, l) in &pending_before_ansi {
							before.extend_from_slice(&line[p..p + l]);
						}
						pending_before_ansi.clear();
					}
					before.push(u);
					before_w += gw;
				} else if current_col >= after_start && current_col < after_end {
					let fits = !strict_after || current_col + gw <= after_end;
					if fits {
						if !after_started {
							state.write_restore_u16(&mut after);
							after_started = true;
						}
						after.push(u);
						after_w += gw;
					}
				}
				current_col += gw;
			}
		} else {
			let _ = for_each_grapheme_u16_slow(seg, tab_width, |gu16, gw| {
				if current_col >= done_col {
					return false;
				}

				if current_col < before_end {
					if !pending_before_ansi.is_empty() {
						for &(p, l) in &pending_before_ansi {
							before.extend_from_slice(&line[p..p + l]);
						}
						pending_before_ansi.clear();
					}
					before.extend_from_slice(gu16);
					before_w += gw;
				} else if current_col >= after_start && current_col < after_end {
					let fits = !strict_after || current_col + gw <= after_end;
					if fits {
						if !after_started {
							state.write_restore_u16(&mut after);
							after_started = true;
						}
						after.extend_from_slice(gu16);
						after_w += gw;
					}
				}

				current_col += gw;
				true
			});
		}
	}

	(before, before_w, after, after_w)
}

/// Extract the before/after slices around an overlay region.
///
/// Preserves ANSI state so the `after` segment renders correctly after
/// truncation.
#[napi(js_name = "extractSegments")]
pub fn extract_segments(
	line: JsString,
	before_end: u32,
	after_start: u32,
	after_len: u32,
	strict_after: bool,
	tab_width: Option<u32>,
) -> Result<ExtractSegmentsResult> {
	let line_u16 = line.into_utf16()?;
	let line = line_u16.as_slice();

	let tab_width = clamp_tab_width(tab_width);
	let (before, bw, after, aw) = extract_segments_impl(
		line,
		before_end as usize,
		after_start as usize,
		after_len as usize,
		strict_after,
		tab_width,
	);

	Ok(ExtractSegmentsResult {
		before: utf16_to_string(before),
		before_width: clamp_u32(bw as u64),
		after: utf16_to_string(after),
		after_width: clamp_u32(aw as u64),
	})
}

// ============================================================================
// sanitizeText
// ============================================================================

/// Strip ANSI escape sequences, remove control characters / lone surrogates,
/// and normalize line endings.
#[napi(js_name = "sanitizeText")]
pub fn sanitize_text(text: JsString) -> Result<String> {
	let text_u16 = text.into_utf16()?;
	let data = text_u16.as_slice();

	let mut did_change = false;
	let mut out: Vec<u16> = Vec::new();
	let mut last = 0usize;
	let mut i = 0usize;
	let len = data.len();

	while i < len {
		let u = data[i];

		if u == 0x09 || u == 0x0a {
			i += 1;
			continue;
		}

		let mut remove_len = if u == ESC {
			ansi_seq_len_u16(data, i).unwrap_or(0)
		} else {
			0usize
		};

		if remove_len == 0 {
			if u == 0x0d {
				remove_len = 1;
			} else if u <= 0x1f || u == 0x7f || (0x80..=0x9f).contains(&u) {
				remove_len = 1;
			} else if (0xd800..=0xdbff).contains(&u) {
				if i + 1 < len {
					let lo = data[i + 1];
					if (0xdc00..=0xdfff).contains(&lo) {
						i += 2;
						continue;
					}
				}
				remove_len = 1;
			} else if (0xdc00..=0xdfff).contains(&u) {
				remove_len = 1;
			}
		}

		if remove_len == 0 {
			i += 1;
			continue;
		}

		if !did_change {
			did_change = true;
			out = Vec::with_capacity(len);
		}
		if last != i {
			out.extend_from_slice(&data[last..i]);
		}
		i += remove_len;
		last = i;
	}

	if !did_change {
		return Ok(utf16_to_string(data.to_vec()));
	}
	if last < len {
		out.extend_from_slice(&data[last..]);
	}
	Ok(utf16_to_string(out))
}

// ============================================================================
// visibleWidth
// ============================================================================

/// Calculate visible width of text, excluding ANSI escape sequences.
///
/// Tabs count as a fixed-width cell.
#[napi(js_name = "visibleWidth")]
pub fn visible_width_napi(text: JsString, tab_width: Option<u32>) -> Result<u32> {
	let text_u16 = text.into_utf16()?;
	let tab_width = clamp_tab_width(tab_width);
	Ok(clamp_u32(visible_width_u16(text_u16.as_slice(), tab_width) as u64))
}

#[cfg(test)]
mod tests {
	use super::*;

	fn to_u16(s: &str) -> Vec<u16> {
		s.encode_utf16().collect()
	}

	#[test]
	fn test_visible_width() {
		assert_eq!(visible_width_u16(&to_u16("hello"), DEFAULT_TAB_WIDTH), 5);
		assert_eq!(
			visible_width_u16(&to_u16("\x1b[31mhello\x1b[0m"), DEFAULT_TAB_WIDTH),
			5
		);
		assert_eq!(
			visible_width_u16(&to_u16("\x1b[38;5;196mred\x1b[0m"), DEFAULT_TAB_WIDTH),
			3
		);
		assert_eq!(
			visible_width_u16(&to_u16("a\tb"), DEFAULT_TAB_WIDTH),
			1 + DEFAULT_TAB_WIDTH + 1
		);
	}

	#[test]
	fn test_visible_width_cjk() {
		assert_eq!(
			visible_width_u16(&to_u16("\u{4e16}\u{754c}"), DEFAULT_TAB_WIDTH),
			4
		);
		assert_eq!(visible_width_u16(&to_u16("a\u{4e16}b"), DEFAULT_TAB_WIDTH), 4);
	}

	#[test]
	fn test_visible_width_emoji() {
		assert_eq!(visible_width_u16(&to_u16("\u{1f600}"), DEFAULT_TAB_WIDTH), 2);
	}

	#[test]
	fn test_ansi_detection() {
		let data = to_u16("\x1b[31mred\x1b[0m");
		assert_eq!(ansi_seq_len_u16(&data, 0), Some(5));
		assert_eq!(ansi_seq_len_u16(&data, 8), Some(4));
	}

	#[test]
	fn test_ansi_detection_osc() {
		let data = to_u16("\x1b]0;title\x07rest");
		assert_eq!(ansi_seq_len_u16(&data, 0), Some(10));
	}

	#[test]
	fn test_slice_basic() {
		let data = to_u16("hello world");
		let (out, width) = slice_with_width_impl(&data, 0, 5, false, DEFAULT_TAB_WIDTH);
		assert_eq!(String::from_utf16_lossy(&out), "hello");
		assert_eq!(width, 5);
	}

	#[test]
	fn test_slice_middle() {
		let data = to_u16("hello world");
		let (out, width) = slice_with_width_impl(&data, 6, 5, false, DEFAULT_TAB_WIDTH);
		assert_eq!(String::from_utf16_lossy(&out), "world");
		assert_eq!(width, 5);
	}

	#[test]
	fn test_slice_with_ansi() {
		let data = to_u16("\x1b[31mhello\x1b[0m world");
		let (out, width) = slice_with_width_impl(&data, 0, 5, false, DEFAULT_TAB_WIDTH);
		assert_eq!(String::from_utf16_lossy(&out), "\x1b[31mhello\x1b[0m");
		assert_eq!(width, 5);
	}

	#[test]
	fn test_early_exit() {
		let data = to_u16(&"a]b".repeat(1000));
		let (w, exceeded) = visible_width_u16_up_to(&data, 10, DEFAULT_TAB_WIDTH);
		assert!(exceeded);
		assert!(w > 10);
	}

	#[test]
	fn test_wrap_text_basic() {
		let data = to_u16("hello world");
		let lines = wrap_text_with_ansi_impl(&data, 5, DEFAULT_TAB_WIDTH);
		assert_eq!(lines.len(), 2);
		assert_eq!(String::from_utf16_lossy(&lines[0]), "hello");
		assert_eq!(String::from_utf16_lossy(&lines[1]), "world");
	}

	#[test]
	fn test_wrap_text_with_ansi_preserves_color() {
		let data = to_u16("\x1b[38;2;156;163;176mhello world\x1b[0m");
		let lines = wrap_text_with_ansi_impl(&data, 5, DEFAULT_TAB_WIDTH);
		assert_eq!(lines.len(), 2);
		let first = String::from_utf16_lossy(&lines[0]);
		let second = String::from_utf16_lossy(&lines[1]);
		assert!(first.starts_with("\x1b[38;2;156;163;176m"));
		assert!(second.starts_with("\x1b[38;2;156;163;176m"));
		assert!(second.contains("world"));
	}

	#[test]
	fn test_wrap_text_with_ansi_resets_strike() {
		let data = to_u16(
			"\x1b[38;5;196m\x1b[48;5;236m\x1b[9mstrikethrough content wraps\x1b[29m\x1b[0m",
		);
		let lines = wrap_text_with_ansi_impl(&data, 12, DEFAULT_TAB_WIDTH);
		assert!(lines.len() > 1);

		for line in &lines[..lines.len() - 1] {
			let line_text = String::from_utf16_lossy(line);
			if line_text.contains("\x1b[9m") {
				assert!(line_text.ends_with("\x1b[29m"));
				assert!(!line_text.ends_with("\x1b[0m"));
			}
		}

		for line in &lines[1..] {
			let line_text = String::from_utf16_lossy(line);
			assert!(line_text.contains("38;5;196"));
			assert!(line_text.contains("48;5;236"));
		}
	}

	#[test]
	fn test_wrap_text_multiline() {
		let data = to_u16("line one\nline two");
		let lines = wrap_text_with_ansi_impl(&data, 20, DEFAULT_TAB_WIDTH);
		assert_eq!(lines.len(), 2);
		assert_eq!(String::from_utf16_lossy(&lines[0]), "line one");
		assert_eq!(String::from_utf16_lossy(&lines[1]), "line two");
	}

	#[test]
	fn test_wrap_text_empty() {
		let data = to_u16("");
		let lines = wrap_text_with_ansi_impl(&data, 10, DEFAULT_TAB_WIDTH);
		assert_eq!(lines.len(), 1);
		assert!(lines[0].is_empty());
	}

	#[test]
	fn test_extract_segments_basic() {
		let data = to_u16("hello world test");
		let (before, bw, after, aw) =
			extract_segments_impl(&data, 5, 6, 5, false, DEFAULT_TAB_WIDTH);
		assert_eq!(String::from_utf16_lossy(&before), "hello");
		assert_eq!(bw, 5);
		assert_eq!(String::from_utf16_lossy(&after), "world");
		assert_eq!(aw, 5);
	}

	#[test]
	fn test_ansi_state_sgr_parsing() {
		let mut state = AnsiState::new();
		let params = to_u16("1;31");
		state.apply_sgr_u16(&params);
		assert!(state.attrs & ATTR_BOLD != 0);
		assert_eq!(state.fg, 2); // 31 - 29 = 2

		let params = to_u16("0");
		state.apply_sgr_u16(&params);
		assert!(state.is_empty());
	}

	#[test]
	fn test_ansi_state_256_color() {
		let mut state = AnsiState::new();
		let params = to_u16("38;5;196");
		state.apply_sgr_u16(&params);
		assert_eq!(state.fg, 0x100 | 196);
	}

	#[test]
	fn test_ansi_state_rgb_color() {
		let mut state = AnsiState::new();
		let params = to_u16("38;2;255;128;0");
		state.apply_sgr_u16(&params);
		assert_eq!(state.fg, 0x1000000 | (255 << 16) | (128 << 8) | 0);
	}

	#[test]
	fn test_clamp_u32_helper() {
		assert_eq!(clamp_u32(0), 0);
		assert_eq!(clamp_u32(42), 42);
		assert_eq!(clamp_u32(u32::MAX as u64), u32::MAX);
		assert_eq!(clamp_u32(u32::MAX as u64 + 1), u32::MAX);
	}
}
