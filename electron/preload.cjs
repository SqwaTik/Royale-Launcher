const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('royaleApi', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (payload) => ipcRenderer.invoke('settings:save', payload),
  checkLauncherUpdate: () => ipcRenderer.invoke('launcher:check-update'),
  pickFolder: () => ipcRenderer.invoke('dialog:pick-folder'),
  openFolder: (targetPath) => ipcRenderer.invoke('shell:open-folder', targetPath),
  openExternal: (targetUrl) => ipcRenderer.invoke('shell:open-external', targetUrl),
  getVersionState: (versionName) => ipcRenderer.invoke('version:get-state', versionName),
  installVersion: (versionName) => ipcRenderer.invoke('version:install', versionName),
  launchVersion: (versionName) => ipcRenderer.invoke('version:launch', versionName),
  windowAction: (action) => ipcRenderer.invoke('window:action', action),
  onInstallProgress: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('install:progress', listener)
    return () => ipcRenderer.removeListener('install:progress', listener)
  },
  onInstallStatus: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('install:status', listener)
    return () => ipcRenderer.removeListener('install:status', listener)
  }
})
