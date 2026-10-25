# testVercelAI

## Delegation

The main agent takes the user's request and spawns the coding agent that fits it:

- **sr** (Opus, effort high): hard work - features across several files, design choices, unknown bugs, security-sensitive code.
- **jr** (Sonnet, effort high): easy work - small UI/CSS/text changes, one-file changes with a clear spec, lookups.

Brief the agent with the goal, the files and what is known. When unsure, use sr.

Run agents in parallel, one per independent task, each in its own git worktree (`isolation: "worktree"`). They commit on their branch and never push or merge.

Agents only develop; the main agent tests. Loop per task:
1. The agent writes the change, runs `npm run build`, commits, and reports.
2. The main agent reads the diff, merges into main, builds, and tests on the real app (see Build and run).
3. On a bug, the main agent sends it back to the same agent (SendMessage) with the steps, what was expected and what happened; the agent fixes and commits on its branch; back to step 2.
4. When it passes, the main agent removes the worktree and branch and reports to the user what was tested and what failed.

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
- Icons: use `lucide-react` first; hand-drawn SVG only when Lucide has no fitting icon.

## Build and run

- Build and typecheck: `npm run build`
- Run: `env -u ELECTRON_RUN_AS_NODE npm run dev` (VS Code sets `ELECTRON_RUN_AS_NODE`, which stops Electron from starting)
- Drive the app for end-to-end checks: start `./node_modules/electron/dist/electron.exe . --remote-debugging-port=9333` with `ELECTRON_RUN_AS_NODE` unset, then connect with `playwright-core` `chromium.connectOverCDP('http://127.0.0.1:9333')`. Keep test scripts outside the repo.
- Main-process changes need an app restart; renderer-only changes need a page reload.
