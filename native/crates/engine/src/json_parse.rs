//! Streaming JSON parser via N-API.
//!
//! Exposes fast JSON parsing with partial/incomplete JSON recovery
//! for use during LLM streaming tool call argument parsing.

use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Parse a complete JSON string. Returns the parsed value or an error.
#[napi(js_name = "parseJson")]
pub fn parse_json(env: Env, text: String) -> Result<napi::JsUnknown> {
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| Error::from_reason(format!("{e}")))?;
    serde_value_to_napi(&env, &value)
}

/// Parse potentially incomplete JSON by closing unclosed structures.
#[napi(js_name = "parsePartialJson")]
pub fn parse_partial_json(env: Env, text: String) -> Result<napi::JsUnknown> {
    let fixed = fix_partial_json(&text);
    let value: serde_json::Value =
        serde_json::from_str(&fixed).map_err(|e| Error::from_reason(format!("{e}")))?;
    serde_value_to_napi(&env, &value)
}

/// Try full JSON parse first; fall back to partial parse. Returns `{}` on total failure.
#[napi(js_name = "parseStreamingJson")]
pub fn parse_streaming_json(env: Env, text: String) -> Result<napi::JsUnknown> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        // Return empty object
        let obj = env.create_object()?;
        return Ok(obj.into_unknown());
    }

    // Fast path: try complete parse
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
        return serde_value_to_napi(&env, &value);
    }

    // Slow path: fix partial JSON
    let fixed = fix_partial_json(trimmed);
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&fixed) {
        return serde_value_to_napi(&env, &value);
    }

    // Total failure: return empty object
    let obj = env.create_object()?;
    Ok(obj.into_unknown())
}

/// Fix incomplete JSON by closing unclosed strings, objects, arrays,
/// removing trailing commas, and handling truncated values.
fn fix_partial_json(input: &str) -> String {
    let mut result = String::with_capacity(input.len() + 16);
    let mut stack: Vec<char> = Vec::new(); // tracks expected closing chars
    let mut in_string = false;
    let mut escape_next = false;
    let chars: Vec<char> = input.chars().collect();
    let len = chars.len();
    let mut i = 0;

    while i < len {
        let ch = chars[i];

        if escape_next {
            result.push(ch);
            escape_next = false;
            i += 1;
            continue;
        }

        if in_string {
            if ch == '\\' {
                result.push(ch);
                escape_next = true;
            } else if ch == '"' {
                result.push(ch);
                in_string = false;
            } else {
                result.push(ch);
            }
            i += 1;
            continue;
        }

        // Not in a string
        match ch {
            '"' => {
                result.push(ch);
                in_string = true;
            }
            '{' => {
                result.push(ch);
                stack.push('}');
            }
            '[' => {
                result.push(ch);
                stack.push(']');
            }
            '}' | ']' => {
                // Remove trailing comma before closing
                remove_trailing_comma(&mut result);
                result.push(ch);
                if let Some(expected) = stack.last() {
                    if *expected == ch {
                        stack.pop();
                    }
                }
            }
            _ => {
                result.push(ch);
            }
        }
        i += 1;
    }

    // If we ended inside an escape sequence within a string
    if escape_next && in_string {
        // Drop the trailing backslash (incomplete escape)
        result.pop();
    }

    // Close unclosed string
    if in_string {
        result.push('"');
    }

    // Remove any trailing comma before we close structures
    remove_trailing_comma(&mut result);

    // Handle truncated values: if last meaningful token looks like a key with colon but no value
    handle_truncated_value(&mut result);

    // Close unclosed structures
    while let Some(closer) = stack.pop() {
        remove_trailing_comma(&mut result);
        result.push(closer);
    }

    result
}

/// Remove trailing comma (and whitespace before it) from the result buffer.
fn remove_trailing_comma(result: &mut String) {
    let trimmed_len = result.trim_end().len();
    if trimmed_len > 0 {
        let last_non_ws = result.as_bytes()[trimmed_len - 1];
        if last_non_ws == b',' {
            result.truncate(trimmed_len - 1);
        }
    }
}

