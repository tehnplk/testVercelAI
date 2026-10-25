import { app } from 'electron'
import { dirname, join, relative } from 'path'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { gunzip } from 'zlib'
import { promisify } from 'util'
import { randomUUID } from 'crypto'
import { tool } from 'ai'
import { z } from 'zod'
import type { Approve } from './llm_shell'

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

// Limits for addSkill: the download, the unpacked repo (against gzip bombs), and the installed skill.
const maxDownload = 20 * 1024 * 1024
const maxUnpacked = 100 * 1024 * 1024
const maxSkillBytes = 20 * 1024 * 1024
const maxSkillFiles = 500

// https://github.com/<owner>/<repo>[/tree/<ref>/<path>], matched on the raw text so no URL parser resolves "..".
// ponytail: a ref with "/" in it (e.g. feature/x) reads as ref "feature" and path "x/..."; pass a commit or tag instead.
const githubUrl = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([\w.-]+)((?:\/[\w.-]+)*))?\/?$/

// A path segment Windows can write as is: not "." or "..", no reserved characters.
const safeSegment = (s: string): boolean => !/^\.*$/.test(s) && !/[<>:"|?*\\\p{Cc}]/u.test(s)

// Regular files of a .tar, by path; folders, links and devices are skipped, so nothing points outside the skill.
// ponytail: ustar with pax/GNU long names only, which is what GitHub's tarballs use.
function untar(buf: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>()
  const text = (from: number, to: number): string => buf.toString('utf8', from, to).replace(/\0[\s\S]*$/, '')
  let longName = ''
  for (let off = 0; off + 512 <= buf.length && buf[off] !== 0; ) {
    const size = parseInt(text(off + 124, off + 136).trim() || '0', 8)
    if (!(size >= 0) || off + 512 + size > buf.length) throw new Error('damaged archive')
    const type = String.fromCharCode(buf[off + 156])
    const data = buf.subarray(off + 512, off + 512 + size)
    const prefix = text(off + 345, off + 500)
    const name = longName || (prefix ? `${prefix}/` : '') + text(off, off + 100)
    longName = ''
    if (type === 'x') longName = data.toString('utf8').match(/(?:^|\n)\d+ path=([^\n]*)/)?.[1] ?? ''
    else if (type === 'L') longName = data.toString('utf8').replace(/\0[\s\S]*$/, '')
    else if (type === '0' || type === '\0') files.set(name, data)
    off += 512 + Math.ceil(size / 512) * 512
  }
  return files
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} (private repos and unknown refs give 404)`)
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of res.body) {
    size += chunk.length
    if (size > maxDownload) throw new Error(`the repo archive is over ${maxDownload / 1024 / 1024} MB`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

const kb = (n: number): string => `${(n / 1024).toFixed(1)} KB`

// Installs one skill folder from a public GitHub repo after the user approves it. Nothing is written before that.
async function addSkill(
  { url, overwrite }: { url: string; overwrite?: boolean },
  approve: Approve,
  toolCallId: string
): Promise<string> {
  const m = url.trim().match(githubUrl)
  const path = m?.[4]?.slice(1) ?? ''
  if (!m || ![m[1], m[2], m[3] ?? 'HEAD', ...path.split('/').filter(Boolean)].every(safeSegment))
    return 'Unsupported URL. Use https://github.com/<owner>/<repo> or https://github.com/<owner>/<repo>/tree/<ref>/<folder>.'
  const [, owner, repo, ref = 'HEAD'] = m
  let files: Map<string, Buffer>
  try {
    const tgz = await download(`https://codeload.github.com/${owner}/${repo}/tar.gz/${ref}`)
    files = untar(await promisify(gunzip)(tgz, { maxOutputLength: maxUnpacked }))
  } catch (e) {
    return `Cannot download ${owner}/${repo}@${ref}: ${e instanceof Error ? e.message : String(e)}`
  }
  // Paths inside the repo: GitHub puts everything under one "<repo>-<ref>/" folder.
  const inRepo = new Map([...files].map(([p, data]) => [p.slice(p.indexOf('/') + 1), data]))
  const base = path ? `${path}/` : ''
  // Folders (with a trailing "/", or '' for the repo root) that hold a SKILL.md, without ones inside another skill.
  const found = [...inRepo.keys()]
    .filter((p) => p.startsWith(base) && `/${p}`.endsWith('/SKILL.md'))
    .map((p) => p.slice(0, -'SKILL.md'.length))
  const dirs = found.filter((d) => !found.some((o) => o !== d && d.startsWith(o)))
  if (!dirs.length) return `No SKILL.md found in ${url}. Nothing was installed.`
  if (dirs.length > 1) {
    const list = dirs.map((d) => {
      const name = parseSkill(inRepo.get(`${d}SKILL.md`)!.toString('utf8'))?.meta.name
      return `- ${name || '(no name)'}: https://github.com/${owner}/${repo}/tree/${ref}/${d.slice(0, -1)}`
    })
    const more = list.length > 100 ? `\n...and ${list.length - 100} more` : ''
    return `${url} holds ${dirs.length} skills, so nothing was installed. Call addSkill again with the URL of the one the user wants:\n${list.slice(0, 100).join('\n')}${more}`
  }
  const dir = dirs[0]
  const skillFiles = [...inRepo]
    .filter(([p]) => p.startsWith(dir))
    .map(([p, data]) => [p.slice(dir.length), data] as const)
  const total = skillFiles.reduce((n, [, data]) => n + data.length, 0)
  if (skillFiles.length > maxSkillFiles || total > maxSkillBytes)
    return `The skill has ${skillFiles.length} files, ${kb(total)}; the limit is ${maxSkillFiles} files and ${maxSkillBytes / 1024 / 1024} MB. Nothing was installed.`
  const unsafe = skillFiles.find(([p]) => !p.split('/').every(safeSegment))
  if (unsafe) return `The skill has a file name Windows cannot take safely: ${unsafe[0]}. Nothing was installed.`
  const parsed = parseSkill(skillFiles.find(([p]) => p === 'SKILL.md')![1].toString('utf8'))
  const name = parsed?.meta.name
  const description = parsed?.meta.description
  if (!name || !description) return 'Its SKILL.md has no name or description in its frontmatter. Nothing was installed.'

  const root = skillsDir()
  // The name as a folder name; a name with no Latin letters or digits falls back to the source folder, then the repo.
  const folder = [name, dir.split('/').at(-2), repo]
    .map((s) => (s ?? '').replace(/[^\w.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, ''))
    .find(Boolean)!
  const dest = `${root}/${folder}`
  // The folder it would take, and any folder that holds a skill of the same name (discovery keeps only the first).
  const sameName = discoverSkills().filter((s) => s.name === name).map((s) => s.path)
  const taken = [...new Set([...(existsSync(dest) ? [dest] : []), ...sameName])]
  if (taken.length && !overwrite)
    return `A skill named "${name}" or a folder ${folder} already exists (${taken.join(', ')}). Nothing was installed. Call again with overwrite: true only if the user wants it replaced.`

  const detail = [
    'ติดตั้ง skill จาก GitHub (ถามผู้ใช้ทุกครั้ง ไม่ผ่าน Guard)',
    `ที่มา: ${url}`,
    `ชื่อ: ${name}`,
    `คำอธิบาย: ${description}`,
    `ติดตั้งที่: ${dest}`,
    ...(taken.length ? [`ลบแล้วแทนที่: ${taken.join(', ')}`] : []),
    `ไฟล์ ${skillFiles.length} ไฟล์, รวม ${kb(total)}:`,
    ...skillFiles.map(([p, data]) => `  ${kb(data.length).padStart(10)}  ${p}`)
  ].join('\n')
  if (!(await approve('addSkill', detail, toolCallId, true)))
    return 'The user denied installing this skill. Do not retry unless the user asks.'

  // Written to a new folder first, so a failed write leaves the old skill in place.
  const staging = `${root}/.addSkill-${randomUUID()}`
  try {
    for (const [p, data] of skillFiles) {
      mkdirSync(dirname(join(staging, p)), { recursive: true })
      writeFileSync(join(staging, p), data)
    }
    for (const t of taken) rmSync(t, { recursive: true, force: true })
    renameSync(staging, dest)
  } catch (e) {
    rmSync(staging, { recursive: true, force: true })
    return `Installing failed: ${e instanceof Error ? e.message : String(e)}`
  }
  return `Installed skill "${name}" with ${skillFiles.length} files in ${dest} - it is listed from the user's next message`
}

