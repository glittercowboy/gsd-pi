/**
 * Agent Router — matches task descriptions against routing rules.
 */

export interface RoutingRule {
	when: string;
	agent: string;
	confidence: 'low' | 'medium' | 'high';
}

export interface RoutingResult {
	agent: string;
	confidence: 'low' | 'medium' | 'high';
	score: number;
	matchedRule: RoutingRule;
}

const CONFIDENCE_WEIGHTS: Record<RoutingRule['confidence'], number> = {
	high: 1.0,
	medium: 0.7,
	low: 0.4,
};

export class AgentRouter {
	private rules: RoutingRule[] = [];

	constructor(rules?: RoutingRule[]) {
		if (rules) this.rules = [...rules];
	}

	addRule(rule: RoutingRule): void {
		this.rules.push(rule);
	}

	removeRulesForAgent(agent: string): void {
		this.rules = this.rules.filter((r) => r.agent !== agent);
	}

	route(taskDescription: string): RoutingResult[] {
		const taskLower = taskDescription.toLowerCase();
		const results: RoutingResult[] = [];

		for (const rule of this.rules) {
			const keywords = rule.when
				.split(/\s+/)
				.map((k) => k.toLowerCase())
				.filter(Boolean);

			if (keywords.length === 0) continue;

			const matched = keywords.filter((kw) => taskLower.includes(kw)).length;
			if (matched === 0) continue;

			const ratio = matched / keywords.length;
			const score = ratio * CONFIDENCE_WEIGHTS[rule.confidence];

			results.push({
				agent: rule.agent,
				confidence: rule.confidence,
				score,
				matchedRule: rule,
			});
		}

		results.sort((a, b) => b.score - a.score);
		return results;
	}

	bestMatch(taskDescription: string): RoutingResult | undefined {
		const results = this.route(taskDescription);
		return results.length > 0 ? results[0] : undefined;
	}

	getRules(): RoutingRule[] {
		return [...this.rules];
	}
}

export function getDefaultRules(): RoutingRule[] {
	return [
		{
			when: 'exploring codebase finding files recon reconnaissance structure',
			agent: 'scout',
			confidence: 'high',
		},
		{
			when: 'web research documentation lookup information external',
			agent: 'researcher',
			confidence: 'high',
		},
		{
			when: 'implement feature make changes build create general purpose',
			agent: 'worker',
			confidence: 'medium',
		},
		{
			when: 'javascript JS node nodejs coding patterns',
			agent: 'javascript-pro',
			confidence: 'high',
		},
		{
			when: 'typescript TS types type safety typing generics',
			agent: 'typescript-pro',
			confidence: 'high',
		},
		{
			when: 'review code PR pull request quality audit check',
			agent: 'reviewer',
			confidence: 'high',
		},
		{
			when: 'debug bug error failure crash investigate diagnose',
			agent: 'debugger',
			confidence: 'high',
		},
		{
			when: 'plan breakdown decompose tasks steps architecture design',
			agent: 'planner',
			confidence: 'high',
		},
		{
			when: 'document documentation docs API reference explain',
			agent: 'documenter',
			confidence: 'high',
		},
	];
}
