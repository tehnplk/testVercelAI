import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  // Same as ChatMessage in src/main/llm_memory.ts.
  type ToolCall = { name: string; input: string; output: string; files: string[]; console: string }
  type ChatMessage = {
    role: 'user' | 'assistant'
    content: string
    turn?: { skills: string[]; tools: ToolCall[] }
  }
  // Token counts are null for sessions from before token counting.
  type Session = {
    id: number
    title: string
    pinned: boolean
    createdAt: Date
    updatedAt: Date
    agentInputTokens: number | null
    agentOutputTokens: number | null
    guardInputTokens: number | null
    guardOutputTokens: number | null
  }
  type UsageUpdate = { sessionId: number } & Pick<
    Session,
    'agentInputTokens' | 'agentOutputTokens' | 'guardInputTokens' | 'guardOutputTokens'
  >
  type Risk ={ level: 'safe' | 'risk'; reason: string }
  type JevStatus = 'inspecting' | Risk['level']
  type ApprovalRequest = { id: string; tool: string; detail: string; risk: Risk }
  type ToolEvent = { id: string; name: string; running: boolean; skill?: string }

  interface Window {
    electron: ElectronAPI
    api: {
      sessions: () => Promise<Session[]>
      deleteSession: (sessionId: number) => Promise<void>
      /** The title is trimmed and must be 1 to 200 characters. */
      renameSession: (sessionId: number, title: string) => Promise<void>
      pinSession: (sessionId: number, pinned: boolean) => Promise<void>
      history: (sessionId: number) => Promise<ChatMessage[]>
      send: (sessionId: number | null, content: string) => Promise<{ sessionId: number; text: string }>
      onTool: (cb: (event: ToolEvent) => void) => () => void
      onApprove: (cb: (request: ApprovalRequest) => void) => () => void
      approve: (id: string, ok: boolean) => void
      /** Resolves to '' on success, otherwise an error message. */
      openPath: (path: string) => Promise<string>
      /** Full paths chosen in the file dialog; empty when canceled. */
      pickFiles: () => Promise<string[]>
      onJev: (cb: (update: { id: string; status: JevStatus }) => void) => () => void
      onToolOutput: (cb: (output: { id: string; chunk: string }) => void) => () => void
      /** Answer text as the model writes it, from every step of the reply in progress. */
      onText: (cb: (text: { delta: string }) => void) => () => void
      /** New token totals of a session, sent after every agent step and Jev call. */
      onUsage: (cb: (usage: UsageUpdate) => void) => () => void
    }
  }
}
