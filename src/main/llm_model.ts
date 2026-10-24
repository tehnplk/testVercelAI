import { is } from '@electron-toolkit/utils'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'

if (is.dev) process.loadEnvFile()
const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY })

export const model = openrouter('deepseek/deepseek-v4.1-flash-1017')

// Second opinion on commands the agent wants to run; a Decisions API model id, called by llm_risk.ts.
export const riskModel = 'perplexity/pplx-decider-v1.2'

// Jev, the chat-model checker llm_risk.ts falls back to when the decider call fails.
export const fallbackRiskModel = openrouter('typesafe/jev-router')

// Sums up a Bash output in one line when the run printed no "Saved:" or "Result:" line.
export const summaryModel = openrouter('deepseek/deepseek-v4.1-flash-1017')
