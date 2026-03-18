import { app, BrowserWindow, ipcMain, nativeImage } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { GsdService } from './gsd-service.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

let mainWindow: BrowserWindow | null = null
let gsdService: GsdService | null = null

function createWindow(): BrowserWindow {
  const preload = join(__dirname, '../preload/index.mjs')

  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#0a0a0a',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 16, y: 16 } : undefined,
    icon: nativeImage.createEmpty(),
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  const rendererUrl = process.env.ELECTRON_RENDERER_URL

  if (rendererUrl) {
    void window.loadURL(rendererUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  window.webContents.once('did-finish-load', () => {
    console.log('[studio] window created')
    console.log('GSD Studio ready')
  })

  return window
}

// =============================================================================
// GsdService singleton — app-scoped, not per-window
// =============================================================================

function createGsdService(): GsdService {
  const service = new GsdService({
    cwd: process.cwd(),
    onEvent: (event) => {
      // Forward to all windows (typically just one, but safe for macOS activate)
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('gsd:event', event)
        }
      }
    },
    onConnectionChange: (connected) => {
      console.log(`[studio] connection changed: ${connected ? 'connected' : 'disconnected'}`)
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('gsd:connection-change', connected)
        }
      }
    },
    onError: (message) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('gsd:stderr', message)
        }
      }
    }
  })
  return service
}

// =============================================================================
// IPC handlers
// =============================================================================

function registerIpcHandlers(service: GsdService): void {
  ipcMain.handle('gsd:spawn', async () => {
    await service.start()
  })

  ipcMain.handle('gsd:send-command', async (_event, command: Record<string, unknown>) => {
    return await service.send(command)
  })

  ipcMain.handle('gsd:status', async () => {
    return { connected: service.isConnected }
  })
}

// =============================================================================
// App lifecycle
// =============================================================================

app.whenReady().then(() => {
  gsdService = createGsdService()
  registerIpcHandlers(gsdService)

  mainWindow = createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  console.log('[studio] before-quit — disposing GsdService')
  gsdService?.dispose()
})
