/**
 * Bash command interceptor — blocks shell commands that duplicate dedicated tools.
 *
 * Each rule defines a regex pattern, a suggested replacement tool, and a message.
 * A command is only blocked when the suggested tool exists in the session's active tool list.
 */

export interface BashInterceptorRule {
	pattern: string;
	flags?: string;
	tool: string;
	message: string;
}

export const DEFAULT_BASH_INTERCEPTOR_RULES: BashInterceptorRule[] = [
	{
		// cat/head/tail for file viewing — excludes heredoc syntax (cat <<)
		pattern: "^\\s*(cat(?!\\s*<<)|head|tail|less|more)\\s+",
		tool: "read",
		message: "Use the read tool to view file contents instead of shell commands.",
	},
	{
		pattern: "^\\s*(grep|rg|ripgrep|ag|ack)\\s+",
		tool: "grep",
		message: "Use the grep tool for searching file contents instead of shell commands.",
	},
	{
		pattern: "^\\s*(find|fd|locate)\\s+.*(-name|-iname|-type|--type|-glob)",
		tool: "find",
		message: "Use the find tool for locating files by name/type instead of shell commands.",
	},
	{
		pattern: "^\\s*sed\\s+(-i|--in-place)",
		tool: "edit",
		message: "Use the edit tool for in-place file modifications instead of sed.",
	},
	{
		pattern: "^\\s*perl\\s+.*-[pn]?i",
		tool: "edit",
		message: "Use the edit tool for in-place file modifications instead of perl.",
	},
	{
		pattern: "^\\s*awk\\s+.*-i\\s+inplace",
		tool: "edit",
		message: "Use the edit tool for in-place file modifications instead of awk.",
	},
	{
		// echo/printf/heredoc writing to a file via > (not >> append, not 2> stderr redirect)
		// Matches a single > not preceded by |, >, or a digit (fd redirect like 2>)
		pattern: "^\\s*(echo|printf|cat\\s*<<)\\s+.*(?<![|>\\d])>(?!>)\\s*\\S",
		tool: "write",
		message: "Use the write tool to create/overwrite files instead of shell redirects.",
	},
];

export interface InterceptionResult {
	block: boolean;
	message?: string;
	suggestedTool?: string;
}

export interface CompiledInterceptor {
	check: (command: string, availableTools: string[]) => InterceptionResult;
}

/**
 * Compile rules into an interceptor with pre-built regex objects.
 * Silently skips rules with invalid patterns.
 *
 * Pre-compiling at construction time avoids repeated `new RegExp()` calls
 * on every bash command invocation.
 */
export function compileInterceptor(rules: BashInterceptorRule[]): CompiledInterceptor {
	const compiled = rules.flatMap((rule) => {
		try {
			return [{ regex: new RegExp(rule.pattern, rule.flags), rule }];
		} catch {
			return []; // skip invalid regex
		}
	});

	return {
		check(command: string, availableTools: string[]): InterceptionResult {
			const trimmed = command.trim();
			for (const { regex, rule } of compiled) {
				if (regex.test(trimmed) && availableTools.includes(rule.tool)) {
					return {
						block: true,
						message: `Blocked: ${rule.message}\n\nOriginal command: ${command}`,
						suggestedTool: rule.tool,
					};
				}
			}
			return { block: false };
		},
	};
}

/**
 * Check whether a bash command should be intercepted.
 *
 * Compiles rules on each call — prefer `compileInterceptor()` for repeated use.
 *
 * @param command - The shell command to check
 * @param availableTools - Tool names present in the current session
 * @param rules - Override the default rule set (optional)
 */
export function checkBashInterception(
	command: string,
	availableTools: string[],
	rules?: BashInterceptorRule[],
): InterceptionResult {
	const effectiveRules = rules ?? DEFAULT_BASH_INTERCEPTOR_RULES;
	return compileInterceptor(effectiveRules).check(command, availableTools);
}
