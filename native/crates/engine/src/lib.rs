//! N-API addon for GSD.
//!
//! Exposes high-performance Rust modules to Node.js via napi-rs.
//! Architecture mirrors Oh My Pi's pi-natives crate:
//! ```text
//! JS (packages/native) -> N-API -> Rust modules (grep, ...)
//! ```

#![allow(clippy::needless_pass_by_value)]

mod clipboard;
mod fs_cache;
mod glob;
mod glob_util;
mod ast;
mod grep;
mod highlight;
mod html;
mod ps;
mod task;
mod text;
