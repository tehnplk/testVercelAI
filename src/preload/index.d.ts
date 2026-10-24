import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  type ChatMessage = { role: 'user' | 'assistant'; content: string }
  // Token counts are null for sessions from before token counting.
  type Session = {
    id: number
    title: string
    createdAt: Date
    updatedAt: Date
    agentInputTokens: number | null
    agentOutputTokens: number | null
    jevInputTokens: number | null
    jevOutputTokens: number | null
  }
  type UsageUpdate = { sessionId: number } & Pick<
    Session,
    'agentInputTokens' | 'agentOutputTokens' | 'jevInputTokens' | 'jevOutputTokens'
  >
  type Risk ={ level: 'safe' | 'risk'; reason: string }
  type JevStatus = 'inspecting' | Risk['level']
  type ApprovalRequest = { id: string; tool: string; detail: string; risk: Risk }
  type ToolEvent = { id: string; name: string; running: boolean }

  interface Window {
    electron: ElectronAPI
    api: {
      sessions: () => Promise<Session[]>
      deleteSession: (sessionId: number) => Promise<void>
      history: (sessionId: number) => Promise<ChatMessage[]>
      send: (sessionId: number | null, content: string) => Promise<{ sessionId: number; text: string }>
      onTool: (cb: (event: ToolEvent) => void) => () => void
      onApprove: (cb: (request: ApprovalRequest) => void) => () => void
      approve: (id: string, ok: boolean) => void
      /** Resolves to '' on success, otherwise an error message. */
      openPath: (path: string) => Promise<string>
      onJev: (cb: (update: { id: string; status: JevStatus }) => void) => () => void
      onToolOutput: (cb: (output: { id: string; chunk: string }) => void) => () => void
      /** New token totals of a session, sent after every agent step and Jev call. */
      onUsage: (cb: (usage: UsageUpdate) => void) => () => void
    }
  }
}
