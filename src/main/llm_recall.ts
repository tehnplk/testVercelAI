import { tool } from 'ai'
import { z } from 'zod'
import { addMemory, deleteMemory, type Memory } from './llm_memory'

// Longest note remember saves, in characters.
const maxNote = 300
// The system prompt lists notes newest first, up to both limits.
// ponytail: older notes past the limits drop out of the prompt (the model is told how many); the user prunes them
// in the ความจำ dialog. Pick notes by relevance if users keep hundreds.
const maxNotes = 100
const maxChars = 8000

// The Memory section appended to the system prompt of every message; empty without notes.
export function memoryPrompt(notes: Memory[]): string {
  const lines: string[] = []
  let chars = 0
  for (const n of notes) {
    const line = `[${n.id}] ${n.content}`
    if (lines.length >= maxNotes || chars + line.length > maxChars) break
    lines.push(line)
    chars += line.length + 1
  }
  if (!lines.length) return ''
  const rest = notes.length - lines.length
  return `

Memory: notes saved with remember in earlier chats with this user, newest first, as [id] note.
${lines.join('\n')}${rest ? `\n(${rest} older notes not shown)` : ''}`
}

// No Guard or approval card: they only change these notes, and the user sees each call in the chat and every note
// in the ความจำ dialog.
export const recallTools = {
  remember: tool({
    description:
      'Save one short note that is shown to you in every later chat: a stable fact about the user, a preference or a ' +
      'correction. Returns the saved note as [id] note.',
    inputSchema: z.object({
      // Shown to the user as the call's input in the chat, like Bash's purpose.
      purpose: z.string().describe('In Thai, one short sentence: what you save and why'),
      content: z.string().describe(`The note: one sentence in Thai or English, at most ${maxNote} characters`)
    }),
    execute: async ({ content }: { purpose: string; content: string }) => {
      // One line, so a note cannot break the [id] list in the system prompt.
      const note = content.replace(/\s+/g, ' ').trim()
      if (!note) return 'Nothing saved: the note is empty.'
      if (note.length > maxNote)
        return `Nothing saved: the note has ${note.length} characters, over the ${maxNote} limit. Shorten it to one sentence.`
      return `[${await addMemory(note)}] ${note}`
    }
  }),
  forget: tool({
    description: 'Delete one saved note by its id, the [id] in the Memory section.',
    inputSchema: z.object({
      purpose: z.string().describe('In Thai, one short sentence: which note you delete and why'),
      id: z.number().int().describe('The note id')
    }),
    execute: async ({ id }: { purpose: string; id: number }) => {
      const note = await deleteMemory(id)
      return note === null ? `No note [${id}]. Nothing was deleted.` : `Deleted [${id}] ${note}`
    }
  })
}
