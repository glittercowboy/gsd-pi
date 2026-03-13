//! Bash stream processor: single-pass UTF-8 decode + ANSI strip + binary sanitization.
//!
//! Designed for streaming bash output where chunks may split UTF-8 sequences
//! or ANSI escape sequences at arbitrary boundaries.
//!
//! Exposed functions:
//! - `processStreamChunk(chunk, state?)` — stateful single-pass processing
//! - `stripAnsiNative(text)` — standalone ANSI stripping
//! - `sanitizeBinaryOutputNative(text)` — standalone binary/control char removal

use napi::bindgen_prelude::*;
use napi_derive::napi;

// ============================================================================
// StreamState — tracks incomplete sequences across chunk boundaries
// ============================================================================

/// Opaque state carried between consecutive `processStreamChunk` calls.
///
/// Tracks:
/// - Incomplete UTF-8 byte sequences at chunk boundaries
/// - Incomplete ANSI escape sequences at chunk boundaries
#[napi(object)]
#[derive(Clone, Default)]
pub struct StreamState {
    /// Leftover bytes from an incomplete UTF-8 sequence (max 3 bytes).
    pub utf8_pending: Vec<u8>,
    /// Leftover bytes from a potentially incomplete ANSI escape sequence.
    pub ansi_pending: Vec<u8>,
}

// ============================================================================
// processStreamChunk — the main hot-path function
// ============================================================================

#[napi(object)]
pub struct StreamChunkResult {
    /// Processed text: UTF-8 decoded, ANSI stripped, binary sanitized, CR removed.
    pub text: String,
    /// Updated state to pass to the next call.
    pub state: StreamState,
}

/// Process a raw bash output chunk in a single pass.
///
/// Decodes UTF-8 (handling incomplete multibyte sequences at boundaries),
/// strips ANSI escape sequences, removes control characters (except tab and
/// newline), removes carriage returns, and filters Unicode format characters.
#[napi(js_name = "processStreamChunk")]
pub fn process_stream_chunk(
    chunk: Buffer,
    state: Option<StreamState>,
) -> StreamChunkResult {
    let state = state.unwrap_or_default();
    let bytes = chunk.as_ref();

    // Prepend any pending bytes from previous chunk
    let mut input: Vec<u8>;
    let src: &[u8] = if !state.utf8_pending.is_empty() || !state.ansi_pending.is_empty() {
        input = Vec::with_capacity(
            state.ansi_pending.len() + state.utf8_pending.len() + bytes.len(),
        );
        input.extend_from_slice(&state.ansi_pending);
        input.extend_from_slice(&state.utf8_pending);
        input.extend_from_slice(bytes);
        &input
    } else {
        bytes
    };

    // Decode UTF-8, saving any trailing incomplete sequence
    let (text_full, utf8_leftover) = decode_utf8_streaming(src);

    // Strip ANSI and sanitize in a single pass, tracking incomplete ANSI at end
    let (result_text, ansi_leftover) = strip_ansi_and_sanitize_streaming(&text_full);

    StreamChunkResult {
        text: result_text,
        state: StreamState {
            utf8_pending: utf8_leftover,
            ansi_pending: ansi_leftover.into_bytes(),
        },
    }
}

// ============================================================================
// Standalone functions
// ============================================================================

/// Strip ANSI escape sequences from a string.
#[napi(js_name = "stripAnsiNative")]
pub fn strip_ansi_native(text: String) -> String {
    strip_ansi(&text)
}

/// Remove binary garbage and control characters from a string.
///
/// Keeps tab (0x09) and newline (0x0A). Removes carriage return, all other
/// control characters (0x00-0x1F, 0x7F, 0x80-0x9F), Unicode format characters
/// (0xFFF9-0xFFFB), and lone surrogates.
#[napi(js_name = "sanitizeBinaryOutputNative")]
pub fn sanitize_binary_output_native(text: String) -> String {
    sanitize_binary(&text)
}

// ============================================================================
// Internal: UTF-8 streaming decode
// ============================================================================

