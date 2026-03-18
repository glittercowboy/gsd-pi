# S01: File Write API & Editor Font Size — UAT

**Milestone:** M009
**Written:** 2026-03-18

## UAT Type

- UAT mode: live-runtime
- Why this mode is sufficient: Both deliverables (POST API and settings panel) require a running server to exercise. curl verifies the API; browser verifies the settings panel.

## Preconditions

- `gsd --web` running with a project open (provides both the Next.js server and the GSD CLI backend)
- Note the `?project=` query parameter from the browser URL bar (needed for curl commands)
- Browser open to the workspace at the server URL (typically `http://localhost:3000`)

## Smoke Test

Run: `curl -s -X POST 'http://localhost:3000/api/files?project=<PROJECT_PATH>' -H 'Content-Type: application/json' -d '{"path":"_uat-smoke.txt","content":"smoke test","root":"project"}'`
**Expected:** `{"success":true}` with HTTP 200. File `_uat-smoke.txt` exists in the project root with content "smoke test". Clean up: delete `_uat-smoke.txt`.

## Test Cases

### 1. Valid file write

1. `curl -s -X POST 'http://localhost:3000/api/files?project=<PROJECT_PATH>' -H 'Content-Type: application/json' -d '{"path":"_uat-write.txt","content":"hello from POST","root":"project"}'`
2. Check response is `{"success":true}` with HTTP 200
3. `cat <PROJECT_ROOT>/_uat-write.txt`
4. **Expected:** File contains exactly `hello from POST`
5. Clean up: `rm <PROJECT_ROOT>/_uat-write.txt`

### 2. Path traversal rejection

1. `curl -s -o /dev/null -w "%{http_code}" -X POST 'http://localhost:3000/api/files?project=<PROJECT_PATH>' -H 'Content-Type: application/json' -d '{"path":"../../etc/passwd","content":"x","root":"gsd"}'`
2. **Expected:** HTTP 400. Response body contains `{"error":"Invalid path:..."}`.

### 3. Absolute path rejection

1. `curl -s -o /dev/null -w "%{http_code}" -X POST 'http://localhost:3000/api/files?project=<PROJECT_PATH>' -H 'Content-Type: application/json' -d '{"path":"/etc/passwd","content":"x","root":"project"}'`
2. **Expected:** HTTP 400.

### 4. Missing parent directory

1. `curl -s -X POST 'http://localhost:3000/api/files?project=<PROJECT_PATH>' -H 'Content-Type: application/json' -d '{"path":"nonexistent-deep/nested/file.txt","content":"x","root":"project"}'`
2. **Expected:** HTTP 404 with `{"error":"Parent directory does not exist"}`.

### 5. Missing path field

1. `curl -s -X POST 'http://localhost:3000/api/files?project=<PROJECT_PATH>' -H 'Content-Type: application/json' -d '{"content":"x","root":"gsd"}'`
2. **Expected:** HTTP 400 with `{"error":"Missing or invalid path: must be a non-empty string"}`.

### 6. Empty content (file clear)

1. `curl -s -X POST 'http://localhost:3000/api/files?project=<PROJECT_PATH>' -H 'Content-Type: application/json' -d '{"path":"_uat-empty.txt","content":"","root":"project"}'`
2. **Expected:** HTTP 200 with `{"success":true}`. File `_uat-empty.txt` exists and is empty (0 bytes).
3. Clean up: `rm <PROJECT_ROOT>/_uat-empty.txt`

### 7. Invalid root value

1. `curl -s -o /dev/null -w "%{http_code}" -X POST 'http://localhost:3000/api/files?project=<PROJECT_PATH>' -H 'Content-Type: application/json' -d '{"path":"test.txt","content":"x","root":"system"}'`
2. **Expected:** HTTP 400.

### 8. Editor font size settings panel visible

1. In the browser, open the settings panel (Cmd+, or click settings icon)
2. Scroll to find "Editor Text Size" section
3. **Expected:** Panel shows with subtitle "Applies to file viewer & editor", six preset buttons (11px through 16px), and a live preview line "The quick brown fox jumps over the lazy dog"

### 9. Editor font size preset selection

1. In the Editor Text Size panel, click the "12px" button
2. **Expected:** 12px button highlights (selected state). Preview text visually shrinks to 12px.
3. Click the "16px" button
4. **Expected:** 16px button highlights. Preview text visually grows to 16px.

### 10. Editor font size persistence

1. Set editor font size to 15px in the settings panel
2. Close and reopen the settings panel
3. **Expected:** 15px button is still highlighted (selected)
4. Refresh the browser page entirely (Cmd+R)
5. Reopen settings panel
6. **Expected:** 15px button is still highlighted — value survived page refresh via localStorage

### 11. Editor font size localStorage verification

1. Open browser DevTools → Console
2. Run: `localStorage.getItem('gsd-editor-font-size')`
3. **Expected:** Returns the string value of whatever size was last selected (e.g. `"15"`)
4. Run: `localStorage.setItem('gsd-editor-font-size', '11')`
5. Dispatch sync event: `window.dispatchEvent(new StorageEvent('storage', { key: 'gsd-editor-font-size', newValue: '11' }))`
6. Check settings panel
7. **Expected:** 11px button is now highlighted

## Edge Cases

### Malformed JSON body

1. `curl -s -X POST 'http://localhost:3000/api/files?project=<PROJECT_PATH>' -H 'Content-Type: application/json' -d 'not json at all'`
2. **Expected:** HTTP 400 with `{"error":"Invalid JSON body"}`

### Content is not a string (number)

1. `curl -s -o /dev/null -w "%{http_code}" -X POST 'http://localhost:3000/api/files?project=<PROJECT_PATH>' -H 'Content-Type: application/json' -d '{"path":"test.txt","content":42,"root":"project"}'`
2. **Expected:** HTTP 400

### Path with dot-dot segment

1. `curl -s -o /dev/null -w "%{http_code}" -X POST 'http://localhost:3000/api/files?project=<PROJECT_PATH>' -H 'Content-Type: application/json' -d '{"path":"subdir/../../../etc/hosts","content":"x","root":"project"}'`
2. **Expected:** HTTP 400 — resolveSecurePath catches embedded traversal

## Failure Signals

- Any POST to `/api/files` returning 500 instead of 400/404/413 indicates an unhandled error path
- Settings panel missing "Editor Text Size" section means the component wasn't wired into command-surface
- `localStorage.getItem('gsd-editor-font-size')` returning null after setting a value means persistence is broken
- `npm run build:web-host` failing means a type error was introduced

## Requirements Proved By This UAT

- R124 — POST handler accepts file writes with path validation, rejects all traversal patterns
- R121 (partial) — Editor font size preference persists and has a settings UI. Full proof requires S02 to apply the font size to the actual editor.

## Not Proven By This UAT

- R122 — CodeMirror editor integration (S02 scope)
- R121 full validation — font size actually applied to file viewer/editor display (S02 scope)
- Edit → Save → View round-trip (S02 scope)

## Notes for Tester

- Replace `<PROJECT_PATH>` in curl commands with the URL-encoded project path from your browser's address bar (the `?project=` query parameter value)
- The settings panel requires the full GSD CLI backend (`gsd --web`), not just `next dev`
- Clean up any `_uat-*.txt` test files from the project root after testing
- The 14px default marker "(default)" appears next to the 14px button — this is intentional to indicate the factory default
