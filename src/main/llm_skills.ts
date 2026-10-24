import { app } from 'electron'
import { join, relative } from 'path'
import { readdirSync, readFileSync } from 'fs'
import { tool } from 'ai'
import { z } from 'zod'

export type Skill = { name: string; description: string; path: string }

// Forward slashes so the agent can use the path as is in Git Bash and Python.
const skillsDir = (): string => join(app.getPath('userData'), 'skills').replaceAll('\\', '/')

// Reads SKILL.md: top-level `key: value` frontmatter fields, each folded into one line, and the body after it.
// Handles plain, quoted and block (| or >) scalars; values are only used as one-line text, so line breaks become spaces.
// ponytail: not a full YAML parser (no nested maps, lists or escapes beyond JSON's); add the `yaml` package if skills need more.
export function parseSkill(text: string): { meta: Record<string, string>; body: string } | null {
  const m = text.replace(/^﻿/, '').match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/)
  if (!m) return null
  const lines = m[1].split(/\r?\n/)
  const meta: Record<string, string> = {}
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([\w-]+):(?:[ \t]+(.*))?$/)
    if (!kv) continue
    // A value continues on the indented or blank lines below its key.
    const more: string[] = []
    while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || !lines[i + 1].trim())) more.push(lines[++i].trim())
    const first = (kv[2] ?? '').trim()
    const isBlock = /^[|>][+-]?\d?[+-]?(\s+#.*)?$/.test(first)
    let value = [isBlock ? '' : first, ...more].filter(Boolean).join(' ')
    if (/^".*"$/.test(value)) {
      try {
        value = JSON.parse(value)
      } catch {
        value = value.slice(1, -1)
      }
    } else if (/^'.*'$/.test(value)) value = value.slice(1, -1).replaceAll("''", "'")
    meta[kv[1]] = value.trim()
  }
  return { meta, body: m[2] }
}

// Each folder in the skills directory with a SKILL.md that has a name and description; the first of a name wins.
export function discoverSkills(): Skill[] {
  const dir = skillsDir()
  let entries: string[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
  const skills: Skill[] = []
  for (const folder of entries) {
    let parsed: ReturnType<typeof parseSkill>
    try {
      parsed = parseSkill(readFileSync(join(dir, folder, 'SKILL.md'), 'utf8'))
    } catch {
      continue
    }
    const name = parsed?.meta.name
    const description = parsed?.meta.description
    if (!name || !description || skills.some((s) => s.name === name)) continue
    skills.push({ name, description, path: `${dir}/${folder}` })
  }
  return skills
}

export function skillsPrompt(skills: Skill[]): string {
  if (!skills.length) return ''
  return `

Skills are instructions for particular kinds of tasks. When the user's request matches a skill's description, your first tool call must be loadSkill with that skill's name; do not try another way first. Then follow what it returns. Paths inside a skill are relative to that skill's directory, which loadSkill gives you; read those files with Bash when the skill says to.
${skills.map((s) => `- ${s.name}: ${s.description}`).join('\n')}`
}

// Read-only, so it runs without Jev or the approval card.
export function skillTools(skills: Skill[]) {
  return {
    loadSkill: tool({
      description: "Load a skill's instructions by name, with its directory and the files in it.",
      inputSchema: z.object({ name: z.string().describe('Skill name exactly as listed in the system prompt') }),
      execute: async ({ name }: { name: string }) => {
        const skill = skills.find((s) => s.name === name)
        if (!skill) return `No skill named "${name}". Skills: ${skills.map((s) => s.name).join(', ') || 'none'}`
        const body = parseSkill(readFileSync(join(skill.path, 'SKILL.md'), 'utf8'))?.body.trim() ?? ''
        const files = readdirSync(skill.path, { recursive: true, withFileTypes: true })
          .filter((e) => e.isFile())
          .map((e) => relative(skill.path, join(e.parentPath, e.name)).replaceAll('\\', '/'))
        return `Skill directory: ${skill.path}\nFiles in it:\n${files.map((f) => `- ${f}`).join('\n')}\n\n${body}`
      }
    })
  }
}
