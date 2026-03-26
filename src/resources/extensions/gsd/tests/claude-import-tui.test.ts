/**
 * TUI Command Flow Tests for import-claude
 *
 * Tests R015: validates the TUI command flow for /gsd prefs import-claude.
 * These tests currently use mock UI, and marketplace availability is still
 * derived from real/local marketplace roots. Follow-up work should route these
 * through portable marketplace fixtures that mirror Claude Code's
 * `/plugin marketplace add ...` source model.
 */

import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionCommandContext } from '@gsd/pi-coding-agent';
import { runClaudeImportFlow, getClaudeSearchRoots, discoverClaudeSkills, discoverClaudePlugins } from '../claude-import.js';
import { getMarketplaceFixtures } from './marketplace-test-fixtures.js';

// ============================================================================
// Test Configuration
// ============================================================================

const fixtureSetup = getMarketplaceFixtures(import.meta.dirname);
const fixtures = fixtureSetup.fixtures;
const CLAUDE_SKILLS_PATH = fixtures?.claudeSkillsPath;
const CLAUDE_PLUGINS_OFFICIAL_PATH = fixtures?.claudePluginsOfficialPath;

function marketplacesAvailable(): boolean {
	return Boolean(fixtures);
}

// ============================================================================
// Mock UI Context
// ============================================================================

interface MockUISelectCall {
	prompt: string;
	options: string[];
}

function createMockContext(selections: string[]): {
	ctx: ExtensionCommandContext;
	selectCalls: MockUISelectCall[];
} {
	const selectCalls: MockUISelectCall[] = [];

	const selectMock = mock.fn(async (prompt: string, options: string[]) => {
		selectCalls.push({ prompt, options });
		const next = selections.shift();
		if (next && options.includes(next)) {
			return next;
		}
		// Default: cancel or first option
		return options.find(o => o.toLowerCase().includes('cancel')) || options[0];
	});

	const notifyMock = mock.fn();

	// Create a mock that satisfies ExtensionCommandContext
	// Using type assertion since we only use select, notify, waitForIdle, reload in the tests
	const ctx = {
		ui: {
			select: selectMock,
			notify: notifyMock,
			confirm: async () => false,
			input: async () => undefined,
			onTerminalInput: () => () => {},
			setStatus: () => {},
			setWorkingMessage: () => {},
			setWidget: () => {},
			setFooter: () => {},
			setHeader: () => {},
			setTitle: () => {},
			custom: async () => { throw new Error('Not implemented'); },
			pasteToEditor: () => {},
			setEditorText: () => {},
			getEditorText: () => '',
			editor: async () => undefined,
			setEditorComponent: () => {},
			theme: {},
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: false }),
			getToolsExpanded: () => true,
			setToolsExpanded: () => {},
		},
		hasUI: true,
		cwd: process.cwd(),
		sessionManager: {} as unknown,
		modelRegistry: {} as unknown,
		model: undefined,
		isIdle: () => true,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => '',
		waitForIdle: mock.fn(async () => {}),
		newSession: async () => ({ cancelled: false }),
		fork: async () => ({ cancelled: false }),
		navigateTree: async () => ({ cancelled: false }),
		switchSession: async () => ({ cancelled: false }),
		reload: mock.fn(async () => {}),
	} as unknown as ExtensionCommandContext;

	return { ctx, selectCalls };
}

// ============================================================================
// Tests
// ============================================================================

const skipReason = !marketplacesAvailable()
	? fixtureSetup.skipReason ?? 'Marketplace repos not found for TUI testing'
	: undefined;

