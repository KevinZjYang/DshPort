const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('deepseekHarnessDesktop', {
  openLogFolder: () => ipcRenderer.invoke('open-log-folder'),
  openDataFolder: () => ipcRenderer.invoke('open-data-folder'),
  restartHarness: () => ipcRenderer.invoke('restart-harness'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  showAbout: () => ipcRenderer.invoke('show-about'),
  dataManage: () => ipcRenderer.invoke('data-manage'),
  backupData: () => ipcRenderer.invoke('backup-data'),
  restoreData: () => ipcRenderer.invoke('restore-data'),
  onHarnessUrl: callback => {
    const listener = (_event, url) => callback(url)
    ipcRenderer.on('harness-url', listener)
    return () => ipcRenderer.removeListener('harness-url', listener)
  },
  onAppStatus: callback => {
    const listener = (_event, status) => callback(status)
    ipcRenderer.on('app-status', listener)
    return () => ipcRenderer.removeListener('app-status', listener)
  },
})
