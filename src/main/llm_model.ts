import { is } from '@electron-toolkit/utils'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'

if (is.dev) process.loadEnvFile()
const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY })

export const model = openrouter('deepseek/deepseek-v4.1-flash-1017')

// Second opinion on commands the agent wants to run.
export const riskModel = openrouter('typesafe/jev-router')

// Sums up a runBash output in one line when the run printed no "Saved:" or "Result:" line.
export const summaryModel = openrouter('deepseek/deepseek-v4.1-flash-1017')
