import { app, BrowserWindow, powerMonitor } from 'electron'
import { enable, initialize } from '@electron/remote/main/index.js' // <-- add this
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import enableAutoLaunch from 'app/src-electron/auto-launch.js'
import log from 'electron-log/main' // <-- add this

// ---- Logging setup ----
log.initialize() // captura también los console.log del renderer
log.transports.file.level = 'debug'
log.transports.console.level = 'debug'
log.errorHandler.startCatching() // captura excepciones no controladas automáticamente

log.info('=== App arrancando ===')
log.info('Plataforma:', process.platform, process.arch)
log.info('Modo DEV:', !!process.env.DEV)
log.info('Ruta de logs:', log.transports.file.getFile().path)
// ------------------------

initialize() // <-- add this

// needed in case process is undefined under Linux
const platform = process.platform || os.platform()

const currentDir = fileURLToPath(new URL('.', import.meta.url))

let mainWindow

function createWindow() {
  log.info('Creando ventana principal...')

  /**
   * Initial window options
   */
  mainWindow = new BrowserWindow({
    icon: path.resolve(currentDir, 'icons/icon.png'), // tray icon
    width: 215,
    height: 145,
    // width: 620,
    // height: 480,
    frame: false,
    useContentSize: true,
    autoHideMenuBar: true,
    resizable: false,
    transparent: true,
    maximizable: false,
    webPreferences: {
      sandbox: false,
      contextIsolation: true,
      // More info: https://v2.quasar.dev/quasar-cli-vite/developing-electron-apps/electron-preload-script
      preload: path.resolve(
        currentDir,
        path.join(
          process.env.QUASAR_ELECTRON_PRELOAD_FOLDER,
          'electron-preload' + process.env.QUASAR_ELECTRON_PRELOAD_EXTENSION,
        ),
      ),
    },
  })

  enable(mainWindow.webContents) // <-- add this

  // ---- Captura logs del renderer (console.log de tu Vue) ----
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    log.info(`[Renderer] ${message} (${sourceId}:${line})`)
  })

  // ---- Captura si la página falla al cargar ----
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    log.error(`Fallo al cargar la página: ${errorCode} - ${errorDescription}`)
  })

  // ---- Captura si el renderer crashea ----
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    log.error('El renderer ha crasheado:', details)
  })
  // -------------------------------------------------------------

  if (process.env.DEV) {
    log.info('Cargando URL de desarrollo:', process.env.APP_URL)
    mainWindow.loadURL(process.env.APP_URL)
  } else {
    log.info('Cargando index.html de producción')
    mainWindow.loadFile('index.html')
  }

  if (process.env.DEBUGGING) {
    // if on DEV or Production with debug enabled
    mainWindow.webContents.openDevTools()
  } else {
    // we're on production; no access to devtools pls
    mainWindow.webContents.on('devtools-opened', () => {
      mainWindow.webContents.closeDevTools()
    })
  }

  mainWindow.on('closed', () => {
    log.info('Ventana principal cerrada')
    mainWindow = null
  })
}

// autostart app by defaults using native electron
// if (process.env.NODE_ENV === 'production') {
//   app.setLoginItemSettings({
//     openAtLogin: true,
//     path: app.getPath('exe'),
//   })
//
//   // enableLinuxAutoStart()
// }

enableAutoLaunch()

function notifyRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

function setupLifecycleHooks() {
  powerMonitor.on('resume', () => {
    log.info('Sistema reanudado (powerMonitor resume) — notificando renderer')
    notifyRenderer('power:resume')
  })

  powerMonitor.on('unlock-screen', () => {
    log.info('Pantalla desbloqueada — notificando renderer')
    notifyRenderer('power:resume')
  })

  // Chromium network status in the main process is not always available;
  // renderer also listens to window 'online'. Forward when possible.
  if (typeof powerMonitor.on === 'function') {
    log.info('Hooks de powerMonitor registrados (resume / unlock-screen)')
  }
}

app.whenReady().then(() => {
  log.info('App lista (whenReady)')
  createWindow()
  setupLifecycleHooks()
})

app.on('window-all-closed', () => {
  log.info('Todas las ventanas cerradas')
  if (platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow()
  }
})