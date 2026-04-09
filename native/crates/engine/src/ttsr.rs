//! N-API bindings for the TTSR (Time Traveling Stream Rules) regex engine.
//!
//! Pre-compiles all rule condition patterns into a `regex::RegexSet` so that
//! `checkBuffer` can test all patterns against the accumulated stream buffer
//! in a single DFA pass, instead of iterating O(rules x conditions) in JS.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

/// Maps a compiled regex back to its owning rule.
struct PatternMapping {
    /// Index into the RegexSet's pattern list.
    _pattern_index: usize,
    /// Name of the rule this pattern belongs to.
    rule_name: String,
}

struct CompiledRuleSet {
    regex_set: regex::RegexSet,
    mappings: Vec<PatternMapping>,
}

// Global handle store — handles are u64 keys into this map.
static NEXT_HANDLE: AtomicU64 = AtomicU64::new(1);
static STORE: std::sync::LazyLock<Mutex<HashMap<u64, CompiledRuleSet>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

#[napi(object)]
pub struct NapiTtsrRuleInput {
    pub name: String,
    pub conditions: Vec<String>,
}

/// Maximum number of live handles allowed before we refuse to allocate more.
/// Prevents unbounded memory growth if JS callers forget to free handles.
const MAX_LIVE_HANDLES: usize = 10_000;

/// Lock the global STORE, recovering gracefully from mutex poisoning.
fn lock_store() -> std::sync::MutexGuard<'static, HashMap<u64, CompiledRuleSet>> {
    STORE.lock().unwrap_or_else(|e| e.into_inner())
}

/// Compile a set of TTSR rules into an optimized regex engine.
///
/// Returns an opaque numeric handle. Each rule has one or more regex condition
/// patterns. All patterns are compiled into a single `RegexSet` for O(1)-style
/// matching against the stream buffer.
#[napi(js_name = "ttsrCompileRules")]
pub fn ttsr_compile_rules(rules: Vec<NapiTtsrRuleInput>) -> Result<f64> {
    let mut patterns: Vec<String> = Vec::new();
    let mut mappings: Vec<PatternMapping> = Vec::new();

    for rule in &rules {
        for condition in &rule.conditions {
            let idx = patterns.len();
            patterns.push(condition.clone());
            mappings.push(PatternMapping {
                _pattern_index: idx,
                rule_name: rule.name.clone(),
            });
        }
    }

    if patterns.is_empty() {
        return Err(Error::from_reason("No valid patterns provided"));
    }

    let regex_set = regex::RegexSet::new(&patterns)
        .map_err(|e| Error::from_reason(format!("Failed to compile regex set: {e}")))?;

    let handle = NEXT_HANDLE.fetch_add(1, Ordering::Relaxed);

    let compiled = CompiledRuleSet {
        regex_set,
        mappings,
    };

    let mut store = lock_store();
    if store.len() >= MAX_LIVE_HANDLES {
        return Err(Error::from_reason(format!(
            "TTSR handle limit reached ({MAX_LIVE_HANDLES}). Free unused handles before compiling more rules."
        )));
    }
    store.insert(handle, compiled);

    // Return as f64 since napi BigInt interop is awkward; handles won't exceed 2^53.
    Ok(handle as f64)
}

/// Check a buffer against compiled TTSR rules.
///
/// Returns an array of unique rule names whose conditions matched the buffer.
/// The RegexSet tests all patterns in a single pass over the buffer.
#[napi(js_name = "ttsrCheckBuffer")]
pub fn ttsr_check_buffer(handle: f64, buffer: String) -> Result<Vec<String>> {
    let handle_key = handle as u64;

    // Bounds-check: reject handles that were never allocated.
    let upper_bound = NEXT_HANDLE.load(Ordering::Relaxed);
    if handle_key == 0 || handle_key >= upper_bound {
        return Err(Error::from_reason(format!("Invalid TTSR handle: {handle}")));
    }

    let store = lock_store();

    let compiled = store
        .get(&handle_key)
        .ok_or_else(|| Error::from_reason(format!("Invalid TTSR handle: {handle}")))?;

    let matching_indices: Vec<usize> = compiled.regex_set.matches(&buffer).into_iter().collect();

    // Deduplicate: multiple conditions from the same rule should produce one entry.
    let mut seen = std::collections::HashSet::new();
    let mut matched_rules: Vec<String> = Vec::new();

    for idx in matching_indices {
        let rule_name = &compiled.mappings[idx].rule_name;
        if seen.insert(rule_name.clone()) {
            matched_rules.push(rule_name.clone());
        }
    }

    Ok(matched_rules)
}

/// Free a compiled TTSR rule set, releasing memory.
#[napi(js_name = "ttsrFreeRules")]
pub fn ttsr_free_rules(handle: f64) -> Result<()> {
    let handle_key = handle as u64;
    lock_store().remove(&handle_key);
    Ok(())
}

/// Free all compiled TTSR rule sets, releasing all memory.
///
/// Useful for process cleanup or tests that need a fresh state.
#[napi(js_name = "ttsrClearAll")]
pub fn ttsr_clear_all() {
    lock_store().clear();
}
