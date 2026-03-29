import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadFixture, validateFixtureState } from './fixture-harness.js';
import { readMetricsJsonl } from '../metrics-reader.js';
import { randomUUID } from 'node:crypto';

describe('Fixture Harness E2E', () => {
  const fixtureIds = ['low-unknown', 'high-unknown', 'mixed-confidence'];

  for (const fixtureId of fixtureIds) {
    describe(`Fixture: ${fixtureId}`, () => {
      let tmpDir: string;

      beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), `test-fixture-${fixtureId}-${randomUUID()}`));
      });

      afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
      });

      it('should load fixture and validate state integrity', () => {
        const manifest = loadFixture(fixtureId, tmpDir);
        const { valid, missingFiles } = validateFixtureState(manifest, tmpDir);
        
        assert.strictEqual(valid, true, `Fixture state validation failed: missing ${missingFiles.join(', ')}`);
        assert.strictEqual(missingFiles.length, 0);
      });

      it('should have consistent claim mix', () => {
        const manifest = loadFixture(fixtureId, tmpDir);
        
        assert.strictEqual(manifest.claimMix.total, manifest.claims.length, 'Total claims must match claim mix total');
        
        const counts = manifest.claims.reduce((acc, claim) => {
          acc[claim.verdict] = (acc[claim.verdict] || 0) + 1;
          return acc;
        }, {} as Record<string, number>);

        assert.strictEqual(counts.confirmed || 0, manifest.claimMix.confirmed, 'Confirmed count mismatch');
        assert.strictEqual(counts.refuted || 0, manifest.claimMix.refuted, 'Refuted count mismatch');
        assert.strictEqual(counts.inconclusive || 0, manifest.claimMix.inconclusive, 'Inconclusive count mismatch');
        assert.strictEqual(counts.unresolved || 0, manifest.claimMix.unresolved, 'Unresolved count mismatch');
      });

      it('should support synthetic metrics round-trip', () => {
        const manifest = loadFixture(fixtureId, tmpDir);
        const metricsPath = join(tmpDir, 'dispatch-metrics.jsonl');
        
        // Construct a synthetic metric entry based on manifest expected shape
        const syntheticMetric = {
          type: 'UnitMetrics',
          id: 'unit-123',
          factCheck: manifest.expectedTelemetryShape.factCheck,
          interventions: {
             count: manifest.expectedTelemetryShape.interventions.expected ? 1 : 0
          }
        };
        
        writeFileSync(metricsPath, JSON.stringify(syntheticMetric) + '\n');
        
        const result = readMetricsJsonl(metricsPath);
        assert.strictEqual(result.units.length, 1);
        assert.deepStrictEqual(result.units[0].factCheck, manifest.expectedTelemetryShape.factCheck);
      });
    });
  }
});
