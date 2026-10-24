import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { generateText, isStepCount } from 'ai'
import { model } from './llm_model'
import { systemPrompt } from './llm_system_prompt'
import { shellTools } from './llm_shell'
import { assessRisk } from './llm_risk'
import { discoverSkills, skillsPrompt, skillTools } from './llm_skills'
import { randomUUID } from 'crypto'
import {
  addUsage,
  deleteSession,
  listSessions,
  loadChat,
  loadModelMessages,
  newSession,
  saveMessages,
  type TokenUsage
} from './llm_memory'

// Skill name the agent passed to loadSkill, for the tool log label.
function skillName(toolCall: { toolName: string; input: unknown }): string | undefined {
  const name = (toolCall.input as { name?: unknown } | null)?.name
  return toolCall.toolName === 'loadSkill' && typeof name === 'string' ? name : undefined
}

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.handle('sessions:list', () => listSessions())
  ipcMain.handle('sessions:delete', (_, sessionId: unknown) => {
    if (!Number.isInteger(sessionId)) throw new Error('Invalid session')
    return deleteSession(sessionId as number)
  })

  // Files that would run when opened are shown in Explorer instead.
  const runnable = /\.(exe|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|mjs|cjs|wsf|wsh|msi|msp|lnk|scr|hta|reg|jar|py|pyw|sh|cpl)$/i
  ipcMain.handle('file:open', async (_, path: unknown) => {
    if (typeof path !== 'string') throw new Error('Invalid path')
    if (!existsSync(path)) return `ไม่พบไฟล์: ${path}`
    if (runnable.test(path)) {
      shell.showItemInFolder(path)
      return ''
    }
    return shell.openPath(path)
  })

  ipcMain.handle('chat:history', (_, sessionId: unknown) => {
    if (typeof sessionId !== 'number') throw new Error('Invalid session')
    return loadChat(sessionId)
  })

  const approvals = new Map<string, (ok: boolean) => void>()
  ipcMain.on('chat:approval', (_, requestId: unknown, ok: unknown) => {
    if (typeof requestId !== 'string') return
    approvals.get(requestId)?.(ok === true)
    approvals.delete(requestId)
  })

  // sessionId null starts a new session, titled by its first message.
  ipcMain.handle('chat:send', async (event, sessionId: unknown, content: unknown) => {
    if (typeof content !== 'string' || !content.trim()) throw new Error('Empty message')
    if (sessionId !== null && typeof sessionId !== 'number') throw new Error('Invalid session')
    const id = sessionId ?? (await newSession(content.trim().slice(0, 60)))
    await saveMessages(id, [{ role: 'user', content }])
    // Stored after every agent step and Jev call, so a reply that fails halfway keeps what it spent,
    // and the header follows live. A provider that reports no count adds 0.
    const countUsage = async (u: Partial<TokenUsage>): Promise<void> =>
      event.sender.send('chat:usage', { sessionId: id, ...(await addUsage(id, u)) })
    // A new chat shows in the header at once, counting from 0.
    if (sessionId === null) await countUsage({})
    const toolOutput = (toolCallId: string, chunk: string): void =>
      event.sender.send('chat:tool-output', { id: toolCallId, chunk })
    // Commands run so far for this message; Jev uses them to tell files this task made from the user's own.
    const ran: string[] = []
    // Jev judges the run first: SAFE runs at once, RISK shows the approval card.
    const approve = async (tool: string, detail: string, toolCallId: string): Promise<boolean> => {
      event.sender.send('chat:jev', { id: toolCallId, status: 'inspecting' })
      const { risk, usage } = await assessRisk(tool, detail, ran)
      await countUsage({ guardInput: usage?.inputTokens, guardOutput: usage?.outputTokens })
      event.sender.send('chat:jev', { id: toolCallId, status: risk.level })
      const ok =
        risk.level === 'safe' ||
        (await new Promise<boolean>((resolve) => {
          const requestId = randomUUID()
          approvals.set(requestId, resolve)
          event.sender.send('chat:approve', { id: requestId, tool, detail, risk })
        }))
      if (ok) ran.push(detail)
      return ok
    }
    const messages = await loadModelMessages(id)
    // Read on every message, so a skill folder added while the app runs is picked up.
    const skills = discoverSkills()
    const { text, responseMessages } = await generateText({
      model,
      system: systemPrompt + skillsPrompt(skills),
      tools: {
        // The summary model's tokens count as the agent's.
        ...shellTools(approve, toolOutput, content, (u) =>
          countUsage({ agentInput: u.inputTokens, agentOutput: u.outputTokens })
        ),
        ...skillTools(skills)
      },
      stopWhen: isStepCount(20),
      messages,
      onToolExecutionStart: ({ toolCall }) =>
        event.sender.send('chat:tool', { id: toolCall.toolCallId, name: toolCall.toolName, running: true, skill: skillName(toolCall) }),
      onToolExecutionEnd: ({ toolCall }) =>
        event.sender.send('chat:tool', { id: toolCall.toolCallId, name: toolCall.toolName, running: false, skill: skillName(toolCall) }),
      // Per step only; the all-steps total (result.usage) is not added again.
      onStepEnd: ({ usage }) => countUsage({ agentInput: usage.inputTokens, agentOutput: usage.outputTokens })
    })
    await saveMessages(id, responseMessages)
    return { sessionId: id, text }
  })

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
