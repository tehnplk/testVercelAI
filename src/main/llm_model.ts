import { is } from '@electron-toolkit/utils'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import type { LanguageModel } from 'ai'

if (is.dev) process.loadEnvFile()
const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY })

// Agent models the user picks per chat (ModelPicker.tsx); the first is the default, used when a chat stored none.
// Prices are US$ per 1M tokens. The label is the id after the '/'.
export const agentModels = [
  { id: 'deepseek/deepseek-v4.1-flash-1017', input: 0.15, output: 0.6 },
  { id: 'z-ai/glm-5.3-flash', input: 0.15, output: 0.5 },
  { id: 'openai/gpt-6-luna', input: 0.1, output: 0.5 },
  { id: 'xiaomi/mimo-v2.6-flash', input: 0.14, output: 0.28 },
  { id: 'anthropic/claude-haiku-5.5', input: 0.1, output: 0.5 },
  { id: 'meta/muse-spark-1.3-contributor', input: 0.1, output: 0.2 },
  { id: 'qwen/qwen3.8-flash', input: 0.15, output: 0.47 }
].map((m) => ({ ...m, label: m.id.slice(m.id.indexOf('/') + 1) }))
export const isAgentModel = (id: unknown): id is string => agentModels.some((m) => m.id === id)
export const agentModel = (id: string | null): LanguageModel => openrouter(id ?? agentModels[0].id)

export const model = agentModel(null)

// Second opinion on commands the agent wants to run; a Decisions API model id, called by llm_risk.ts.
export const riskModel = 'perplexity/pplx-decider-v1.2'

// Jev, the chat-model checker llm_risk.ts falls back to when the decider call fails.
export const fallbackRiskModel = openrouter('typesafe/jev-router')

// Sums up a Bash output in one line when the run printed no "Saved:" or "Result:" line; answers webFetch prompts.
export const summaryModel = openrouter('deepseek/deepseek-v4.1-flash-1017')

// Carries webSearch's OpenRouter web plugin call (llm_web.ts); it writes no answer, so only its prompt price matters.
export const webSearchModel = 'deepseek/deepseek-v4.1-flash-1017'
