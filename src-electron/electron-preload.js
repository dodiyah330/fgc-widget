/**
 * This file is used specifically for security reasons.
 * Here you can access Nodejs stuff and inject functionality into
 * the renderer thread (accessible there through the "window" object)
 *
 * WARNING!
 * If you import anything from node_modules, then make sure that the package is specified
 * in package.json > dependencies and NOT in devDependencies
 *
 * WARNING!
 * If accessing Node functionality (like importing @electron/remote) then in your
 * electron-main.js you will need to set the following when you instantiate BrowserWindow:
 *
 * mainWindow = new BrowserWindow({
 *   // ...
 *   webPreferences: {
 *     // ...
 *     sandbox: false // <-- to be able to import @electron/remote in preload script
 *   }
 * }
 */
import { contextBridge, shell, ipcRenderer } from 'electron'
import { app } from '@electron/remote'
import { join } from 'path'

const URL = 'https://incivisme.fgc.cat'
// const URL_DEV = 'https://incivisme-alertes.informagedevelop.com'

function subscribe(channel, callback) {
  const handler = (_event, ...args) => callback(...args)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('myAPI', {
  openLink: () => {
    return shell.openExternal(URL)
  },
  audioFile: app.isPackaged
    ? join(process.resourcesPath, 'assets', 'audio', 'bells.wav')
    : 'src/assets/audio/bells.wav',
  onPowerResume: (callback) => subscribe('power:resume', callback),
  onNetworkChange: (callback) => subscribe('network:status', callback),
})
