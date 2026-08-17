const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshPicker', {
  getOptions: () => ipcRenderer.invoke('picker-get-options'),
  submit: result => ipcRenderer.invoke('picker-submit', result),
})
