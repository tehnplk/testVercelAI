import { app, shell, BrowserWindow, dialog, ipcMain, protocol } from 'electron'
import { extname, join } from 'path'
import { createReadStream, existsSync, readFileSync } from 'fs'
import { readFile, realpath, stat, writeFile } from 'fs/promises'
import { Readable } from 'stream'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { isStepCount, streamText } from 'ai'
import { agentModel, agentModels, isAgentModel } from './llm_model'
import { systemPrompt } from './llm_system_prompt'
import { shellTools } from './llm_shell'
import { assessRisk, printRisk, type Risk } from './llm_risk'
import { discoverSkills, skillsPrompt, skillTools } from './llm_skills'
import { imageTools, splitAttachments, withAttachedImages } from './llm_image'
import { fetchImage, webTools } from './llm_web'
import { memoryPrompt, recallTools } from './llm_recall'
import { randomUUID } from 'crypto'
import { userInfo } from 'os'
import {
  addUsage,
  clearSessions,
  deleteMemory,
  deleteSession,
  listMemories,
  listSessions,
  loadChat,
  loadModelMessages,
  newSession,
  renameSession,
  saveMessages,
  sessionModel,
  setPinned,
  setSessionModel,
  type TokenUsage
} from './llm_memory'

// Skill name the agent passed to loadSkill, for the tool log label.
function skillName(toolCall: { toolName: string; input: unknown }): string | undefined {
  const name = (toolCall.input as { name?: unknown } | null)?.name
  return toolCall.toolName === 'loadSkill' && typeof name === 'string' ? name : undefined
}

// What the call is for (Bash's purpose), same text the saved turn shows (llm_memory.ts).
function toolPurpose(toolCall: { input: unknown }): string | undefined {
  const purpose = (toolCall.input as { purpose?: unknown } | null)?.purpose
  return typeof purpose === 'string' && purpose ? purpose : undefined
}

// Model calls per message. The last one gets no tools and lastStepNote, so a reply always ends in an answer.
// The note goes in as a user message after the last tool result: in the system prompt, Claude Haiku and
// DeepSeek ignore it after many tool calls and end the turn with empty text.
const maxSteps = 30
const lastStepNote =
  'This is your last step: tools are off now. Answer the user now, in Thai, from what you have: what you found, what is still missing or unchecked, and what the user can do next (e.g. ask you to continue).'
// Saved and shown when the run still ends without text.
const noAnswer = 'ขออภัย รอบนี้โมเดลไม่ได้เขียนคำตอบ ลองส่งข้อความให้ทำต่อ หรือแบ่งงานให้เล็กลง'

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
    mainWindow.maximize()
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

// app-media://video/<encodeURIComponent(full path)> streams a local video to the answer's <video> (MarkdownImage).
// stream: true lets <video> read it in ranges; must be registered before the app is ready.
protocol.registerSchemesAsPrivileged([{ scheme: 'app-media', privileges: { standard: true, secure: true, stream: true } }])

const videoTypes: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime'
}

