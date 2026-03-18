/**
 * TTSR Rule Loader
 *
 * Scans global (~/.gsd/agent/rules/*.md) and project-local (.gsd/rules/*.md)
 * rule files. Parses YAML frontmatter for condition, scope, globs.
 * Project rules override global rules with the same name.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import type { Rule } from "./ttsr-manager.js";
import { splitFrontmatter, parseFrontmatterMap } from "../shared/frontmatter.js";

function parseRuleFile(filePath: string): Rule | null {
	let content: string;
	try {
		content = readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}

	const [fmLines, body] = splitFrontmatter(content);
	if (!fmLines) return null;

	const meta = parseFrontmatterMap(fmLines);

	const condition = meta.condition;
	if (!Array.isArray(condition) || condition.length === 0) return null;

	const name = basename(filePath, ".md");

	return {
		name,
		path: filePath,
		content: body.trim(),
		condition: condition as string[],
		scope: Array.isArray(meta.scope) ? (meta.scope as string[]) : undefined,
		globs: Array.isArray(meta.globs) ? (meta.globs as string[]) : undefined,
	};
}

function scanDir(dir: string): Rule[] {
	if (!existsSync(dir)) return [];
	const rules: Rule[] = [];
	try {
		const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
		for (const file of files) {
			const rule = parseRuleFile(join(dir, file));
			if (rule) rules.push(rule);
		}
	} catch {
		// Directory unreadable — skip
	}
	return rules;
}

/**
 * Load all TTSR rules from global and project-local directories.
 * Project rules override global rules with the same name.
 */
export function loadRules(cwd: string): Rule[] {
	const globalDir = join(homedir(), ".gsd", "agent", "rules");
	const projectDir = join(cwd, ".gsd", "rules");

	const globalRules = scanDir(globalDir);
	const projectRules = scanDir(projectDir);

	// Merge: project rules override global by name
	const byName = new Map<string, Rule>();
	for (const rule of globalRules) byName.set(rule.name, rule);
	for (const rule of projectRules) byName.set(rule.name, rule);

	return Array.from(byName.values());
}
