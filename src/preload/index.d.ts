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
    // Agent model id; null for the default.
    model: string | null
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
  // risk is null for tools that always ask without Guard (addSkill).
  type ApprovalRequest = { id: string; tool: string; detail: string; risk: Risk | null }
  type ToolEvent = { id: string; name: string; running: boolean; skill?: string; input?: string }
  // An entry of agentModels in src/main/llm_model.ts; prices are US$ per 1M tokens.
  type AgentModel = { id: string; label: string; input: number; output: number }
  // Same as Memory in src/main/llm_memory.ts.
  type Memory = { id: number; content: string; createdAt: Date }

  interface Window {
    electron: ElectronAPI
    api: {
      sessions: () => Promise<Session[]>
      deleteSession: (sessionId: number) => Promise<void>
      /** Deletes every chat and its messages; memories stay. */
      clearSessions: () => Promise<void>
      /** The Windows user name. */
      userName: () => Promise<string>
      /** The title is trimmed and must be 1 to 200 characters. */
      renameSession: (sessionId: number, title: string) => Promise<void>
      pinSession: (sessionId: number, pinned: boolean) => Promise<void>
      /** The model must be one of models(); the session's next message uses it. */
      setSessionModel: (sessionId: number, model: string) => Promise<void>
      /** The agent models to pick from; the first is the default. */
      models: () => Promise<AgentModel[]>
      /** The agent's saved notes, newest first. */
      memories: () => Promise<Memory[]>
      deleteMemory: (id: number) => Promise<void>
      history: (sessionId: number) => Promise<ChatMessage[]>
      /** model (one of models()) is stored on a new session; an existing session uses its own. */
      send: (sessionId: number | null, content: string, model: string) => Promise<{ sessionId: number; text: string }>
      onTool: (cb: (event: ToolEvent) => void) => () => void
      onApprove: (cb: (request: ApprovalRequest) => void) => () => void
      approve: (id: string, ok: boolean) => void
      /** Resolves to '' on success, otherwise an error message. */
      openPath: (path: string) => Promise<string>
      /** Bytes of a .docx file, or an error message when it is missing or over 50 MB. Rejects other paths. */
      readDocx: (path: string) => Promise<Uint8Array | string>
      /**
       * An answer's image as a data: URL. src is an http(s) URL or a full Windows path (optionally file:///,
       * percent-encoded as react-markdown gives it); local files must be png/jpg/gif/webp/bmp/svg up to 20 MB,
       * web images image/* up to 10 MB from a public address.
       */
      loadImage: (src: string) => Promise<{ src: string } | { error: string }>
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
