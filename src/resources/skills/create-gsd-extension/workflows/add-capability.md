<required_reading>
Read the reference file for the specific capability being added:
- Tools → references/custom-tools.md
- Commands → references/custom-commands.md
- Events → references/events-reference.md
- UI → references/custom-ui.md
- Rendering → references/custom-rendering.md
- State → references/state-management.md
- System prompt → references/system-prompt-modification.md
</required_reading>

<process>

## Step 1: Identify the Extension

Locate the existing extension file. Check:
- `~/.pi/agent/extensions/` (global community extensions)
- `.gsd/extensions/` (project-local)

Read the current extension code to understand its structure.

## Step 2: Add the Capability

Add the new registration/hook inside the existing `export default function (pi: ExtensionAPI)` body. Follow the patterns in the relevant reference file.

If the extension needs new imports, add them at the top of the file.

## Step 3: Handle Structural Changes

**Single file → Directory**: If the extension is outgrowing a single file:
1. Create `~/.pi/agent/extensions/my-extension/`
2. Move the file to `index.ts`
3. Extract helpers to separate files

**Adding npm dependencies**: If new packages are needed:
1. Create `package.json` in the extension directory
2. Add dependencies
3. Run `npm install`
4. Add `"pi": { "extensions": ["./index.ts"] }` to package.json

## Step 4: Test

```bash
/reload
```

Verify the new capability works alongside existing ones.

</process>

<success_criteria>
Capability addition is complete when:
- [ ] New capability added without breaking existing functionality
- [ ] All new imports resolve
- [ ] `/reload` succeeds
- [ ] New tool/command/hook tested with real invocation
</success_criteria>
