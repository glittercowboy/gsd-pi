//! Shared glob-pattern helpers used by [`crate::glob`].

use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use napi::bindgen_prelude::*;

/// Normalize a raw glob string: fix path separators, optionally prepend `**/`
/// for recursive matching, and close any unclosed `{` alternation groups.
pub fn build_glob_pattern(glob: &str, recursive: bool) -> String {
    let normalized = glob.replace('\\', "/");
    let pattern = if !recursive || normalized.contains('/') || normalized.starts_with("**") {
        normalized
    } else {
        format!("**/{normalized}")
    };
    fix_unclosed_braces(pattern)
}

/// Compile a glob pattern string into a [`GlobSet`].
///
/// When `recursive` is true, simple patterns (no path separators, no leading
/// `**`) are automatically prefixed with `**/`.
pub fn compile_glob(glob: &str, recursive: bool) -> Result<GlobSet> {
    let mut builder = GlobSetBuilder::new();
    let pattern = build_glob_pattern(glob, recursive);
    let glob = GlobBuilder::new(&pattern)
        .literal_separator(true)
        .build()
        .map_err(|err| Error::from_reason(format!("Invalid glob pattern: {err}")))?;
    builder.add(glob);
    builder
        .build()
        .map_err(|err| Error::from_reason(format!("Failed to build glob matcher: {err}")))
}

/// Close unclosed `{` alternation groups in a glob pattern.
///
/// LLMs occasionally produce patterns like `*.{ts,js` without the closing `}`.
/// Rather than failing, we append the missing braces.
fn fix_unclosed_braces(pattern: String) -> String {
    let opens = pattern.chars().filter(|&c| c == '{').count();
    let closes = pattern.chars().filter(|&c| c == '}').count();
    if opens > closes {
        let mut fixed = pattern;
        for _ in 0..(opens - closes) {
            fixed.push('}');
        }
        fixed
    } else {
        pattern
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simple_pattern_gets_recursive_prefix() {
        assert_eq!(build_glob_pattern("*.ts", true), "**/*.ts");
    }

    #[test]
    fn pattern_with_path_stays_as_is() {
        assert_eq!(build_glob_pattern("src/*.ts", true), "src/*.ts");
    }

    #[test]
    fn already_recursive_pattern_unchanged() {
        assert_eq!(build_glob_pattern("**/*.rs", true), "**/*.rs");
    }

    #[test]
    fn non_recursive_keeps_simple_pattern() {
        assert_eq!(build_glob_pattern("*.ts", false), "*.ts");
    }

    #[test]
    fn backslashes_normalized() {
        assert_eq!(build_glob_pattern("src\\**\\*.ts", true), "src/**/*.ts");
    }

    #[test]
    fn unclosed_brace_gets_closed() {
        assert_eq!(
            build_glob_pattern("*.{ts,tsx,js", true),
            "**/*.{ts,tsx,js}"
        );
    }

    #[test]
    fn deeply_unclosed_braces_all_closed() {
        assert_eq!(build_glob_pattern("{a,{b,c}", true), "**/{a,{b,c}}");
    }

    #[test]
    fn balanced_braces_unchanged() {
        assert_eq!(build_glob_pattern("*.{ts,js}", true), "**/*.{ts,js}");
    }

    #[test]
    fn compile_glob_accepts_valid_pattern() {
        assert!(compile_glob("*.ts", true).is_ok());
    }

    #[test]
    fn compile_glob_fixes_unclosed_brace() {
        assert!(compile_glob("*.{ts,tsx,js", true).is_ok());
    }
}
