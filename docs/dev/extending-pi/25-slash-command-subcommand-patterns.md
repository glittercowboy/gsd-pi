# Slash Command Subcommand Patterns

Pi does not have a separate built-in concept of "nested slash commands" like `/wt new` or `/foo delete`.

Instead, this UX is built by registering a single slash command and using **argument completions** to make the first argument behave like a subcommand.

This is the pattern used by the built-in worktree extension:
- `/wt`
- `/wt new`
- `/wt ls`
- `/wt switch my-branch`

The key API is:
- `pi.registerCommand(name, options)`
- `getArgumentCompletions(prefix)`
- `handler(args, ctx)`

## Mental Model

Treat the command as:

- one top-level slash command
- one or more positional arguments
- the first positional argument acting as a subcommand
- optional later arguments completed dynamically based on the first

So this:

```text
/wt
  new
  ls
  switch
  merge
  rm
  status
```

is really just:

- command: `wt`
- first arg: one of `new | ls | switch | merge | rm | status`

## The Core Pattern

```typescript
pi.registerCommand("foo", {
  description: "Manage foo items: /foo new|list|delete [name]",

  getArgumentCompletions: (prefix: string) => {
    const subcommands = ["new", "list", "delete"];
    const parts = prefix.trim().split(/\s+/);

    // Complete the first argument: /foo <subcommand>
    if (parts.length <= 1) {
      return subcommands
        .filter((cmd) => cmd.startsWith(parts[0] ?? ""))
        .map((cmd) => ({ value: cmd, label: cmd }));
    }

    // Complete the second argument: /foo delete <name>
    if (parts[0] === "delete") {
      const items = ["alpha", "beta", "gamma"];
      const namePrefix = parts[1] ?? "";
      return items
        .filter((name) => name.startsWith(namePrefix))
        .map((name) => ({ value: `delete ${name}`, label: name }));
    }

    return [];
  },

  handler: async (args, ctx) => {
    const parts = args.trim().split(/\s+/);
    const sub = parts[0];
    const name = parts[1];

    await ctx.waitForIdle();

    if (sub === "new") {
      ctx.ui.notify("Create a new foo item", "info");
      return;
    }

    if (sub === "list") {
      ctx.ui.notify("List foo items", "info");
      return;
    }

    if (sub === "delete") {
      if (!name) {
        ctx.ui.notify("Usage: /foo delete <name>", "error");
        return;
      }
      ctx.ui.notify(`Deleting ${name}`, "info");
      return;
    }

    ctx.ui.notify("Usage: /foo <new|list|delete> [name]", "info");
  },
});
```

## How `getArgumentCompletions()` Behaves

`getArgumentCompletions(prefix)` receives everything after the slash command name.

Examples for `/foo`:

- typing `/foo ` gives `prefix === ""`
- typing `/foo de` gives `prefix === "de"`
- typing `/foo delete a` gives `prefix === "delete a"`

That means you can parse the prefix into words and decide what suggestions to show next.

A common structure is:

1. If the user is on the first argument, show available subcommands.
2. If the first argument selects a branch like `delete`, show completions for the next argument.
3. Otherwise return `[]`.

## Important Detail: Empty Prefix Handling

A practical gotcha is that:

```typescript
"".trim().split(/\s+/)
```

produces `['']`, not `[]`.

That is why the common pattern is:

```typescript
const parts = prefix.trim().split(/\s+/);
if (parts.length <= 1) {
  // complete first argument
}
```

This handles both:
- completely empty input after the command
- partially typed first arguments

## Dynamic Second-Argument Completion

This pattern becomes powerful when later arguments depend on the subcommand.

Example:

```typescript
getArgumentCompletions: (prefix) => {
  const parts = prefix.trim().split(/\s+/);
  const sub = parts[0];

  if (parts.length <= 1) {
    return ["new", "list", "delete"].map((s) => ({ value: s, label: s }));
  }

  if (sub === "delete") {
    const items = getCurrentItemsSomehow();
    const namePrefix = parts[1] ?? "";
    return items
      .filter((item) => item.startsWith(namePrefix))
      .map((item) => ({ value: `delete ${item}`, label: item }));
  }

  return [];
}
```

This is how `/wt switch`, `/wt merge`, and `/wt rm` can suggest current worktree names.

## Real Example: `/wt`

The worktree extension uses this exact structure in:

- `~/.gsd/agent/extensions/worktree/index.ts`

It defines:

```typescript
const subcommands = ["new", "ls", "switch", "merge", "rm", "status"];
```

Then:

- when the first argument is still being typed, it suggests those subcommands
- when the first argument is `switch`, `merge`, or `rm`, it suggests matching worktree names for the second argument

That is why typing:

```text
/wt 
```

shows:

```text
new
ls
switch
merge
rm
status
```

and typing:

```text
/wt switch 
```

shows available worktree names.

## Parsing in the Handler

Your completion logic and your handler logic should agree on the command shape.

A common structure is:

```typescript
handler: async (args, ctx) => {
  const parts = args.trim().split(/\s+/);
  const sub = parts[0];
  const rest = parts.slice(1);

  switch (sub) {
    case "new":
      // handle /foo new
      return;
    case "list":
      // handle /foo list
      return;
    case "delete":
      // handle /foo delete <name>
      return;
    default:
      ctx.ui.notify("Usage: /foo <new|list|delete>", "info");
      return;
  }
}
```

Keep the parsing simple and mirror the same branches your completions advertise.

## When to Use This Pattern

Use a single command with subcommand-style completions when:

- the actions belong to one clear domain
- you want discoverability from one entry point
- the subcommands feel like one family of operations
- later arguments depend on the earlier choice

Examples:

- `/wt new|switch|merge|rm|status`
- `/preset save|load|delete`
- `/workflow start|list|abort`
- `/foo new|list|delete`

## When to Prefer Separate Commands

Prefer separate commands when:

- the actions are conceptually unrelated
- each command needs its own distinct description and identity
- autocomplete would become too deep or overloaded
- the combined command would become hard to remember or document

Good candidates for separate commands:

- `/deploy`
- `/rollback`
- `/handoff`

rather than forcing all of those into one umbrella command.

## UX Guidelines

A few practical rules make this pattern feel good:

- Keep top-level subcommands short and obvious.
- Use names that read naturally after the slash command.
- Keep branching shallow; one or two levels is usually enough.
- Return an empty array when no completion makes sense.
- Make your fallback usage text match your completion structure.
- If a subcommand needs required data, validate it again in the handler.

## Recommended Structure

A solid command with subcommands usually has:

- `description` showing the top-level grammar
- `getArgumentCompletions()` for first and second argument suggestions
- `handler()` that branches on the first argument
- a fallback usage message for invalid input

Example description:

```typescript
description: "Manage foo items: /foo new|list|delete [name]"
```

## Related Docs

Read these alongside this pattern:

- `~/.gsd/docs/extending-pi/11-custom-commands-user-facing-actions.md`
- `~/.gsd/docs/extending-pi/09-extensionapi-what-you-can-do.md`
- `~/.gsd/agent/extensions/worktree/index.ts`

## Summary

If you want `/foo` to behave like it has nested subcommands, do this:

1. register one slash command
2. treat the first argument as a subcommand
3. implement `getArgumentCompletions(prefix)`
4. optionally complete later arguments dynamically
5. branch in the handler based on the parsed first argument

That is the mechanism behind the `/wt` experience.
