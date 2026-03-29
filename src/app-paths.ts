import { homedir } from 'os'
import { join } from 'path'

export const appRoot = process.env.GSD_HOME || join(homedir(), '.gsd')
export const agentDir = join(appRoot, 'agent')
export const sessionsDir = join(appRoot, 'sessions')
export const authFilePath = join(agentDir, 'auth.json')
export const webPidFilePath = join(appRoot, 'web-server.pid')
export const webPreferencesPath = join(appRoot, 'web-preferences.json')
export const webAuthPath = join(appRoot, 'web-auth.json')
