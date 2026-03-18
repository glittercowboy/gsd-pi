import { contextBridge, ipcRenderer } from 'electron'

export type StudioStatus = {
  connected: boolean
}

export type StudioBridge = {
  /** Subscribe to agent events. Returns cleanup function. */
  onEvent: (callback: (event: unknown) => void) => () => void
  /** Subscribe to connection state changes. Returns cleanup function. */
  onConnectionChange: (callback: (connected: boolean) => void) => () => void
  /** Subscribe to stderr output from the agent. Returns cleanup function. */
  onStderr: (callback: (message: string) => void) => () => void
  /** Send a command to the agent. Returns the RPC response. */
  sendCommand: (command: Record<string, unknown>) => Promise<unknown>
  /** Spawn the gsd agent subprocess. */
  spawn: () => Promise<void>
  /** Get current connection status. */
  getStatus: () => Promise<StudioStatus>
}

const studio: StudioBridge = {
  onEvent: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown): void => {
      callback(data)
    }
    ipcRenderer.on('gsd:event', handler)
    return () => {
      ipcRenderer.removeListener('gsd:event', handler)
    }
  },

  onConnectionChange: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, connected: boolean): void => {
      callback(connected)
    }
    ipcRenderer.on('gsd:connection-change', handler)
    return () => {
      ipcRenderer.removeListener('gsd:connection-change', handler)
    }
  },

  onStderr: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, message: string): void => {
      callback(message)
    }
    ipcRenderer.on('gsd:stderr', handler)
    return () => {
      ipcRenderer.removeListener('gsd:stderr', handler)
    }
  },

  sendCommand: (command) => {
    return ipcRenderer.invoke('gsd:send-command', command)
  },

  spawn: () => {
    return ipcRenderer.invoke('gsd:spawn')
  },

  getStatus: () => {
    return ipcRenderer.invoke('gsd:status')
  }
}

console.log('[studio] preload loaded')
contextBridge.exposeInMainWorld('studio', studio)
