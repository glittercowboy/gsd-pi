# GSD Native Engine

Rust N-API addon providing high-performance native modules for GSD.

## Architecture

```
JS (packages/native) -> N-API -> Rust crates

native/crates/
├── engine/  (N-API bindings, cdylib — 20+ modules)
├── grep/    (ripgrep internals, pure Rust lib)
└── ast/     (ast-grep structural search)
```

Inspired by [Oh My Pi's pi-natives](https://github.com/can1357/oh-my-pi), adapted for GSD's Node.js runtime.

## Prerequisites

- **Rust** (stable, 1.70+): https://rustup.rs
- **Node.js** (22.0.0+)

## Build

```bash
# Release build (optimized)
npm run build:native

# Debug build (fast compile, no optimizations)
npm run build:native:dev
```

The build script compiles the Rust code and copies the `.node` shared library to `native/addon/`.

## Test

```bash
# Rust unit tests
cd native && cargo test

# Node.js integration tests
npm run test:native
```

## Modules

### ast

Structural code search via ast-grep. Provides pattern-based code matching that understands language syntax, enabling searches like "find all functions that return a Promise" rather than raw regex.

### clipboard

Native clipboard access for reading and writing system clipboard contents.

### diff

Fuzzy text matching and unified diff generation. Provides efficient comparison of text content with configurable matching thresholds.

### fd

Fuzzy file path discovery. Locates files by partial name matching across the project tree.

### fs_cache

Filesystem caching layer. Caches file metadata and contents to reduce redundant I/O during repeated operations.

### git

Libgit2-backed git read operations. Provides fast, direct access to repository status, diffs, blame, and log without shelling out to the `git` CLI.

### glob / glob_util

Gitignore-aware file discovery. Walks directory trees while respecting `.gitignore` rules, returning matching paths for a given glob pattern.

### grep

Ripgrep-backed regex search using the `grep-regex`, `grep-searcher`, and `grep-matcher` crates.

**Functions:**

- `search(content, options)` — Search in-memory Buffer/Uint8Array content
- `grep(options)` — Search files on disk with glob filtering and .gitignore support

**TypeScript usage:**

```typescript
import { grep, searchContent } from "@gsd/native";

// Search files
const result = grep({
  pattern: "TODO",
  path: "./src",
  glob: "*.ts",
  ignoreCase: true,
  maxCount: 100,
});

// Search content
const contentResult = searchContent(Buffer.from(fileContent), {
  pattern: "function\\s+\\w+",
  contextBefore: 2,
  contextAfter: 2,
});
```

### gsd_parser

GSD file parsing and frontmatter extraction. Reads `.gsd` files and extracts structured metadata from YAML frontmatter blocks.

### highlight

Syntect-based syntax highlighting. Tokenizes source code and produces highlighted output for terminal or HTML rendering.

### html

HTML-to-Markdown conversion. Transforms HTML content into clean Markdown, useful for importing web content into GSD notes and documents.

### image

Image decoding, encoding, and resizing. Supports common formats (PNG, JPEG, WebP) and provides efficient thumbnail generation.

### json_parse

JSON parsing utilities. Provides streaming and fault-tolerant JSON parsing for large or partially valid payloads.

### ps

Cross-platform process tree management. Lists, inspects, and terminates process trees by PID, used for managing spawned subprocesses.

### stream_process

Streaming process I/O. Spawns child processes with non-blocking, streamed access to stdout and stderr for real-time output handling.

### task

Task-related native operations. Provides low-level primitives for task scheduling and execution within the native layer.

### text

ANSI-aware text measurement and wrapping. Correctly measures visible width of strings containing ANSI escape codes and wraps text to terminal column widths.

### truncate

Text truncation utilities. Truncates strings to a target length while preserving ANSI sequences and respecting grapheme boundaries.

### ttsr

Tool-triggered system rules. Evaluates and applies system-level rules that activate in response to specific tool invocations.

### xxhash

xxHash hashing. Provides fast, non-cryptographic hashing via the xxHash algorithm for content deduplication and cache keying.

## Adding New Modules

1. Create a new crate in `native/crates/` (pure Rust library)
2. Add N-API bindings in `native/crates/engine/src/`
3. Add TypeScript wrapper in `packages/native/src/`
4. Add the crate to `engine/Cargo.toml` dependencies
