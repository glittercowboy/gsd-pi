//! Blocking work scheduling for N-API exports.
//!
//! Runs CPU-bound or blocking Rust work on libuv's thread pool via napi's
//! `Task` trait, with cooperative cancellation support.
//!
//! # Cancellation
//! Pass a `CancelToken` to blocking tasks. Work must check
//! `CancelToken::heartbeat()` periodically to respect cancellation.

use std::time::{Duration, Instant};

use napi::{Env, Error, Result, Task, bindgen_prelude::*};

// ─────────────────────────────────────────────────────────────────────────────
// Cancellation
// ─────────────────────────────────────────────────────────────────────────────

/// Token for cooperative cancellation of blocking work.
///
/// Call `heartbeat()` periodically inside long-running work to check for
/// cancellation requests from timeouts.
#[derive(Clone, Default)]
pub struct CancelToken {
    deadline: Option<Instant>,
}

impl From<()> for CancelToken {
    fn from((): ()) -> Self {
        Self::default()
    }
}

impl CancelToken {
    /// Create a new cancel token from an optional timeout in milliseconds.
    pub fn new(timeout_ms: Option<u32>) -> Self {
        let mut result = Self::default();
        if let Some(timeout_ms) = timeout_ms {
            result.deadline = Some(Instant::now() + Duration::from_millis(timeout_ms as u64));
        }
        result
    }

    /// Check if cancellation has been requested.
    ///
    /// Returns `Ok(())` if work should continue, or an error if timed out.
    pub fn heartbeat(&self) -> Result<()> {
        if let Some(deadline) = self.deadline {
            if deadline < Instant::now() {
                return Err(Error::from_reason("Aborted: Timeout"));
            }
        }
        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Blocking Task - libuv thread pool integration
// ─────────────────────────────────────────────────────────────────────────────

/// Task that runs blocking work on libuv's thread pool.
pub struct Blocking<T>
where
    T: Send + 'static,
{
    cancel_token: CancelToken,
    work: Option<Box<dyn FnOnce(CancelToken) -> Result<T> + Send>>,
}

impl<T> Task for Blocking<T>
where
    T: ToNapiValue + Send + 'static + TypeName,
{
    type JsValue = T;
    type Output = T;

    fn compute(&mut self) -> Result<Self::Output> {
        let work = self
            .work
            .take()
            .ok_or_else(|| Error::from_reason("BlockingTask: work already consumed"))?;
        work(self.cancel_token.clone())
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub type Async<T> = AsyncTask<Blocking<T>>;

/// Create an `AsyncTask` that runs blocking work on libuv's thread pool.
///
/// Returns `AsyncTask<Blocking<T>>` which becomes `Promise<T>` on the JS side.
pub fn blocking<T, F>(
    _tag: &'static str,
    cancel_token: impl Into<CancelToken>,
    work: F,
) -> AsyncTask<Blocking<T>>
where
    F: FnOnce(CancelToken) -> Result<T> + Send + 'static,
    T: ToNapiValue + TypeName + Send + 'static,
{
    AsyncTask::new(Blocking {
        cancel_token: cancel_token.into(),
        work: Some(Box::new(work)),
    })
}
