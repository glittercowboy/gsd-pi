//! N-API addon for GSD.
//!
//! Exposes high-performance Rust modules to Node.js via napi-rs.
//! ```text
//! JS (packages/native) -> N-API -> Rust modules (ast, clipboard, grep, image, ...)
//! ```

#![allow(clippy::needless_pass_by_value)]

mod ast;
mod clipboard;
mod diff;
mod fd;
mod fs_cache;
mod glob;
mod glob_util;
mod grep;
mod highlight;
mod html;
mod ps;
mod task;
mod text;
mod ttsr;
mod gsd_parser;
mod image;
mod json_parse;
mod stream_process;
