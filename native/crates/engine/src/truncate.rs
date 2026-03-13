//! Line-boundary-aware output truncation.
//!
//! Truncates tool output (bash, grep, file reads) at line boundaries,
//! counting by UTF-8 bytes. Three modes:
//! - **head**: keep the first N bytes worth of complete lines
//! - **tail**: keep the last N bytes worth of complete lines
//! - **both**: split budget between head and tail with an elision marker

use napi_derive::napi;

#[napi(object)]
pub struct TruncateResult {
    /// The truncated (or original) text.
    pub text: String,
    /// Whether any truncation occurred.
    pub truncated: bool,
    /// Total number of lines in the original input.
    pub original_lines: u32,
    /// Number of complete lines kept in the output.
    pub kept_lines: u32,
}

#[napi(object)]
pub struct TruncateOutputResult {
    /// The truncated (or original) text.
    pub text: String,
    /// Whether any truncation occurred.
    pub truncated: bool,
    /// Human-readable truncation summary (e.g. "Kept 50 of 1200 lines").
    pub message: Option<String>,
}

/// Keep the first `max_bytes` worth of complete lines.
///
/// Returns the original text unchanged when it fits. When truncation is
/// required, the output ends at the last newline boundary that fits within
/// the byte budget. UTF-8 boundaries are respected because we split on `\n`
/// which is always a single byte.
#[napi(js_name = "truncateTail")]
pub fn truncate_tail(text: String, max_bytes: u32) -> TruncateResult {
    let max = max_bytes as usize;
    let total_bytes = text.len();

    // Fast path: fits entirely
    if total_bytes <= max {
        let line_count = memchr::memchr_iter(b'\n', text.as_bytes()).count()
            + if text.is_empty() || text.ends_with('\n') { 0 } else { 1 };
        return TruncateResult {
            text,
            truncated: false,
            original_lines: line_count as u32,
            kept_lines: line_count as u32,
        };
    }

    let bytes = text.as_bytes();
    let original_lines = count_lines(bytes);

    // Find the last newline at or before max_bytes
    let cut = find_last_newline_before(bytes, max);

    if cut == 0 {
        // First line alone exceeds the budget — keep nothing
        return TruncateResult {
            text: String::new(),
            truncated: true,
            original_lines,
            kept_lines: 0,
        };
    }

    let kept = &bytes[..cut];
    let kept_lines = count_lines(kept);

    TruncateResult {
        text: std::str::from_utf8(kept).expect("split at newline boundary preserves UTF-8").to_owned(),
        truncated: true,
        original_lines,
        kept_lines,
    }
}

/// Keep the last `max_bytes` worth of complete lines.
///
/// The output starts at the first line boundary after skipping enough bytes
/// from the front. UTF-8 boundaries are respected because we only split on
/// `\n`.
#[napi(js_name = "truncateHead")]
pub fn truncate_head(text: String, max_bytes: u32) -> TruncateResult {
    let max = max_bytes as usize;
    let total_bytes = text.len();

    // Fast path
    if total_bytes <= max {
        let line_count = memchr::memchr_iter(b'\n', text.as_bytes()).count()
            + if text.is_empty() || text.ends_with('\n') { 0 } else { 1 };
        return TruncateResult {
            text,
            truncated: false,
            original_lines: line_count as u32,
            kept_lines: line_count as u32,
        };
    }

    let bytes = text.as_bytes();
    let original_lines = count_lines(bytes);

    // We need to keep the last `max` bytes. Find the first newline at or
    // after (total_bytes - max) so we start on a line boundary.
    let skip_to = total_bytes - max;
    let start = find_first_newline_after(bytes, skip_to);

    if start >= total_bytes {
        // Last line alone exceeds the budget — keep nothing
        return TruncateResult {
            text: String::new(),
            truncated: true,
            original_lines,
            kept_lines: 0,
        };
    }

    let kept = &bytes[start..];
    let kept_lines = count_lines(kept);

    TruncateResult {
        text: std::str::from_utf8(kept).expect("split at newline boundary preserves UTF-8").to_owned(),
        truncated: true,
        original_lines,
        kept_lines,
    }
}

