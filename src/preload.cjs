const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('deepseekHarnessDesktop', {
  openLogFolder: () => ipcRenderer.invoke('open-log-folder'),
  restartHarness: () => ipcRenderer.invoke('restart-harness'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  showAbout: () => ipcRenderer.invoke('show-about'),
  onHarnessUrl: callback => {
    const listener = (_event, url) => callback(url)
    ipcRenderer.on('harness-url', listener)
    return () => ipcRenderer.removeListener('harness-url', listener)
  },
})
