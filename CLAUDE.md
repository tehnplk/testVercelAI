# testVercelAI

## Delegation

The main agent takes the user's request and spawns the coding agent that fits it:

- **sr** (Opus, effort high): hard work - features across several files, design choices, unknown bugs, security-sensitive code.
- **jr** (Sonnet, effort high): easy work - small UI/CSS/text changes, one-file changes with a clear spec, lookups.

Brief the agent with the goal, the files and what is known. When unsure, use sr.

Run agents in parallel, one per independent task, each in its own git worktree (`isolation: "worktree"`). They commit on their branch and never push or merge; the main agent reviews each diff, merges into main, resolves conflicts, builds, tests the merged app, then removes the worktrees.

Accept an agent's work only after testing it yourself: read the diff, run `npm run build`, and repeat the key checks on the real app (see Build and run). The agent's own report is not acceptance. Report to the user what you tested and what failed.

## Project

Electron + electron-vite + React 19 + TypeScript chat app. The agent uses the Vercel AI SDK (`ai` v7) with OpenRouter models; the key is `OPENROUTER_API_KEY` in `.env` (gitignored, never commit it).

- `src/main/index.ts`: window, IPC handlers, chat loop (`generateText` with tools), approvals.
- `src/main/llm_model.ts`: models (agent model, `riskModel` = Jev).
- `src/main/llm_shell.ts`: the only tool, `Bash` (Git Bash, streamed output, timeout).
- `src/main/llm_risk.ts`: Jev rates each command SAFE (runs) or RISK (user approves).
- `src/main/llm_system_prompt.ts`: agent instructions (Thai replies, docx through python-docx).
- `src/main/llm_memory.ts`: PGlite store for sessions and full model messages.
- `src/preload/`: `window.api` bridge and its types.
- `src/renderer/src/`: `App.tsx`, `components/` (Sidebar, CodeBlock, FileLink), `assets/main.css`.

## Build and run

- Build and typecheck: `npm run build`
- Run: `env -u ELECTRON_RUN_AS_NODE npm run dev` (VS Code sets `ELECTRON_RUN_AS_NODE`, which stops Electron from starting)
- Drive the app for end-to-end checks: start `./node_modules/electron/dist/electron.exe . --remote-debugging-port=9333` with `ELECTRON_RUN_AS_NODE` unset, then connect with `playwright-core` `chromium.connectOverCDP('http://127.0.0.1:9333')`. Keep test scripts outside the repo.
- Main-process changes need an app restart; renderer-only changes need a page reload.
