/**
 * Marketplace Discovery Contract Tests
 * 
 * Contract tests that exercise discoverMarketplace against real marketplace repos
 * (../claude_skills and ../claude-plugins-official). These tests validate:
 * - R001: marketplace parsing
 * - R002: path resolution  
 * - R003: manifest inspection
 * 
 * Tests run against real data, not synthetic fixtures.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  parseMarketplaceJson,
  inspectPlugin,
  discoverMarketplace,
  resolvePluginRoot
} from '../resources/extensions/gsd/marketplace-discovery.js';
import { getMarketplaceFixtures } from '../resources/extensions/gsd/tests/marketplace-test-fixtures.js';

const fixtureSetup = getMarketplaceFixtures(import.meta.dirname);
const fixtures = fixtureSetup.fixtures;
const CLAUDE_SKILLS_PATH = fixtures?.claudeSkillsPath;
const CLAUDE_PLUGINS_OFFICIAL_PATH = fixtures?.claudePluginsOfficialPath;

const skipReason = !fixtureSetup.available
  ? fixtureSetup.skipReason ?? 'Marketplace repos not found'
  : undefined;

describe('Marketplace Discovery Contract Tests', { skip: skipReason }, () => {
  describe('claude_skills marketplace (jamie-style)', () => {
    it('should discover at least 15 plugins', () => {
      const result = discoverMarketplace(CLAUDE_SKILLS_PATH!);
      
      assert.strictEqual(result.status, 'ok', `Expected ok status, got error: ${result.error}`);
      assert.ok(result.plugins.length >= 15, 
        `Expected at least 15 plugins, found ${result.plugins.length}`);
    });

    it('should detect jamie-style format', () => {
      const result = discoverMarketplace(CLAUDE_SKILLS_PATH!);
      
      assert.strictEqual(result.pluginFormat, 'jamie-style');
    });

    it('should verify python3-development has skills and agents', () => {
      const result = discoverMarketplace(CLAUDE_SKILLS_PATH!);
      const pythonPlugin = result.plugins.find(p => p.name === 'python3-development');
      
      assert.ok(pythonPlugin, 'python3-development plugin should exist');
      assert.strictEqual(pythonPlugin.status, 'ok', 
        `Plugin should have ok status, got error: ${pythonPlugin.error}`);
      
      // Verify skills inventory
      assert.ok(pythonPlugin.inventory.skills.length > 0,
        `python3-development should have skills, found: ${pythonPlugin.inventory.skills.length}`);
      assert.ok(pythonPlugin.inventory.skills.length >= 10,
        `python3-development should have at least 10 skills, found ${pythonPlugin.inventory.skills.length}`);
      
      // Verify agents inventory
      assert.ok(pythonPlugin.inventory.agents.length > 0,
        `python3-development should have agents, found: ${pythonPlugin.inventory.agents.length}`);
      assert.ok(pythonPlugin.inventory.agents.length >= 5,
        `python3-development should have at least 5 agents, found ${pythonPlugin.inventory.agents.length}`);
    });

    it('should verify all resolved paths exist on disk', () => {
      const result = discoverMarketplace(CLAUDE_SKILLS_PATH!);
      
      // Filter plugins with resolved paths (local plugins, not external)
      const localPlugins = result.plugins.filter(p => p.resolvedPath !== null);
      
      assert.ok(localPlugins.length > 0, 'Should have at least one local plugin');
      
      for (const plugin of localPlugins) {
        assert.ok(fs.existsSync(plugin.resolvedPath!), 
          `Plugin ${plugin.name} resolved path should exist: ${plugin.resolvedPath}`);
      }
    });

    it('should preserve canonical names for known plugins', () => {
      const result = discoverMarketplace(CLAUDE_SKILLS_PATH!);
      const knownPluginNames = [
        'python3-development',
        'bash-development',
        'gitlab-skill',
        'commitlint',
        'conventional-commits',
        'fastmcp-creator'
      ];
      
      for (const expectedName of knownPluginNames) {
        const plugin = result.plugins.find(p => p.name === expectedName);
        assert.ok(plugin, `Plugin ${expectedName} should exist`);
        assert.strictEqual(plugin.canonicalName, expectedName,
          `Canonical name should match for ${expectedName}`);
      }
    });

    it('should have consistent summary counts', () => {
      const result = discoverMarketplace(CLAUDE_SKILLS_PATH!);
      
      assert.strictEqual(result.summary.total, result.plugins.length,
        'Total count should match plugins array length');
      assert.strictEqual(result.summary.ok, 
        result.plugins.filter(p => p.status === 'ok').length,
        'Ok count should match plugins with ok status');
      assert.strictEqual(result.summary.error,
        result.plugins.filter(p => p.status === 'error').length,
        'Error count should match plugins with error status');
    });
  });

  describe('claude-plugins-official marketplace (official-style)', () => {
    it('should discover at least 10 plugins', () => {
      const result = discoverMarketplace(CLAUDE_PLUGINS_OFFICIAL_PATH!);
      
      assert.strictEqual(result.status, 'ok', `Expected ok status, got error: ${result.error}`);
      assert.ok(result.plugins.length >= 10,
        `Expected at least 10 plugins, found ${result.plugins.length}`);
    });

    it('should detect official-style format', () => {
      const result = discoverMarketplace(CLAUDE_PLUGINS_OFFICIAL_PATH!);
      
      assert.strictEqual(result.pluginFormat, 'official-style');
    });

    it('should extract LSP servers from inline marketplace metadata', () => {
      const result = discoverMarketplace(CLAUDE_PLUGINS_OFFICIAL_PATH!);
      
      // TypeScript LSP plugin should have lspServers from marketplace.json
      const tsPlugin = result.plugins.find(p => p.name === 'typescript-lsp');
      assert.ok(tsPlugin, 'typescript-lsp plugin should exist');
      assert.ok(Object.keys(tsPlugin.inventory.lspServers).length > 0,
        'typescript-lsp should have LSP servers from inline metadata');
      assert.ok('typescript' in tsPlugin.inventory.lspServers,
        'typescript-lsp should have typescript LSP server');
      
      // Verify LSP server config structure
      const tsLspConfig = tsPlugin.inventory.lspServers.typescript as { command?: string };
      assert.strictEqual(tsLspConfig.command, 'typescript-language-server',
        'TypeScript LSP should use typescript-language-server command');
    });

    it('should have description from inline metadata', () => {
      const result = discoverMarketplace(CLAUDE_PLUGINS_OFFICIAL_PATH!);
      
      const tsPlugin = result.plugins.find(p => p.name === 'typescript-lsp');
      assert.ok(tsPlugin, 'typescript-lsp plugin should exist');
      assert.ok(tsPlugin.description, 'typescript-lsp should have description');
      assert.ok(tsPlugin.description.includes('TypeScript'),
        'Description should mention TypeScript');
    });

    it('should handle external plugins (URL sources) correctly', () => {
      const result = discoverMarketplace(CLAUDE_PLUGINS_OFFICIAL_PATH!);
      
      // Find plugins with URL sources (external)
      const externalPlugins = result.plugins.filter(p => p.resolvedPath === null);
      
      assert.ok(externalPlugins.length > 0, 
        'Should have at least one external plugin with null resolvedPath');
      
      // External plugins should still have ok status (they're valid, just not local)
      const atlassian = externalPlugins.find(p => p.name === 'atlassian');
      assert.ok(atlassian, 'atlassian plugin should exist as external');
      assert.strictEqual(atlassian.status, 'ok',
        'External plugins should have ok status');
    });

    it('should preserve canonical names for known official plugins', () => {
      const result = discoverMarketplace(CLAUDE_PLUGINS_OFFICIAL_PATH!);
      const knownPluginNames = [
        'typescript-lsp',
        'pyright-lsp',
        'gopls-lsp',
        'rust-analyzer-lsp',
        'feature-dev',
        'pr-review-toolkit'
      ];
      
      for (const expectedName of knownPluginNames) {
        const plugin = result.plugins.find(p => p.name === expectedName);
        assert.ok(plugin, `Plugin ${expectedName} should exist in official marketplace`);
        assert.strictEqual(plugin.canonicalName, expectedName,
          `Canonical name should match for ${expectedName}`);
      }
    });

    it('should extract multiple LSP server types', () => {
      const result = discoverMarketplace(CLAUDE_PLUGINS_OFFICIAL_PATH!);
      
      // Check that multiple LSP plugins have their servers extracted
      const lspPlugins = [
        { name: 'pyright-lsp', server: 'pyright' },
        { name: 'gopls-lsp', server: 'gopls' },
        { name: 'rust-analyzer-lsp', server: 'rust-analyzer' },
        { name: 'clangd-lsp', server: 'clangd' }
      ];
      
      for (const { name, server } of lspPlugins) {
        const plugin = result.plugins.find(p => p.name === name);
        assert.ok(plugin, `${name} plugin should exist`);
        assert.ok(server in plugin.inventory.lspServers,
          `${name} should have ${server} LSP server`);
      }
    });
  });

  describe('resolvePluginRoot', () => {
    it('should resolve relative paths correctly', () => {
      const result = resolvePluginRoot(CLAUDE_SKILLS_PATH!, './plugins/python3-development');
      assert.strictEqual(result, path.join(CLAUDE_SKILLS_PATH!, 'plugins/python3-development'));
    });

    it('should handle paths without ./ prefix', () => {
      const result = resolvePluginRoot(CLAUDE_SKILLS_PATH!, 'plugins/python3-development');
      assert.strictEqual(result, path.join(CLAUDE_SKILLS_PATH!, 'plugins/python3-development'));
    });

    it('should return null for external sources', () => {
      const result = resolvePluginRoot(CLAUDE_SKILLS_PATH!, 'https://github.com/example/plugin');
      assert.strictEqual(result, null);
    });

    it('should return null for git sources', () => {
      const result = resolvePluginRoot(CLAUDE_SKILLS_PATH!, { source: 'github', repo: 'example/plugin' });
      assert.strictEqual(result, null);
    });
  });

  describe('inspectPlugin', () => {
    it('should return error for non-existent plugin directory', () => {
      const result = inspectPlugin('/tmp/nonexistent-plugin');
      assert.strictEqual(result.status, 'error');
      assert.ok(result.error !== undefined, 'error should be defined');
      assert.ok(result.error.includes('not found'));
    });
  });

  describe('Error handling', () => {
    it('should return structured error for non-existent repo path', () => {
      const result = discoverMarketplace('/tmp/nonexistent-marketplace-' + Date.now());
      
      assert.strictEqual(result.status, 'error');
      assert.ok(result.error, 'Error message should be present');
      assert.ok(result.error.includes('not found'),
        `Error should mention 'not found', got: ${result.error}`);
      assert.deepStrictEqual(result.plugins, []);
      assert.strictEqual(result.summary.total, 0);
      assert.strictEqual(result.summary.ok, 0);
      assert.strictEqual(result.summary.error, 0);
    });

    it('should return error for directory without marketplace.json', (t) => {
      // Create a temp directory without marketplace.json
      const tmpDir = '/tmp/test-no-marketplace-' + Date.now();
      fs.mkdirSync(tmpDir, { recursive: true });
      
      t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
      const result = discoverMarketplace(tmpDir);
      
      assert.strictEqual(result.status, 'error');
      assert.ok(result.error, 'Error message should be present');
      assert.ok(result.error.includes('not found'),
        `Error should mention 'not found', got: ${result.error}`);
    });

    it('should return error for malformed marketplace.json', (t) => {
      const tmpDir = '/tmp/test-malformed-marketplace-' + Date.now();
      fs.mkdirSync(tmpDir + '/.claude-plugin', { recursive: true });
      fs.writeFileSync(tmpDir + '/.claude-plugin/marketplace.json', '{ this is not valid json }');
      
      t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
      const result = discoverMarketplace(tmpDir);
      
      assert.strictEqual(result.status, 'error');
      assert.ok(result.error, 'Error message should be present');
      assert.ok(result.error.includes('Failed to parse'),
        `Error should mention 'Failed to parse', got: ${result.error}`);
    });

    it('should return error for marketplace.json missing required fields', (t) => {
      const tmpDir = '/tmp/test-invalid-marketplace-' + Date.now();
      fs.mkdirSync(tmpDir + '/.claude-plugin', { recursive: true });
      // Valid JSON but missing required 'name' and 'plugins' fields
      fs.writeFileSync(tmpDir + '/.claude-plugin/marketplace.json', JSON.stringify({ description: 'test' }));
      
      t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
      const parseResult = parseMarketplaceJson(tmpDir);
      
      assert.strictEqual(parseResult.success, false);
      if (!parseResult.success) {
        assert.ok(parseResult.error.includes('missing'),
          `Error should mention missing field, got: ${parseResult.error}`);
      }
    });

    it('should handle missing plugin directory gracefully', (t) => {
      const tmpDir = '/tmp/test-missing-plugin-' + Date.now();
      fs.mkdirSync(tmpDir + '/.claude-plugin', { recursive: true });
      fs.writeFileSync(tmpDir + '/.claude-plugin/marketplace.json', JSON.stringify({
        name: 'test-marketplace',
        plugins: [
          { name: 'missing-plugin', source: './plugins/nonexistent' }
        ]
      }));
      
      t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
      const result = discoverMarketplace(tmpDir);
      
      // Marketplace should parse ok, but the missing plugin should have error status
      assert.strictEqual(result.status, 'error'); // Because one plugin has error
      
      const missingPlugin = result.plugins.find(p => p.name === 'missing-plugin');
      assert.ok(missingPlugin, 'Missing plugin should be in results');
      assert.strictEqual(missingPlugin.status, 'error');
      assert.ok(missingPlugin.error, 'Missing plugin should have error message');
      assert.ok(missingPlugin.error.includes('not found'),
        `Error should mention 'not found', got: ${missingPlugin.error}`);
    });
  });

  describe('Component inventory accuracy', () => {
    it('should accurately count skills in python3-development', () => {
      const result = discoverMarketplace(CLAUDE_SKILLS_PATH!);
      const pythonPlugin = result.plugins.find(p => p.name === 'python3-development');
      
      assert.ok(pythonPlugin, 'python3-development should exist');
      
      // Verify by directly counting the skills directory
      const skillsDir = path.join(pythonPlugin.resolvedPath!, 'skills');
      if (fs.existsSync(skillsDir)) {
        const actualSkills = fs.readdirSync(skillsDir)
          .filter(item => {
            const itemPath = path.join(skillsDir, item);
            return fs.statSync(itemPath).isDirectory() || item.endsWith('.md');
          });
        
        // Allow for some variance due to filtering differences
        assert.ok(Math.abs(pythonPlugin.inventory.skills.length - actualSkills.length) <= 2,
          `Skills count should be close to actual: reported ${pythonPlugin.inventory.skills.length}, actual ${actualSkills.length}`);
      }
    });

    it('should discover MCP servers from plugin.json', () => {
      const result = discoverMarketplace(CLAUDE_SKILLS_PATH!);
      const pythonPlugin = result.plugins.find(p => p.name === 'python3-development');
      
      assert.ok(pythonPlugin, 'python3-development should exist');
      assert.ok(Object.keys(pythonPlugin.inventory.mcpServers).length > 0,
        'python3-development should have MCP servers from plugin.json');
    });

    it('should include commands in inventory when present', () => {
      const result = discoverMarketplace(CLAUDE_SKILLS_PATH!);
      const pythonPlugin = result.plugins.find(p => p.name === 'python3-development');
      
      assert.ok(pythonPlugin, 'python3-development should exist');
      assert.ok(pythonPlugin.inventory.commands.length > 0,
        'python3-development should have commands');
    });

    it('should detect hooks when present', () => {
      const result = discoverMarketplace(CLAUDE_SKILLS_PATH!);
      
      // Find any plugin with hooks
      const pluginWithHooks = result.plugins.find(p => 
        p.inventory.hooks && p.inventory.hooks.length > 0
      );
      
      // At least some plugins should have hooks
      assert.ok(pluginWithHooks !== undefined, 
        'At least one plugin should have hooks');
    });
  });

  describe('Cross-marketplace consistency', () => {
    it('should return consistent type structure for both marketplaces', () => {
      const jamie = discoverMarketplace(CLAUDE_SKILLS_PATH!);
      const official = discoverMarketplace(CLAUDE_PLUGINS_OFFICIAL_PATH!);
      
      // Both should have the same top-level structure
      const requiredKeys = ['status', 'marketplacePath', 'marketplaceName', 
        'pluginFormat', 'plugins', 'summary'];
      
      for (const key of requiredKeys) {
        assert.ok(key in jamie, `jamie result should have ${key}`);
        assert.ok(key in official, `official result should have ${key}`);
      }
      
      // Both summaries should have same structure
      const summaryKeys = ['total', 'ok', 'error'];
      for (const key of summaryKeys) {
        assert.ok(key in jamie.summary, `jamie summary should have ${key}`);
        assert.ok(key in official.summary, `official summary should have ${key}`);
      }
    });

    it('should return consistent plugin structure', () => {
      const jamie = discoverMarketplace(CLAUDE_SKILLS_PATH!);
      const official = discoverMarketplace(CLAUDE_PLUGINS_OFFICIAL_PATH!);
      
      const jamiePlugin = jamie.plugins[0];
      const officialPlugin = official.plugins[0];
      
      const requiredKeys = ['name', 'canonicalName', 'source', 'resolvedPath', 
        'status', 'manifestSource', 'inventory'];
      
      for (const key of requiredKeys) {
        assert.ok(key in jamiePlugin, `jamie plugin should have ${key}`);
        assert.ok(key in officialPlugin, `official plugin should have ${key}`);
      }
      
      // Inventory structure should be consistent
      const inventoryKeys = ['skills', 'agents', 'commands', 'mcpServers', 'lspServers'];
      for (const key of inventoryKeys) {
        assert.ok(key in jamiePlugin.inventory, `jamie inventory should have ${key}`);
        assert.ok(key in officialPlugin.inventory, `official inventory should have ${key}`);
      }
    });
  });
});
