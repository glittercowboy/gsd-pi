/**
 * Agent telemetry — tracks invocation history and computes metrics.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface AgentInvocation {
	agentName: string;
	timestamp: string;
	taskSummary: string;
	success: boolean;
	turns: number;
	inputTokens: number;
	outputTokens: number;
	cost: number;
	durationMs: number;
	model?: string;
}

export interface AgentMetrics {
	agentName: string;
	totalInvocations: number;
	successRate: number;
	avgTurns: number;
	avgCost: number;
	avgDurationMs: number;
	lastUsed: string | null;
	trend: 'improving' | 'stable' | 'declining';
}

export class AgentTelemetry {
	private storePath: string;

	constructor(storePath?: string) {
		this.storePath = storePath ?? path.join(os.homedir(), '.gsd', 'agent-telemetry.jsonl');
	}

	record(invocation: AgentInvocation): void {
		const dir = path.dirname(this.storePath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		const line = JSON.stringify(invocation) + '\n';
		fs.appendFileSync(this.storePath, line, 'utf-8');
	}

	private readAll(): AgentInvocation[] {
		if (!fs.existsSync(this.storePath)) return [];
		const content = fs.readFileSync(this.storePath, 'utf-8');
		const lines = content.split('\n').filter((l) => l.trim().length > 0);
		const results: AgentInvocation[] = [];
		for (const line of lines) {
			try {
				results.push(JSON.parse(line) as AgentInvocation);
			} catch {
				// skip malformed lines
			}
		}
		return results;
	}

	private filterByWindow(invocations: AgentInvocation[], windowDays?: number): AgentInvocation[] {
		if (!windowDays) return invocations;
		const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
		return invocations.filter((inv) => new Date(inv.timestamp).getTime() >= cutoff);
	}

	private computeTrend(invocations: AgentInvocation[]): 'improving' | 'stable' | 'declining' {
		if (invocations.length < 6) return 'stable';

		const recent = invocations.slice(-5);
		const previous = invocations.slice(-10, -5);

		if (previous.length === 0) return 'stable';

		const recentRate = recent.filter((i) => i.success).length / recent.length;
		const previousRate = previous.filter((i) => i.success).length / previous.length;

		const diff = recentRate - previousRate;
		if (diff > 0.1) return 'improving';
		if (diff < -0.1) return 'declining';
		return 'stable';
	}

	getMetrics(agentName: string, windowDays?: number): AgentMetrics {
		const all = this.readAll().filter((i) => i.agentName === agentName);
		const filtered = this.filterByWindow(all, windowDays);

		if (filtered.length === 0) {
			return {
				agentName,
				totalInvocations: 0,
				successRate: 0,
				avgTurns: 0,
				avgCost: 0,
				avgDurationMs: 0,
				lastUsed: null,
				trend: 'stable',
			};
		}

		const successes = filtered.filter((i) => i.success).length;
		const totalTurns = filtered.reduce((s, i) => s + i.turns, 0);
		const totalCost = filtered.reduce((s, i) => s + i.cost, 0);
		const totalDuration = filtered.reduce((s, i) => s + i.durationMs, 0);

		// Sort by timestamp to find last used and for trend
		const sorted = [...filtered].sort(
			(a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
		);

		return {
			agentName,
			totalInvocations: filtered.length,
			successRate: successes / filtered.length,
			avgTurns: totalTurns / filtered.length,
			avgCost: totalCost / filtered.length,
			avgDurationMs: totalDuration / filtered.length,
			lastUsed: sorted[sorted.length - 1].timestamp,
			trend: this.computeTrend(sorted),
		};
	}

	getAllMetrics(windowDays?: number): AgentMetrics[] {
		const all = this.readAll();
		const agents = new Set(all.map((i) => i.agentName));
		return Array.from(agents).map((name) => this.getMetrics(name, windowDays));
	}

	getHistory(agentName: string, limit?: number): AgentInvocation[] {
		const all = this.readAll().filter((i) => i.agentName === agentName);
		const sorted = all.sort(
			(a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
		);
		return limit ? sorted.slice(0, limit) : sorted;
	}
}