/// Main entry point: truncate tool output with head/tail/both modes.
///
/// Modes:
/// - `"tail"` (default): keep the beginning (head truncation removes tail)
/// - `"head"`: keep the end (tail truncation removes head)
/// - `"both"`: keep beginning and end, elide the middle
#[napi(js_name = "truncateOutput")]
pub fn truncate_output(
    text: String,
    max_bytes: u32,
    mode: Option<String>,
) -> TruncateOutputResult {
    let max = max_bytes as usize;

    if text.len() <= max {
        return TruncateOutputResult {
            text,
            truncated: false,
            message: None,
        };
    }

    let mode_str = mode.as_deref().unwrap_or("tail");
    let original_lines = count_lines(text.as_bytes());

    match mode_str {
        "head" => {
            let total_bytes = text.len();
            let r = truncate_head(text, max_bytes);
            let removed = total_bytes - r.text.len();
            let msg = format!(
                "Kept last {} of {} lines ({} bytes truncated from start)",
                r.kept_lines, r.original_lines, removed
            );
            TruncateOutputResult {
                text: r.text,
                truncated: true,
                message: Some(msg),
            }
        }
        "both" => {
            let half = max / 2;
            let head_result = truncate_tail(text.clone(), half as u32);
            let tail_result = truncate_head(text, (max - half) as u32);

            let marker = format!(
                "\n\n... [{} lines elided] ...\n\n",
                original_lines
                    .saturating_sub(head_result.kept_lines)
                    .saturating_sub(tail_result.kept_lines)
            );
            let combined = format!("{}{}{}", head_result.text, marker, tail_result.text);
            let kept = head_result.kept_lines + tail_result.kept_lines;
            let msg = format!(
                "Kept {} of {} lines (head {} + tail {})",
                kept, original_lines, head_result.kept_lines, tail_result.kept_lines
            );
            TruncateOutputResult {
                text: combined,
                truncated: true,
                message: Some(msg),
            }
        }
        _ => {
            // "tail" — keep the beginning
            let total_bytes = text.len();
            let r = truncate_tail(text, max_bytes);
            let removed = total_bytes - r.text.len();
            let msg = format!(
                "Kept first {} of {} lines ({} bytes truncated from end)",
                r.kept_lines, r.original_lines, removed
            );
            TruncateOutputResult {
                text: r.text,
                truncated: true,
                message: Some(msg),
            }
        }
    }
}

// ── helpers ──────────────────────────────────────────────────────────────

/// Count lines in a byte slice. A trailing newline does not add an extra line.
#[inline]
fn count_lines(bytes: &[u8]) -> u32 {
    if bytes.is_empty() {
        return 0;
    }
    let newlines = memchr::memchr_iter(b'\n', bytes).count() as u32;
    if bytes.last() == Some(&b'\n') {
        newlines
    } else {
        newlines + 1
    }
}

/// Find the byte position just past the last `\n` that is at or before `limit`.
/// Returns 0 if no newline exists before `limit`.
#[inline]
fn find_last_newline_before(bytes: &[u8], limit: usize) -> usize {
    let search_end = limit.min(bytes.len());
    // Search backwards for \n
    match memchr::memrchr(b'\n', &bytes[..search_end]) {
        Some(pos) => pos + 1, // include the newline
        None => 0,
    }
}

