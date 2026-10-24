import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const api = {
  sessions: () => ipcRenderer.invoke('sessions:list'),
  history: (sessionId: number) => ipcRenderer.invoke('chat:history', sessionId),
  send: (sessionId: number | null, content: string) => ipcRenderer.invoke('chat:send', sessionId, content),
  onTool: (cb: (event: { id: string; name: string; running: boolean }) => void) => {
    const listener = (_: unknown, event: { id: string; name: string; running: boolean }): void => cb(event)
    ipcRenderer.on('chat:tool', listener)
    return () => ipcRenderer.off('chat:tool', listener)
  },
  onApprove: (cb: (request: { id: string; tool: string; detail: string }) => void) => {
    const listener = (_: unknown, request: { id: string; tool: string; detail: string }): void => cb(request)
    ipcRenderer.on('chat:approve', listener)
    return () => ipcRenderer.off('chat:approve', listener)
  },
  approve: (id: string, ok: boolean) => ipcRenderer.send('chat:approval', id, ok),
  openPath: (path: string) => ipcRenderer.invoke('file:open', path),
  onJev: (cb: (update: { id: string; status: 'inspecting' | 'safe' | 'risk' }) => void) => {
    const listener = (_: unknown, update: { id: string; status: 'inspecting' | 'safe' | 'risk' }): void => cb(update)
    ipcRenderer.on('chat:jev', listener)
    return () => ipcRenderer.off('chat:jev', listener)
  },
  onToolOutput: (cb: (output: { id: string; chunk: string }) => void) => {
    const listener = (_: unknown, output: { id: string; chunk: string }): void => cb(output)
    ipcRenderer.on('chat:tool-output', listener)
    return () => ipcRenderer.off('chat:tool-output', listener)
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