/// Decode UTF-8 bytes, returning decoded text and any trailing incomplete
/// multibyte sequence.
fn decode_utf8_streaming(bytes: &[u8]) -> (String, Vec<u8>) {
    if bytes.is_empty() {
        return (String::new(), Vec::new());
    }

    // Find how many trailing bytes might be part of an incomplete sequence.
    // A UTF-8 leading byte tells us the expected sequence length.
    let trailing = find_incomplete_utf8_tail(bytes);

    let (decodable, leftover) = bytes.split_at(bytes.len() - trailing);

    let text = String::from_utf8_lossy(decodable).into_owned();
    (text, leftover.to_vec())
}

/// Returns the number of trailing bytes that form an incomplete UTF-8 sequence.
fn find_incomplete_utf8_tail(bytes: &[u8]) -> usize {
    if bytes.is_empty() {
        return 0;
    }

    // Walk backwards from the end to find a potential leading byte
    // that starts an incomplete sequence.
    let len = bytes.len();
    // Check at most the last 3 bytes (max UTF-8 continuation trail)
    let check_start = if len > 3 { len - 3 } else { 0 };

    for i in (check_start..len).rev() {
        let b = bytes[i];
        if b < 0x80 {
            // ASCII — everything before and including this is complete
            return 0;
        }
        if b >= 0xC0 {
            // This is a leading byte. How many bytes does the sequence need?
            let expected = if b < 0xE0 {
                2
            } else if b < 0xF0 {
                3
            } else {
                4
            };
            let available = len - i;
            if available < expected {
                return available; // incomplete
            }
            return 0; // complete
        }
        // 0x80..0xBF = continuation byte, keep scanning backwards
    }

    // All trailing bytes are continuation bytes with no leading byte found
    // in the last 3 — treat them as incomplete
    len - check_start
}

// ============================================================================
// Internal: ANSI stripping (standalone, for already-decoded strings)
// ============================================================================

fn strip_ansi(text: &str) -> String {
    let bytes = text.as_bytes();
    let len = bytes.len();
    let mut out = String::with_capacity(len);
    let mut i = 0;

    while i < len {
        if bytes[i] == 0x1B {
            if let Some(seq_len) = ansi_sequence_len(bytes, i) {
                i += seq_len;
                continue;
            }
            // Lone ESC — skip it
            i += 1;
            continue;
        }
        // Safe because we're walking byte-by-byte and only branching on ASCII ESC
        // For non-ASCII, we need to handle full chars
        let ch = if bytes[i] < 0x80 {
            i += 1;
            bytes[i - 1] as char
        } else {
            let s = &text[i..];
            let c = s.chars().next().unwrap();
            i += c.len_utf8();
            c
        };
        out.push(ch);
    }
    out
}

// ============================================================================
// Internal: binary sanitization (standalone, for already-decoded strings)
// ============================================================================

fn sanitize_binary(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if should_keep_char(c) {
            out.push(c);
        }
    }
    out
}

#[inline]
fn should_keep_char(c: char) -> bool {
    let code = c as u32;

    // Allow tab and newline
    if code == 0x09 || code == 0x0A {
        return true;
    }

    // Remove CR
    if code == 0x0D {
        return false;
    }

    // Remove C0 control characters (0x00-0x1F)
    if code <= 0x1F {
        return false;
    }

    // Remove DEL
    if code == 0x7F {
        return false;
    }

    // Remove C1 control characters (0x80-0x9F)
    if (0x80..=0x9F).contains(&code) {
        return false;
    }

    // Remove Unicode format characters that crash string-width
    if (0xFFF9..=0xFFFB).contains(&code) {
        return false;
    }

    true
}

// ============================================================================
// Internal: combined ANSI strip + sanitize for streaming (single pass)
// ============================================================================

/// Strip ANSI sequences and sanitize in one pass over a decoded string.
///
/// Returns the cleaned text and any trailing string that might be an
/// incomplete ANSI escape sequence (to be prepended to the next chunk's
/// raw bytes before UTF-8 decoding).
fn strip_ansi_and_sanitize_streaming(text: &str) -> (String, String) {
    let bytes = text.as_bytes();
    let len = bytes.len();
    let mut out = String::with_capacity(len);
    let mut i = 0;

    while i < len {
        if bytes[i] == 0x1B {
            // Check if this might be an incomplete ANSI sequence at the end
            match ansi_sequence_len(bytes, i) {
                Some(seq_len) => {
                    i += seq_len;
                    continue;
                }
                None => {
                    // Could be incomplete at chunk boundary — check if we're
                    // near the end of the buffer
                    if could_be_incomplete_ansi(bytes, i) {
                        // Save the rest as pending
                        let leftover = text[i..].to_string();
                        return (out, leftover);
                    }
                    // Lone ESC not at boundary — skip it
                    i += 1;
                    continue;
                }
            }
        }

        // Handle full characters
        if bytes[i] < 0x80 {
            let c = bytes[i] as char;
            if should_keep_char(c) {
                out.push(c);
            }
            i += 1;
        } else {
            let s = &text[i..];
            let c = s.chars().next().unwrap();
            if should_keep_char(c) {
                out.push(c);
            }
            i += c.len_utf8();
        }
    }

    (out, String::new())
}

