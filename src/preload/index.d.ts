import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  type ChatMessage = { role: 'user' | 'assistant'; content: string }
  type Session = { id: number; title: string }
  type Risk = { level: 'safe' | 'risk'; reason: string }
  type JevStatus = 'inspecting' | Risk['level']
  type ApprovalRequest = { id: string; tool: string; detail: string; risk: Risk }
  type ToolEvent = { id: string; name: string; running: boolean }

  interface Window {
    electron: ElectronAPI
    api: {
      sessions: () => Promise<Session[]>
      history: (sessionId: number) => Promise<ChatMessage[]>
      send: (sessionId: number | null, content: string) => Promise<{ sessionId: number; text: string }>
      onTool: (cb: (event: ToolEvent) => void) => () => void
      onApprove: (cb: (request: ApprovalRequest) => void) => () => void
      approve: (id: string, ok: boolean) => void      /** Resolves to '' on success, otherwise an error message. */
      openPath: (path: string) => Promise<string>
      onJev: (cb: (update: { id: string; status: JevStatus }) => void) => () => void
      onToolOutput: (cb: (output: { id: string; chunk: string }) => void) => () => void
    }
  }
}