// GET only; serves nothing but an existing regular video file on a drive-letter path. The real path is checked
// too, so a link named .mp4, or one leading to a UNC/device path or an alternate data stream (a:b.mp4), is refused.
async function serveVideo(request: Request): Promise<Response> {
  if (request.method !== 'GET') return new Response(null, { status: 405 })
  let path = ''
  try {
    path = decodeURIComponent(new URL(request.url).pathname.slice(1))
  } catch {
    /* fails the check below */
  }
  const local = /^[A-Za-z]:[\\/][^:]*$/
  if (!local.test(path)) return new Response(null, { status: 403 })
  const real = await realpath(path).catch(() => '')
  const info = real && (await stat(real).catch(() => null))
  if (!info || !info.isFile()) return new Response(null, { status: 404 })
  const type = videoTypes[extname(real).toLowerCase()]
  if (!type || !local.test(real)) return new Response(null, { status: 403 })

  const size = info.size
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes' }
  const range = request.headers.get('range')
  if (!range) {
    const body = Readable.toWeb(createReadStream(real)) as ReadableStream
    return new Response(body, { headers: { ...headers, 'Content-Length': String(size) } })
  }
  // One range: bytes=start-, bytes=start-end or bytes=-suffixLength.
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
  const start = !m || (!m[1] && !m[2]) ? NaN : m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]))
  const end = m?.[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
  if (!(start <= end)) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
  const body = Readable.toWeb(createReadStream(real, { start, end })) as ReadableStream
  return new Response(body, {
    status: 206,
    headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) }
  })
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

  protocol.handle('app-media', serveVideo)

  ipcMain.handle('sessions:list', () => listSessions())
  ipcMain.handle('sessions:delete', (_, sessionId: unknown) => {
    if (!Number.isInteger(sessionId)) throw new Error('Invalid session')
    return deleteSession(sessionId as number)
  })
  ipcMain.handle('sessions:clear', () => clearSessions())
  ipcMain.handle('user:name', () => userInfo().username)
  ipcMain.handle('sessions:rename', (_, sessionId: unknown, title: unknown) => {
    if (!Number.isInteger(sessionId)) throw new Error('Invalid session')
    const t = typeof title === 'string' ? title.trim() : ''
    if (t.length < 1 || t.length > 200) throw new Error('Invalid title')
    return renameSession(sessionId as number, t)
  })
  ipcMain.handle('sessions:pin', (_, sessionId: unknown, pinned: unknown) => {
    if (!Number.isInteger(sessionId)) throw new Error('Invalid session')
    if (typeof pinned !== 'boolean') throw new Error('Invalid pinned')
    return setPinned(sessionId as number, pinned)
  })
  // The next message of the session uses this model.
  ipcMain.handle('sessions:set-model', (_, sessionId: unknown, model: unknown) => {
    if (!Number.isInteger(sessionId)) throw new Error('Invalid session')
    if (!isAgentModel(model)) throw new Error('Invalid model')
    return setSessionModel(sessionId as number, model)
  })
  ipcMain.handle('models:list', () => agentModels)
  // The skills the agent sees, for the Skills dialog.
  ipcMain.handle('skills:list', () =>
    discoverSkills()
      .map(({ name, description, path }) => ({ name, description, dir: path }))
      .sort((a, b) => a.name.localeCompare(b.name))
  )
  ipcMain.handle('memories:list', () => listMemories())
  ipcMain.handle('memories:delete', async (_, id: unknown) => {
    if (!Number.isInteger(id)) throw new Error('Invalid memory')
    await deleteMemory(id as number)
  })

  // Guard on/off, kept in userData/settings.json; on unless the user turned it off. approve reads it on
  // every tool call, so a change applies to the reply in progress too.
  const settingsFile = join(app.getPath('userData'), 'settings.json')
  let guardOn = true
  try {
    guardOn = JSON.parse(readFileSync(settingsFile, 'utf8')).guard !== false
  } catch {
    /* no file yet: on */
  }
  ipcMain.handle('guard:get', () => guardOn)
  ipcMain.handle('guard:set', async (_, on: unknown) => {
    if (typeof on !== 'boolean') throw new Error('Invalid guard')
    await writeFile(settingsFile, JSON.stringify({ guard: on }))
    guardOn = on
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

  // Bytes of a .docx file for the in-app viewer, or an error message. Nothing but .docx files is read here.
  const docx = /\.docx$/i
  ipcMain.handle('file:read-docx', async (_, path: unknown) => {
    if (typeof path !== 'string' || !docx.test(path)) throw new Error('Invalid path')
    // The real path must be a .docx too, so a link named .docx cannot hand out another file.
    const real = await realpath(path).catch(() => '')
    const info = real && (await stat(real))
    if (!info || !info.isFile()) return `ไม่พบไฟล์: ${path}`
    if (!docx.test(real)) throw new Error('Invalid path')
    if (info.size > 50 * 1024 * 1024) return `ไฟล์ใหญ่เกิน 50 MB จึงเปิดดูในแอปไม่ได้: ${path}`
    return readFile(real)
  })

  // An image of an answer (![alt](src)) as a data: URL, which the page's CSP allows, or an error message.
  // src comes from the model's text as react-markdown hands it on, percent-encoded (C:%5CUsers%5C...).
  const imageTypes: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml'
  }
  ipcMain.handle('image:load', async (_, src: unknown): Promise<{ src: string } | { error: string }> => {
    if (typeof src !== 'string') throw new Error('Invalid src')
    if (/^https?:\/\//i.test(src))
      return fetchImage(src).then(
        (data) => ({ src: data }),
        // A failed connect can be an AggregateError with only a code (ETIMEDOUT, ECONNREFUSED).
        (e) => ({
          error: `โหลดรูปจากเว็บไม่ได้ (${e instanceof Error ? e.message || (e as NodeJS.ErrnoException).code || e.name : String(e)})`
        })
      )
    let path = ''
    try {
      path = decodeURIComponent(src.replace(/^file:\/\/\//i, ''))
    } catch {
      /* not percent-encoded right; fails the check below */
    }
    // A drive-letter path only, so a UNC path (\\host\share) cannot make Windows connect to another machine.
    if (!/^[A-Za-z]:[\\/]/.test(path)) return { error: 'ที่อยู่รูปต้องเป็น path เต็มในเครื่อง หรือ URL http(s)' }
    // The real path is what gets read, so a link named .png cannot hand out another file.
    const real = await realpath(path).catch(() => '')
    const info = real && (await stat(real))
    if (!info || !info.isFile()) return { error: 'ไม่พบไฟล์รูป' }
    const type = imageTypes[extname(real).toLowerCase()]
    if (!type) return { error: 'ไม่ใช่ไฟล์รูปที่รองรับ (png, jpg, gif, webp, bmp, svg)' }
    if (info.size > 20 * 1024 * 1024) return { error: 'ไฟล์รูปใหญ่เกิน 20 MB' }
    return { src: `data:${type};base64,${(await readFile(real)).toString('base64')}` }
  })

  // Full paths of the files the user picks to attach; empty when canceled.
  ipcMain.handle('file:pick', async (event) => {
    const { filePaths } = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, {
      properties: ['openFile', 'multiSelections']
    })
    return filePaths
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

  // sessionId null starts a new session, titled by its first message and using model; an existing session
  // keeps its own model (sessions:set-model changes it).
  ipcMain.handle('chat:send', async (event, sessionId: unknown, content: unknown, model: unknown) => {
    if (typeof content !== 'string' || !content.trim()) throw new Error('Empty message')
    if (sessionId !== null && typeof sessionId !== 'number') throw new Error('Invalid session')
    if (!isAgentModel(model)) throw new Error('Invalid model')
    // Attached file paths are not part of the title.
    const id = sessionId ?? (await newSession(splitAttachments(content).text.trim().slice(0, 60), model))
    const modelId = sessionId === null ? model : await sessionModel(id)
    await saveMessages(id, [withAttachedImages(content)])
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
    const ask = (tool: string, detail: string, risk: Risk | null): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        const requestId = randomUUID()
        approvals.set(requestId, resolve)
        event.sender.send('chat:approve', { id: requestId, tool, detail, risk })
      })
    // Jev judges the run first: SAFE runs at once, RISK shows the approval card.
    // alwaysAsk (addSkill) shows the card without Guard, and the card has no Guard line.
    // With Guard off no model is called: everything runs at once except printing, which still asks.
    const approve = async (tool: string, detail: string, toolCallId: string, alwaysAsk = false): Promise<boolean> => {
      if (alwaysAsk) return ask(tool, detail, null)
      if (!guardOn) {
        const print = printRisk(detail)
        event.sender.send('chat:jev', { id: toolCallId, status: print ? 'risk' : 'off' })
        const ok = !print || (await ask(tool, detail, print))
        if (ok) ran.push(detail)
        return ok
      }
      event.sender.send('chat:jev', { id: toolCallId, status: 'inspecting' })
      const { risk, usage } = await assessRisk(tool, detail, ran)
      await countUsage({ guardInput: usage?.inputTokens, guardOutput: usage?.outputTokens })
      event.sender.send('chat:jev', { id: toolCallId, status: risk.level })
      const ok = risk.level === 'safe' || (await ask(tool, detail, risk))
      if (ok) ran.push(detail)
      return ok
    }
    const messages = await loadModelMessages(id)
    // Read on every message, so a skill folder added while the app runs is picked up, and notes saved in
    // another chat are known.
    const skills = discoverSkills()
    const system = systemPrompt + skillsPrompt(skills) + memoryPrompt(await listMemories())
    const result = streamText({
      model: agentModel(modelId),
      system,
      tools: {
        // The summary model's tokens count as the agent's.
        ...shellTools(approve, toolOutput, content, (u) =>
          countUsage({ agentInput: u.inputTokens, agentOutput: u.outputTokens })
        ),
        ...skillTools(skills, approve),
        ...imageTools,
        ...recallTools,
        // Web search fees are not tokens; only the tokens of its model and webFetch's helper are counted.
        ...webTools((u) => countUsage({ agentInput: u.inputTokens, agentOutput: u.outputTokens }))
      },
      stopWhen: isStepCount(maxSteps),
      // The note is sent for this call only; it is not part of the response messages that get saved.
      prepareStep: ({ stepNumber, messages }) =>
        stepNumber === maxSteps - 1
          ? { toolChoice: 'none', messages: [...messages, { role: 'user', content: lastStepNote }] }
          : undefined,
      messages,
      onToolExecutionStart: ({ toolCall }) =>
        event.sender.send('chat:tool', { id: toolCall.toolCallId, name: toolCall.toolName, running: true, skill: skillName(toolCall), input: toolPurpose(toolCall) }),
      onToolExecutionEnd: ({ toolCall }) =>
        event.sender.send('chat:tool', { id: toolCall.toolCallId, name: toolCall.toolName, running: false, skill: skillName(toolCall), input: toolPurpose(toolCall) }),
      // Per step only; the all-steps total (result.usage) is not added again.
      onStepEnd: ({ usage }) => countUsage({ agentInput: usage.inputTokens, agentOutput: usage.outputTokens })
    })
    // Text of every step goes to the pending bubble as it is written. streamText keeps going after an
    // error part (only logging it), so it is thrown here to fail the reply as generateText did.
    for await (const part of result.stream) {
      if (part.type === 'text-delta') event.sender.send('chat:text', { delta: part.text })
      else if (part.type === 'error') throw part.error
    }
    const response = await result.responseMessages
    // An empty last step (the model wrote nothing) still leaves an answer in the chat.
    let text = await result.text
    if (!text.trim()) {
      text = noAnswer
      response.push({ role: 'assistant', content: text })
    }
    await saveMessages(id, response)
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
