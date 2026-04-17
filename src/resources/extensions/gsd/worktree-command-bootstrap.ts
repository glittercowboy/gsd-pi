import { type ExtensionAPI, type ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { importExtensionModule } from "@gsd/agent-core";

const WORKTREE_SUBCOMMANDS = [
  { cmd: "list", desc: "List existing worktrees" },
  { cmd: "merge", desc: "Merge a worktree into a target branch" },
  { cmd: "remove", desc: "Remove a worktree and its branch" },
  { cmd: "switch", desc: "Switch into an existing worktree" },
  { cmd: "create", desc: "Create and switch into a new worktree" },
  { cmd: "return", desc: "Switch back to the main tree" },
] as const;

function getWorktreeCompletions(prefix: string) {
  const parts = prefix.trim().split(/\s+/);
  if (parts.length <= 1) {
    const partial = parts[0] ?? "";
    return WORKTREE_SUBCOMMANDS
      .filter((option) => option.cmd.startsWith(partial))
      .map((option) => ({
        value: option.cmd,
        label: option.cmd,
        description: option.desc,
      }));
  }

  if (parts[0] === "remove" && parts.length <= 2 && "all".startsWith(parts[1] ?? "")) {
    return [{ value: "remove all", label: "all", description: "Remove all worktrees" }];
  }

  return null;
}

function registerLazyWorktreeAlias(pi: ExtensionAPI, name: "worktree" | "wt", description: string): void {
  pi.registerCommand(name, {
    description,
    getArgumentCompletions: getWorktreeCompletions,
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const { handleWorktreeCommand } = await importExtensionModule<typeof import("./worktree-command.js")>(import.meta.url, "./worktree-command.js");
      await handleWorktreeCommand(args, ctx, pi, name);
    },
  });
}

export function registerLazyWorktreeCommands(pi: ExtensionAPI): void {
  registerLazyWorktreeAlias(pi, "worktree", "Git worktrees (also /wt): /worktree <name> | list | merge | remove");
  registerLazyWorktreeAlias(pi, "wt", "Alias for /worktree");
}