/// Find the byte position just past the first `\n` at or after `pos`.
/// Returns `bytes.len()` if no newline is found.
#[inline]
fn find_first_newline_after(bytes: &[u8], pos: usize) -> usize {
    let start = pos.min(bytes.len());
    match memchr::memchr(b'\n', &bytes[start..]) {
        Some(offset) => start + offset + 1, // skip past the newline
        None => bytes.len(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_no_truncation_needed() {
        let r = truncate_tail("hello\nworld\n".into(), 100);
        assert!(!r.truncated);
        assert_eq!(r.original_lines, 2);
        assert_eq!(r.kept_lines, 2);
        assert_eq!(r.text, "hello\nworld\n");
    }

    #[test]
    fn test_tail_truncation_ascii() {
        // "hello\nworld\n" = 12 bytes, limit to 7 -> keep "hello\n"
        let r = truncate_tail("hello\nworld\n".into(), 7);
        assert!(r.truncated);
        assert_eq!(r.text, "hello\n");
        assert_eq!(r.kept_lines, 1);
        assert_eq!(r.original_lines, 2);
    }

    #[test]
    fn test_head_truncation_ascii() {
        let r = truncate_head("hello\nworld\n".into(), 7);
        assert!(r.truncated);
        assert_eq!(r.text, "world\n");
        assert_eq!(r.kept_lines, 1);
    }

    #[test]
    fn test_utf8_multibyte() {
        // "cafe\u{0301}\n" = "café\n" where é is e + combining accent (3 bytes for the combining char)
        // Actually let's use a simpler case: "日本\n" = 7 bytes (3+3+1)
        let input = "日本\nworld\n".to_string();
        assert_eq!(input.len(), 13); // 3+3+1+5+1
        let r = truncate_tail(input.clone(), 8);
        assert!(r.truncated);
        assert_eq!(r.text, "日本\n");
        assert_eq!(r.kept_lines, 1);
    }

    #[test]
    fn test_empty_input() {
        let r = truncate_tail(String::new(), 100);
        assert!(!r.truncated);
        assert_eq!(r.original_lines, 0);
        assert_eq!(r.kept_lines, 0);

        let r2 = truncate_head(String::new(), 100);
        assert!(!r2.truncated);
    }

    #[test]
    fn test_exact_boundary() {
        let input = "abc\ndef\n".to_string(); // 8 bytes
        let r = truncate_tail(input.clone(), 8);
        assert!(!r.truncated);
        assert_eq!(r.text, "abc\ndef\n");
    }

    #[test]
    fn test_single_line_exceeding_limit() {
        let r = truncate_tail("this_is_a_very_long_line".into(), 5);
        assert!(r.truncated);
        assert_eq!(r.text, "");
        assert_eq!(r.kept_lines, 0);
    }

    #[test]
    fn test_head_single_line_exceeding() {
        let r = truncate_head("this_is_a_very_long_line".into(), 5);
        assert!(r.truncated);
        assert_eq!(r.text, "");
        assert_eq!(r.kept_lines, 0);
    }

    #[test]
    fn test_truncate_output_both_mode() {
        let mut lines = Vec::new();
        for i in 0..100 {
            lines.push(format!("line {i}"));
        }
        let input = lines.join("\n") + "\n";
        let r = truncate_output(input, 200, Some("both".into()));
        assert!(r.truncated);
        assert!(r.message.is_some());
        assert!(r.text.contains("... ["));
    }

    #[test]
    fn test_count_lines() {
        assert_eq!(count_lines(b""), 0);
        assert_eq!(count_lines(b"a"), 1);
        assert_eq!(count_lines(b"a\n"), 1);
        assert_eq!(count_lines(b"a\nb"), 2);
        assert_eq!(count_lines(b"a\nb\n"), 2);
    }

    #[test]
    fn test_utf8_emoji() {
        // Each emoji is 4 bytes
        let input = "😀\n😂\n🎉\n".to_string();
        assert_eq!(input.len(), 15); // 4+1+4+1+4+1
        let r = truncate_tail(input, 6);
        assert!(r.truncated);
        assert_eq!(r.text, "😀\n");
        assert_eq!(r.kept_lines, 1);
    }
}