/// Check if bytes[pos..] could be the start of an incomplete ANSI sequence
/// that was cut off at the chunk boundary.
fn could_be_incomplete_ansi(bytes: &[u8], pos: usize) -> bool {
    let remaining = bytes.len() - pos;

    // ESC alone at end
    if remaining == 1 {
        return true;
    }

    let next = bytes[pos + 1];

    match next {
        // CSI: ESC [ ... <final byte 0x40-0x7E>
        b'[' => {
            // If we don't see a final byte, it's incomplete
            for j in (pos + 2)..bytes.len() {
                if (0x40..=0x7E).contains(&bytes[j]) {
                    return false; // found terminator — it's complete (but malformed since ansi_sequence_len returned None)
                }
            }
            true // no terminator found — incomplete
        }
        // OSC: ESC ] ... (terminated by BEL or ST)
        b']' => {
            for j in (pos + 2)..bytes.len() {
                if bytes[j] == 0x07 {
                    return false;
                }
                if bytes[j] == 0x1B && j + 1 < bytes.len() && bytes[j + 1] == b'\\' {
                    return false;
                }
            }
            true
        }
        // DCS, SOS, PM, APC
        b'P' | b'X' | b'^' | b'_' => {
            for j in (pos + 2)..bytes.len() {
                if bytes[j] == 0x1B && j + 1 < bytes.len() && bytes[j + 1] == b'\\' {
                    return false;
                }
            }
            true
        }
        // Two-byte sequences ESC + 0x40-0x7E — these are always complete
        0x40..=0x7E => false,
        // Intermediate bytes (ESC + intermediate + final)
        0x20..=0x2F => {
            for j in (pos + 2)..bytes.len() {
                if (0x30..=0x7E).contains(&bytes[j]) {
                    return false;
                }
            }
            true
        }
        _ => false,
    }
}

