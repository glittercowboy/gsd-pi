declare module "proper-lockfile" {
	export interface RetryOptions {
		retries?: number;
		factor?: number;
		minTimeout?: number;
		maxTimeout?: number;
		randomize?: boolean;
	}

	export interface LockOptions {
		realpath?: boolean;
		retries?: number | RetryOptions;
		stale?: number;
		onCompromised?: (err: Error) => void;
	}

	export type ReleaseSync = () => void;
	export type ReleaseAsync = () => Promise<void>;

	export interface ProperLockfileApi {
		lockSync(path: string, options?: LockOptions): ReleaseSync;
		lock(path: string, options?: LockOptions): Promise<ReleaseAsync>;
	}

	const lockfile: ProperLockfileApi;
	export default lockfile;
}

declare module "sql.js" {
	export interface Statement {
		bind(values: (string | number | null | Uint8Array)[]): void;
		step(): boolean;
		getAsObject(): Record<string, unknown>;
		free(): void;
	}

	export interface Database {
		run(sql: string, params?: unknown[]): void;
		prepare(sql: string): Statement;
		export(): Uint8Array;
		close(): void;
	}

	export interface SqlJsStatic {
		Database: new (data?: Uint8Array | ArrayBuffer | Buffer) => Database;
	}

	export interface SqlJsConfig {
		locateFile?: (file: string) => string;
	}

	export default function initSqlJs(config?: SqlJsConfig): Promise<SqlJsStatic>;
}

declare module "hosted-git-info" {
	export interface HostedGitInfo {
		domain?: string;
		user?: string;
		project?: string;
		committish?: string;
	}

	export interface HostedGitInfoApi {
		fromUrl(url: string): HostedGitInfo | undefined;
	}

	const hostedGitInfo: HostedGitInfoApi;
	export default hostedGitInfo;
}
