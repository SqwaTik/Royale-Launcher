const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('royaleApi', {
  getBootstrap: () => ipcRenderer.invoke('launcher:get-bootstrap'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (payload) => ipcRenderer.invoke('settings:save', payload),
  getMemoryProfile: () => ipcRenderer.invoke('system:get-memory-profile'),
  getStorageInfo: (targetPath) => ipcRenderer.invoke('system:get-storage-info', targetPath),
  checkLauncherUpdate: () => ipcRenderer.invoke('launcher:check-update'),
  installLauncherUpdate: () => ipcRenderer.invoke('launcher:install-update'),
  pickFolder: () => ipcRenderer.invoke('dialog:pick-folder'),
  openFolder: (targetPath) => ipcRenderer.invoke('shell:open-folder', targetPath),
  openExternal: (targetUrl) => ipcRenderer.invoke('shell:open-external', targetUrl),
  getStatsDashboard: (versionName) => ipcRenderer.invoke('stats:get-dashboard', versionName),
  getVersionState: (versionName) => ipcRenderer.invoke('version:get-state', versionName),
  getJavaStatus: (versionName) => ipcRenderer.invoke('java:get-status', versionName),
  installJava: (versionName) => ipcRenderer.invoke('java:install', versionName),
  installVersion: (versionName) => ipcRenderer.invoke('version:install', versionName),
  pauseInstall: (paused) => ipcRenderer.invoke('version:pause-install', paused),
  cancelInstall: () => ipcRenderer.invoke('version:cancel-install'),
  launchVersion: (versionName) => ipcRenderer.invoke('version:launch', versionName),
  cancelLaunch: () => ipcRenderer.invoke('version:cancel-launch'),
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
  },
  onLaunchStatus: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('launch:status', listener)
    return () => ipcRenderer.removeListener('launch:status', listener)
  },
  onJavaInstallProgress: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('java-install:progress', listener)
    return () => ipcRenderer.removeListener('java-install:progress', listener)
  },
  onJavaInstallStatus: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('java-install:status', listener)
    return () => ipcRenderer.removeListener('java-install:status', listener)
  }
})
