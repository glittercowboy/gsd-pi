# Packaging & Distribution


### Creating a Pi Package

Add a `pi` manifest to `package.json`:

```json
{
  "name": "my-pi-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

### Installing Packages

```bash
pi install npm:@foo/bar@1.0.0
pi install git:github.com/user/repo@v1
pi install ./local/path

# Try without installing:
pi -e npm:@foo/bar
```

### Convention Directories (no manifest needed)

If no `pi` manifest exists, pi auto-discovers:
- `extensions/` → `.ts` and `.js` files
- `skills/` → `SKILL.md` folders
- `prompts/` → `.md` files
- `themes/` → `.json` files

### Gallery Metadata

```json
{
  "pi": {
    "video": "https://example.com/demo.mp4",
    "image": "https://example.com/screenshot.png"
  }
}
```

### Dependencies

- List `@mariozechner/pi-ai`, `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, `@sinclair/typebox` in `peerDependencies` with `"*"` — they're bundled by pi.
- Other npm deps go in `dependencies`. Pi runs `npm install` on package installation.

---
