import { homedir } from 'os'
import { join } from 'path'

/**
 * Config directory override via GSD_CONFIG_DIR environment variable.
 * - If set, uses that directory (expands ~ to home directory)
 * - Otherwise defaults to ~/.gsd
 *
 * This allows gsd-dev to use ~/.gsd-dev instead of ~/.gsd
 */
function getConfigRoot(): string {
	const envDir = process.env.GSD_CONFIG_DIR
	if (envDir) {
		if (envDir === '~') return homedir()
		if (envDir.startsWith('~/')) return homedir() + envDir.slice(1)
		return envDir
	}
	return join(homedir(), '.gsd')
}

export const appRoot = getConfigRoot()
export const agentDir = join(appRoot, 'agent')
export const sessionsDir = join(appRoot, 'sessions')
export const authFilePath = join(agentDir, 'auth.json')