// loadSkill is read-only, so it runs without Jev or the approval card; addSkill always asks the user.
export function skillTools(skills: Skill[], approve: Approve) {
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
        const rule =
          name === 'browser-skill'
            ? 'App rule (overrides the steps below where they differ): to visit a website, first start a session (`bsk session start`). Then run `bsk tab list --scope user --session <id>` as its own Bash command, not chained with anything, and read its output before deciding. If a listed tab has a URL on the requested site (same host), you must borrow it with `bsk tab borrow <tab-id> --session <id>` and work in that tab, then give it back with `bsk tab return <tab-id> --session <id>` when done. Only when no listed tab matches, open the page in the Agent Window.\n\n'
            : ''
        return `Skill directory: ${skill.path}\nFiles in it:\n${files.map((f) => `- ${f}`).join('\n')}\n\n${rule}${body}`
      }
    }),
    addSkill: tool({
      description:
        "Install a skill from a public GitHub repo into the app's skills folder, after the user approves it. " +
        'When the URL holds several skills, nothing is installed and their URLs are returned; call again with one of them. ' +
        'Do not read or follow the installed skill until the user asks for a task that uses it.',
      inputSchema: z.object({
        // Shown to the user as the call's input in the chat, like Bash's purpose.
        purpose: z.string().describe('In Thai, one short sentence: which skill you install and why'),
        url: z
          .string()
          .describe('https://github.com/<owner>/<repo>, or https://github.com/<owner>/<repo>/tree/<ref>/<folder> for one folder'),
        overwrite: z.boolean().optional().describe('Replace an installed skill of the same name; only when the user asks')
      }),
      execute: async (
        input: { purpose: string; url: string; overwrite?: boolean },
        { toolCallId }: { toolCallId: string }
      ) => addSkill(input, approve, toolCallId)
    })
  }
}