/// Handle truncated values after a colon (e.g., `{"key":` or `{"key": tr`)
fn handle_truncated_value(result: &mut String) {
    let trimmed = result.trim_end();

    // If ends with colon, add null
    if trimmed.ends_with(':') {
        result.push_str("null");
        return;
    }

    let bytes = trimmed.as_bytes();
    let len = bytes.len();

    // Check for truncated number: digits (possibly with leading minus, dot, or 'e')
    // at the end after a value-position character
    if len > 0 {
        let last = bytes[len - 1];
        if last.is_ascii_digit() || last == b'.' || last == b'-' || last == b'e' || last == b'E' || last == b'+' {
            // Walk backwards to find the start of the number-like token
            let mut start = len;
            while start > 0 {
                let b = bytes[start - 1];
                if b.is_ascii_digit() || b == b'.' || b == b'-' || b == b'e' || b == b'E' || b == b'+' {
                    start -= 1;
                } else {
                    break;
                }
            }
            if start < len {
                let before = trimmed[..start].trim_end();
                if before.ends_with(':') || before.ends_with(',') || before.ends_with('[') {
                    let token = &trimmed[start..];
                    // If it doesn't parse as a valid number, truncate to the last valid portion
                    if token.parse::<f64>().is_err() {
                        // Strip trailing non-digit chars (e.g. "12." -> "12", "1e" -> "1")
                        let mut valid_end = token.len();
                        while valid_end > 0 && !token.as_bytes()[valid_end - 1].is_ascii_digit() {
                            valid_end -= 1;
                        }
                        if valid_end > 0 {
                            result.truncate(start + valid_end);
                        } else {
                            // Just a minus or dot with no digits — replace with 0
                            result.truncate(start);
                            result.push('0');
                        }
                    }
                    // If it parses fine, leave it as-is
                    return;
                }
            }
        }
    }

    // Check for truncated boolean/null literals after a value-position character
    for prefix in &["tru", "tr", "t", "fals", "fal", "fa", "f", "nul", "nu", "n"] {
        if trimmed.ends_with(prefix) {
            let before = trimmed[..len - prefix.len()].trim_end();
            if before.ends_with(':') || before.ends_with(',') || before.ends_with('[') {
                let full = match prefix.as_bytes()[0] {
                    b't' => "true",
                    b'f' => "false",
                    b'n' => "null",
                    _ => unreachable!(),
                };
                result.truncate(len - prefix.len());
                result.push_str(full);
                return;
            }
        }
    }
}