/// Returns the length of a complete ANSI escape sequence starting at `pos`,
/// or `None` if no complete sequence is found.
fn ansi_sequence_len(bytes: &[u8], pos: usize) -> Option<usize> {
    let len = bytes.len();
    if pos >= len || bytes[pos] != 0x1B {
        return None;
    }
    if pos + 1 >= len {
        return None;
    }

    match bytes[pos + 1] {
        // CSI: ESC [
        b'[' => {
            for j in (pos + 2)..len {
                if (0x40..=0x7E).contains(&bytes[j]) {
                    return Some(j - pos + 1);
                }
            }
            None
        }
        // OSC: ESC ]
        b']' => {
            for j in (pos + 2)..len {
                if bytes[j] == 0x07 {
                    return Some(j - pos + 1);
                }
                if bytes[j] == 0x1B && j + 1 < len && bytes[j + 1] == b'\\' {
                    return Some(j - pos + 2);
                }
            }
            None
        }
        // DCS, SOS, PM, APC — terminated by ST (ESC \)
        b'P' | b'X' | b'^' | b'_' => {
            for j in (pos + 2)..len {
                if bytes[j] == 0x1B && j + 1 < len && bytes[j + 1] == b'\\' {
                    return Some(j - pos + 2);
                }
            }
            None
        }
        // ESC + intermediates (0x20-0x2F) + final byte (0x30-0x7E)
        0x20..=0x2F => {
            for j in (pos + 2)..len {
                if (0x30..=0x7E).contains(&bytes[j]) {
                    return Some(j - pos + 1);
                }
            }
            None
        }
        // Two-byte ESC sequences: ESC + final (0x40-0x7E)
        0x40..=0x7E => Some(2),
        _ => None,
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pure_ascii() {
        let result = process_chunk(b"hello world", None);
        assert_eq!(result.text, "hello world");
        assert!(result.state.utf8_pending.is_empty());
        assert!(result.state.ansi_pending.is_empty());
    }

    #[test]
    fn test_strip_ansi_codes() {
        let input = b"\x1b[31mred text\x1b[0m normal";
        let result = process_chunk(input, None);
        assert_eq!(result.text, "red text normal");
    }

    #[test]
    fn test_strip_ansi_256_color() {
        let input = b"\x1b[38;5;196mcolored\x1b[0m";
        let result = process_chunk(input, None);
        assert_eq!(result.text, "colored");
    }

    #[test]
    fn test_strip_ansi_rgb() {
        let input = b"\x1b[38;2;255;128;0mrgb\x1b[0m";
        let result = process_chunk(input, None);
        assert_eq!(result.text, "rgb");
    }

    #[test]
    fn test_osc_sequence() {
        let input = b"\x1b]0;window title\x07rest";
        let result = process_chunk(input, None);
        assert_eq!(result.text, "rest");
    }

    #[test]
    fn test_cr_removal() {
        let input = b"line1\r\nline2\r\n";
        let result = process_chunk(input, None);
        assert_eq!(result.text, "line1\nline2\n");
    }

    #[test]
    fn test_control_char_removal() {
        let input = b"hello\x00\x01\x02world";
        let result = process_chunk(input, None);
        assert_eq!(result.text, "helloworld");
    }

    #[test]
    fn test_tab_preserved() {
        let input = b"col1\tcol2";
        let result = process_chunk(input, None);
        assert_eq!(result.text, "col1\tcol2");
    }

    #[test]
    fn test_newline_preserved() {
        let input = b"line1\nline2\n";
        let result = process_chunk(input, None);
        assert_eq!(result.text, "line1\nline2\n");
    }

    #[test]
    fn test_utf8_multibyte_complete() {
        // "Hello, 世界!" in UTF-8
        let input = "Hello, 世界!".as_bytes();
        let result = process_chunk(input, None);
        assert_eq!(result.text, "Hello, 世界!");
    }

    #[test]
    fn test_utf8_split_across_chunks() {
        // "世" is 0xE4 0xB8 0x96 in UTF-8
        let full = "世界".as_bytes(); // 6 bytes total
        assert_eq!(full.len(), 6);

        // Split after first byte of "世"
        let chunk1 = &full[..1]; // 0xE4
        let chunk2 = &full[1..]; // 0xB8 0x96 0xE7 0x95 0x8C

        let r1 = process_chunk(chunk1, None);
        assert_eq!(r1.text, "");
        assert_eq!(r1.state.utf8_pending, vec![0xE4]);

        let r2 = process_chunk(chunk2, Some(r1.state));
        assert_eq!(r2.text, "世界");
        assert!(r2.state.utf8_pending.is_empty());
    }

    #[test]
    fn test_utf8_split_two_byte() {
        // "é" is 0xC3 0xA9
        let full = "café".as_bytes();

        // Split in the middle of "é"
        let split_pos = full.len() - 1; // last byte is 0xA9
        let chunk1 = &full[..split_pos];
        let chunk2 = &full[split_pos..];

        let r1 = process_chunk(chunk1, None);
        assert_eq!(r1.text, "caf");
        assert_eq!(r1.state.utf8_pending.len(), 1);

        let r2 = process_chunk(chunk2, Some(r1.state));
        assert_eq!(r2.text, "é");
    }

    #[test]
    fn test_utf8_split_four_byte() {
        // Emoji 😀 is F0 9F 98 80
        let full = "😀".as_bytes();
        assert_eq!(full.len(), 4);

        // Split after 2 bytes
        let chunk1 = &full[..2];
        let chunk2 = &full[2..];

        let r1 = process_chunk(chunk1, None);
        assert_eq!(r1.text, "");
        assert_eq!(r1.state.utf8_pending.len(), 2);

        let r2 = process_chunk(chunk2, Some(r1.state));
        assert_eq!(r2.text, "😀");
    }

    #[test]
    fn test_ansi_split_across_chunks() {
        // ESC [ 3 1 m split: ESC [ in chunk1, 3 1 m in chunk2
        let chunk1 = b"\x1b[";
        let chunk2 = b"31mred\x1b[0m";

        let r1 = process_chunk(chunk1, None);
        assert_eq!(r1.text, "");
        assert!(!r1.state.ansi_pending.is_empty());

        let r2 = process_chunk(chunk2, Some(r1.state));
        assert_eq!(r2.text, "red");
    }

    #[test]
    fn test_ansi_esc_alone_at_boundary() {
        let chunk1 = b"text\x1b";
        let chunk2 = b"[32mgreen\x1b[0m";

        let r1 = process_chunk(chunk1, None);
        assert_eq!(r1.text, "text");
        assert!(!r1.state.ansi_pending.is_empty());

        let r2 = process_chunk(chunk2, Some(r1.state));
        assert_eq!(r2.text, "green");
    }

    #[test]
    fn test_mixed_content() {
        let input = b"\x1b[1mbold\x1b[0m \x00normal\r\n";
        let result = process_chunk(input, None);
        assert_eq!(result.text, "bold normal\n");
    }

    #[test]
    fn test_binary_garbage() {
        let mut input = Vec::new();
        input.extend_from_slice(b"start ");
        // Add some random high bytes that aren't valid UTF-8
        input.extend_from_slice(&[0xFF, 0xFE, 0x80]);
        input.extend_from_slice(b" end");
        let result = process_chunk(&input, None);
        // from_utf8_lossy replaces invalid bytes with U+FFFD, but should_keep_char keeps them
        // (they're > 0x9F and not format chars)
        assert!(result.text.contains("start"));
        assert!(result.text.contains("end"));
    }

    #[test]
    fn test_unicode_format_chars_removed() {
        // U+FFF9 (INTERLINEAR ANNOTATION ANCHOR)
        let input = format!("before\u{FFF9}after");
        let result = sanitize_binary(&input);
        assert_eq!(result, "beforeafter");
    }

    #[test]
    fn test_standalone_strip_ansi() {
        assert_eq!(strip_ansi("\x1b[31mhello\x1b[0m"), "hello");
        assert_eq!(strip_ansi("no ansi here"), "no ansi here");
        assert_eq!(strip_ansi("\x1b[1m\x1b[31mbold red\x1b[0m"), "bold red");
    }

    #[test]
    fn test_standalone_sanitize_binary() {
        assert_eq!(sanitize_binary("hello\x00world"), "helloworld");
        assert_eq!(sanitize_binary("tab\there"), "tab\there");
        assert_eq!(sanitize_binary("line\nbreak"), "line\nbreak");
        assert_eq!(sanitize_binary("cr\r\nlf"), "cr\nlf");
    }

    #[test]
    fn test_empty_input() {
        let result = process_chunk(b"", None);
        assert_eq!(result.text, "");
        assert!(result.state.utf8_pending.is_empty());
    }

    #[test]
    fn test_three_chunk_utf8_split() {
        // 4-byte emoji split across 3 chunks
        let full = "😀".as_bytes();
        let c1 = &full[..1];
        let c2 = &full[1..3];
        let c3 = &full[3..];

        let r1 = process_chunk(c1, None);
        assert_eq!(r1.text, "");

        let r2 = process_chunk(c2, Some(r1.state));
        assert_eq!(r2.text, "");

        let r3 = process_chunk(c3, Some(r2.state));
        assert_eq!(r3.text, "😀");
    }

    // Helper to avoid napi Buffer in tests
    fn process_chunk(bytes: &[u8], state: Option<StreamState>) -> StreamChunkResult {
        let state = state.unwrap_or_default();

        let mut input: Vec<u8> = Vec::with_capacity(
            state.ansi_pending.len() + state.utf8_pending.len() + bytes.len(),
        );
        input.extend_from_slice(&state.ansi_pending);
        input.extend_from_slice(&state.utf8_pending);
        input.extend_from_slice(bytes);

        let (text_full, utf8_leftover) = decode_utf8_streaming(&input);
        let (result_text, ansi_leftover) = strip_ansi_and_sanitize_streaming(&text_full);

        StreamChunkResult {
            text: result_text,
            state: StreamState {
                utf8_pending: utf8_leftover,
                ansi_pending: ansi_leftover.into_bytes(),
            },
        }
    }
}