describe(
	'TUI Command Flow Tests',
	{ skip: skipReason },
	() => {
		let tempDir: string;
		let prefsPath: string;
		let prefs: Record<string, unknown>;

		before(() => {
			tempDir = mkdtempSync(join(tmpdir(), 'gsd-tui-test-'));
			prefsPath = join(tempDir, 'PREFERENCES.md');
			prefs = { version: 1 };
		});

		after(() => {
			fixtures?.cleanup();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		describe('getClaudeSearchRoots()', () => {
			it('should return existing skill and plugin roots', () => {
				const cwd = process.cwd();
				const { skillRoots, pluginRoots } = getClaudeSearchRoots(cwd);

				// At least one root should exist in our test environment
				assert.ok(
					skillRoots.length > 0 || pluginRoots.length > 0,
					'Should find at least one search root'
				);

				// All returned roots should exist
				for (const root of [...skillRoots, ...pluginRoots]) {
					assert.ok(existsSync(root), `Root should exist: ${root}`);
				}
			});
		});

		describe('discoverClaudeSkills()', () => {
			it('should discover skills without crashing', () => {
				const cwd = process.cwd();
				const skills = discoverClaudeSkills(cwd);

				assert.ok(Array.isArray(skills), 'Should return an array');

				// Log for observability
				console.log(`\nDiscovered ${skills.length} skills`);

				if (skills.length > 0) {
					console.log('Sample skills:');
					skills.slice(0, 3).forEach(s => {
						console.log(`  - ${s.name} (${s.sourceLabel})`);
					});

					// Verify structure
					const sample = skills[0]!;
					assert.ok(sample.name, 'Skill should have name');
					assert.ok(sample.path, 'Skill should have path');
					assert.ok(sample.root, 'Skill should have root');
					assert.strictEqual(sample.type, 'skill');
				}
			});
		});

		describe('discoverClaudePlugins()', () => {
			it('should discover plugins without crashing', () => {
				const cwd = process.cwd();
				const plugins = discoverClaudePlugins(cwd);

				assert.ok(Array.isArray(plugins), 'Should return an array');

				// Log for observability
				console.log(`\nDiscovered ${plugins.length} plugins`);

				if (plugins.length > 0) {
					console.log('Sample plugins:');
					plugins.slice(0, 3).forEach(p => {
						console.log(`  - ${p.name} (${p.sourceLabel})`);
					});

					// Verify structure
					const sample = plugins[0]!;
					assert.ok(sample.name, 'Plugin should have name');
					assert.ok(sample.path, 'Plugin should have path');
					assert.strictEqual(sample.type, 'plugin');
				}
			});
		});

		describe('runClaudeImportFlow()', () => {
			it('should not crash when user cancels at first prompt', async () => {
				const { ctx, selectCalls } = createMockContext(['Cancel']);

				const readPrefs = () => ({ ...prefs });
				const writePrefs = async (p: Record<string, unknown>) => {
					Object.assign(prefs, p);
				};

				// Should complete without throwing
				await runClaudeImportFlow(ctx, 'global', readPrefs, writePrefs);

				// Should have asked about asset type
				assert.ok(selectCalls.length >= 1, 'Should have at least one select call');
				assert.ok(
					selectCalls[0]!.prompt.includes('Import Claude assets'),
					'First prompt should be about asset selection'
				);
			});

			it('should not crash when selecting skills only with cancel at next step', async () => {
				const { ctx, selectCalls } = createMockContext([
					'Skills only',    // Select skills only
					'Cancel',         // Cancel at skill selection
				]);

				const readPrefs = () => ({ ...prefs });
				const writePrefs = async (p: Record<string, unknown>) => {
					Object.assign(prefs, p);
				};

				// Should complete without throwing
				await runClaudeImportFlow(ctx, 'global', readPrefs, writePrefs);

				// Log interaction flow
				console.log('\nSelect calls made:');
				selectCalls.forEach((call, i) => {
					console.log(`  ${i + 1}. "${call.prompt}"`);
				});
			});

			it('should handle marketplace flow when user selects plugins', async () => {
				const { ctx, selectCalls } = createMockContext([
					'Plugins only',                     // Select plugins only
					'Yes - discover plugins and select components',  // Marketplace prompt
					'Cancel',                           // Cancel at component selection
				]);

				const readPrefs = () => ({ ...prefs });
				const writePrefs = async (p: Record<string, unknown>) => {
					Object.assign(prefs, p);
				};

				// Should complete without throwing
				await runClaudeImportFlow(ctx, 'global', readPrefs, writePrefs);

				// Log interaction flow
				console.log('\nMarketplace flow select calls:');
				selectCalls.forEach((call, i) => {
					console.log(`  ${i + 1}. "${call.prompt}"`);
				});
			});

			it('should complete import-all flow with mock UI', async () => {
				// This tests the happy path where user selects "Import all"
				const { ctx, selectCalls } = createMockContext([
					'Skills + plugins',                 // Select both
					'Cancel',                           // Cancel at skill selection (no skills to import)
					'Yes - discover plugins and select components',  // Marketplace prompt
					'Import all components',            // Import all
					'Yes, continue',                    // Continue with warnings (if any)
				]);

				const readPrefs = () => ({ ...prefs });
				const writePrefs = async (p: Record<string, unknown>) => {
					Object.assign(prefs, p);
				};

				// Should complete without throwing
				await runClaudeImportFlow(ctx, 'global', readPrefs, writePrefs);

				// Log interaction flow
				console.log('\nImport-all flow select calls:');
				selectCalls.forEach((call, i) => {
					console.log(`  ${i + 1}. "${call.prompt}"`);
				});

				// Verify notification was called
				const notifyCalls = (ctx.ui.notify as unknown as ReturnType<typeof mock.fn>).mock.calls;
				assert.ok(notifyCalls.length > 0, 'Should have shown notification');

				console.log('\nNotifications shown:');
				notifyCalls.forEach((call, i) => {
					const msg = call.arguments[0];
					const level = call.arguments[1];
					console.log(`  ${i + 1}. [${level}]: ${String(msg).split('\n')[0]}`);
				});
			});

			it('should not persist marketplace agent directories into package sources', async (t) => {
				const isolatedAgentDir = join(tempDir, '.gsd', 'agent');
				const settingsPath = join(isolatedAgentDir, 'settings.json');
				rmSync(isolatedAgentDir, { recursive: true, force: true });
				process.env.GSD_CODING_AGENT_DIR = isolatedAgentDir;

				t.after(() => {
					delete process.env.GSD_CODING_AGENT_DIR;
					rmSync(isolatedAgentDir, { recursive: true, force: true });
				});

				mkdirSync(isolatedAgentDir, { recursive: true });
				const tempSettings: Record<string, unknown> = { packages: [] };
				writeFileSync(settingsPath, JSON.stringify(tempSettings, null, 2));

				const { ctx } = createMockContext([
					'Plugins only',
					'Yes - discover plugins and select components',
					'Import all components',
					'Yes, continue',
				]);

				const readPrefs = () => ({ ...prefs });
				const writePrefs = async (p: Record<string, unknown>) => {
					Object.assign(prefs, p);
				};

				await runClaudeImportFlow(ctx, 'global', readPrefs, writePrefs);

				const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { packages?: unknown[] };
				const packageEntries = Array.isArray(settings.packages) ? settings.packages : [];
				const hasAgentsDirPackage = packageEntries.some((entry) => {
					const source = typeof entry === 'string'
						? entry
						: (entry && typeof entry === 'object' ? (entry as { source?: unknown }).source : undefined);
					return typeof source === 'string' && source.endsWith('/agents');
				});

				assert.strictEqual(hasAgentsDirPackage, false, 'Marketplace agent directories should not be persisted as package sources');
			});
		});
	}
);