/// Convert a serde_json::Value to a napi JsUnknown.
fn serde_value_to_napi(env: &Env, value: &serde_json::Value) -> Result<napi::JsUnknown> {
    match value {
        serde_json::Value::Null => {
            env.get_null().map(|v| v.into_unknown())
        }
        serde_json::Value::Bool(b) => {
            env.get_boolean(*b).map(|v| v.into_unknown())
        }
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                // Use i32 if it fits, otherwise f64
                if i >= i64::from(i32::MIN) && i <= i64::from(i32::MAX) {
                    env.create_int32(i as i32).map(|v| v.into_unknown())
                } else {
                    env.create_double(i as f64).map(|v| v.into_unknown())
                }
            } else if let Some(f) = n.as_f64() {
                env.create_double(f).map(|v| v.into_unknown())
            } else {
                env.get_null().map(|v| v.into_unknown())
            }
        }
        serde_json::Value::String(s) => {
            env.create_string(s).map(|v| v.into_unknown())
        }
        serde_json::Value::Array(arr) => {
            let mut js_arr = env.create_array_with_length(arr.len())?;
            for (idx, item) in arr.iter().enumerate() {
                let js_val = serde_value_to_napi(env, item)?;
                js_arr.set_element(idx as u32, js_val)?;
            }
            Ok(js_arr.into_unknown())
        }
        serde_json::Value::Object(map) => {
            let mut obj = env.create_object()?;
            for (key, val) in map {
                let js_val = serde_value_to_napi(env, val)?;
                obj.set_named_property(key, js_val)?;
            }
            Ok(obj.into_unknown())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fix_complete_json() {
        let input = r#"{"key": "value", "num": 42}"#;
        let fixed = fix_partial_json(input);
        let _: serde_json::Value = serde_json::from_str(&fixed).unwrap();
    }

    #[test]
    fn test_fix_unclosed_string() {
        let input = r#"{"key": "val"#;
        let fixed = fix_partial_json(input);
        let v: serde_json::Value = serde_json::from_str(&fixed).unwrap();
        assert_eq!(v["key"], "val");
    }

    #[test]
    fn test_fix_unclosed_object() {
        let input = r#"{"key": "value""#;
        let fixed = fix_partial_json(input);
        let v: serde_json::Value = serde_json::from_str(&fixed).unwrap();
        assert_eq!(v["key"], "value");
    }

    #[test]
    fn test_fix_unclosed_array() {
        let input = r#"{"arr": [1, 2, 3"#;
        let fixed = fix_partial_json(input);
        let v: serde_json::Value = serde_json::from_str(&fixed).unwrap();
        assert_eq!(v["arr"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn test_fix_trailing_comma() {
        let input = r#"{"a": 1, "b": 2,}"#;
        let fixed = fix_partial_json(input);
        let v: serde_json::Value = serde_json::from_str(&fixed).unwrap();
        assert_eq!(v["a"], 1);
        assert_eq!(v["b"], 2);
    }

    #[test]
    fn test_fix_truncated_after_colon() {
        let input = r#"{"key":"#;
        let fixed = fix_partial_json(input);
        let _: serde_json::Value = serde_json::from_str(&fixed).unwrap();
    }

    #[test]
    fn test_fix_truncated_true() {
        let input = r#"{"key": tr"#;
        let fixed = fix_partial_json(input);
        let v: serde_json::Value = serde_json::from_str(&fixed).unwrap();
        assert_eq!(v["key"], true);
    }

    #[test]
    fn test_fix_truncated_false() {
        let input = r#"{"key": fal"#;
        let fixed = fix_partial_json(input);
        let v: serde_json::Value = serde_json::from_str(&fixed).unwrap();
        assert_eq!(v["key"], false);
    }

    #[test]
    fn test_fix_truncated_null() {
        let input = r#"{"key": nu"#;
        let fixed = fix_partial_json(input);
        let v: serde_json::Value = serde_json::from_str(&fixed).unwrap();
        assert!(v["key"].is_null());
    }

    #[test]
    fn test_fix_nested_partial() {
        let input = r#"{"a": {"b": [1, 2"#;
        let fixed = fix_partial_json(input);
        let v: serde_json::Value = serde_json::from_str(&fixed).unwrap();
        assert_eq!(v["a"]["b"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn test_empty_input() {
        let fixed = fix_partial_json("");
        assert_eq!(fixed, "");
    }

    #[test]
    fn test_fix_trailing_comma_in_array() {
        let input = r#"[1, 2, 3,]"#;
        let fixed = fix_partial_json(input);
        let v: serde_json::Value = serde_json::from_str(&fixed).unwrap();
        assert_eq!(v.as_array().unwrap().len(), 3);
    }

    #[test]
    fn test_fix_truncated_number() {
        let input = r#"{"key": 12"#;
        let fixed = fix_partial_json(input);
        let v: serde_json::Value = serde_json::from_str(&fixed).unwrap();
        assert_eq!(v["key"], 12);
    }

    #[test]
    fn test_fix_truncated_decimal() {
        let input = r#"{"key": 3."#;
        let fixed = fix_partial_json(input);
        let v: serde_json::Value = serde_json::from_str(&fixed).unwrap();
        assert_eq!(v["key"], 3);
    }

    #[test]
    fn test_fix_truncated_negative_number() {
        let input = r#"{"key": -"#;
        let fixed = fix_partial_json(input);
        let v: serde_json::Value = serde_json::from_str(&fixed).unwrap();
        assert_eq!(v["key"], 0);
    }

    #[test]
    fn test_fix_truncated_exponent() {
        let input = r#"{"key": 1e"#;
        let fixed = fix_partial_json(input);
        let v: serde_json::Value = serde_json::from_str(&fixed).unwrap();
        assert_eq!(v["key"], 1);
    }

    #[test]
    fn test_fix_truncated_number_in_array() {
        let input = r#"[1, 42"#;
        let fixed = fix_partial_json(input);
        let v: serde_json::Value = serde_json::from_str(&fixed).unwrap();
        assert_eq!(v[0], 1);
        assert_eq!(v[1], 42);
    }
}
