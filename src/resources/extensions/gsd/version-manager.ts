/**
 * Version Manager — Semver comparison, range matching, and version pinning.
 * No external dependencies.
 */

interface SemverParts { major: number; minor: number; patch: number; prerelease?: string }

/** Parse a semver string into parts */
export function parseSemver(version: string): SemverParts | null {
	const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
	if (!match) return null;
	return {
		major: parseInt(match[1], 10),
		minor: parseInt(match[2], 10),
		patch: parseInt(match[3], 10),
		prerelease: match[4],
	};
}

/** Compare two semver strings. Returns -1, 0, or 1. */
export function compareSemver(a: string, b: string): number {
	const pa = parseSemver(a);
	const pb = parseSemver(b);
	if (!pa || !pb) return 0;

	if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
	if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
	if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;

	// Prerelease versions have lower precedence than release
	if (pa.prerelease && !pb.prerelease) return -1;
	if (!pa.prerelease && pb.prerelease) return 1;
	if (pa.prerelease && pb.prerelease) {
		return pa.prerelease < pb.prerelease ? -1 : pa.prerelease > pb.prerelease ? 1 : 0;
	}

	return 0;
}

/** Check if version satisfies a range (supports ^, ~, >=, >, <=, <, =, exact). */
export function satisfiesRange(version: string, range: string): boolean {
	const v = parseSemver(version);
	if (!v) return false;

	const trimmed = range.trim();

	// Caret range: ^1.2.3 → >=1.2.3 <2.0.0
	if (trimmed.startsWith('^')) {
		const base = parseSemver(trimmed.slice(1));
		if (!base) return false;
		const cmp = compareSemver(version, trimmed.slice(1));
		if (cmp < 0) return false;
		// Must be less than next major
		if (base.major > 0) {
			return v.major === base.major;
		}
		// ^0.x.y — lock on minor
		if (base.minor > 0) {
			return v.major === 0 && v.minor === base.minor;
		}
		// ^0.0.x — exact match
		return v.major === 0 && v.minor === 0 && v.patch === base.patch;
	}

	// Tilde range: ~1.2.3 → >=1.2.3 <1.3.0
	if (trimmed.startsWith('~')) {
		const base = parseSemver(trimmed.slice(1));
		if (!base) return false;
		const cmp = compareSemver(version, trimmed.slice(1));
		if (cmp < 0) return false;
		return v.major === base.major && v.minor === base.minor;
	}

	// Comparison operators
	if (trimmed.startsWith('>=')) {
		const base = trimmed.slice(2).trim();
		return compareSemver(version, base) >= 0;
	}
	if (trimmed.startsWith('>') && !trimmed.startsWith('>=')) {
		const base = trimmed.slice(1).trim();
		return compareSemver(version, base) > 0;
	}
	if (trimmed.startsWith('<=')) {
		const base = trimmed.slice(2).trim();
		return compareSemver(version, base) <= 0;
	}
	if (trimmed.startsWith('<') && !trimmed.startsWith('<=')) {
		const base = trimmed.slice(1).trim();
		return compareSemver(version, base) < 0;
	}
	if (trimmed.startsWith('=')) {
		const base = trimmed.slice(1).trim();
		return compareSemver(version, base) === 0;
	}

	// Exact match
	return compareSemver(version, trimmed) === 0;
}

/** Get the latest version from an array that satisfies a range. */
export function latestSatisfying(versions: string[], range: string): string | undefined {
	const matching = versions.filter(v => satisfiesRange(v, range));
	if (matching.length === 0) return undefined;
	return sortVersions(matching)[matching.length - 1];
}

/** Sort versions in ascending order */
export function sortVersions(versions: string[]): string[] {
	return [...versions].sort(compareSemver);
}
