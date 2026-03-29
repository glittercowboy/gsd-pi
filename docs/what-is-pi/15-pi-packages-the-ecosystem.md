# Pi Packages — The Ecosystem

Pi packages bundle extensions, skills, prompts, and themes for distribution via npm or git.

### Installing

```bash
pi install npm:@foo/bar@1.0.0       # From npm (pinned)
pi install npm:@foo/bar              # From npm (latest)
pi install git:github.com/user/repo  # From git
pi install ./local/path              # From local path
pi list                              # Show installed
pi update                            # Update non-pinned
pi remove npm:@foo/bar               # Uninstall
pi config                            # Enable/disable resources
```

### Creating

Add a `pi` key to `package.json`:

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

Or just use conventional directory names (`extensions/`, `skills/`, `prompts/`, `themes/`) and pi discovers them automatically.

### Finding Packages

- [Package gallery](https://shittycodingagent.ai/packages)
- [npm search](https://www.npmjs.com/search?q=keywords%3Api-package)
- [Discord community](https://discord.com/invite/nKXTsAcmbT)

---
