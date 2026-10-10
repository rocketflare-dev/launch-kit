/**
 * `apps/web/.dev.vars` — the local Worker's variables and secrets (git-ignored), read by
 * `wrangler dev`, `pnpm db:migrate` and the dev scripts. One `KEY=value` per line; `#` comments.
 * Node built-ins only.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const WEB_DIR = path.join(ROOT, 'apps/web')
export const DEV_VARS = path.join(WEB_DIR, '.dev.vars')

/** Parse `.dev.vars` text into `{ KEY: value }` (quotes stripped). */
export function parseDevVars(text) {
  const out = {}
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!m) continue
    let value = m[2] ?? ''
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1)
    out[m[1]] = value
  }
  return out
}

/**
 * Set `values` in `.dev.vars` text: a present key is replaced in place, a missing one appended.
 * Every other line (comments included) is kept as it was.
 */
export function setDevVars(text, values) {
  const pending = new Map(Object.entries(values))
  const lines = text.split(/\r?\n/).map(line => {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)
    if (m && pending.has(m[1])) {
      const value = pending.get(m[1])
      pending.delete(m[1])
      return `${m[1]}=${value}`
    }
    return line
  })
  while (lines.length && lines.at(-1) === '') lines.pop()
  for (const [key, value] of pending) lines.push(`${key}=${value}`)
  return `${lines.join('\n')}\n`
}

export function readDevVarsFile(file = DEV_VARS) {
  return existsSync(file) ? parseDevVars(readFileSync(file, 'utf8')) : {}
}

export function writeDevVarsFile(values, file = DEV_VARS) {
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  writeFileSync(file, setDevVars(text, values))
}

/**
 * The dev ports and allowed hosts: the shell first, then `.dev.vars`, then 3000 (UI) / 3001 (API).
 * The env NAMES are the contract (`launch.kit.json` → `session.ports`): Launch sets them in a
 * session's environment.
 */
export function devPorts(env = process.env, devVars = readDevVarsFile()) {
  const pick = key => {
    for (const source of [env, devVars]) {
      const v = source?.[key]
      if (v !== undefined && String(v).trim() !== '') return String(v).trim()
    }
    return undefined
  }
  const port = (key, fallback) => {
    const raw = pick(key)
    if (raw === undefined) return fallback
    const n = /^\d+$/.test(raw) ? Number(raw) : Number.NaN
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${key}=${raw} is not a port`)
    return n
  }
  const ui = port('DEV_UI_PORT', 3000)
  const api = port('DEV_API_PORT', 3001)
  if (ui === api) throw new Error(`DEV_UI_PORT and DEV_API_PORT are both ${ui}; they must differ`)
  const allowedHosts = (pick('DEV_ALLOWED_HOSTS') ?? '')
    .split(',')
    .map(h => h.trim())
    .filter(Boolean)
  return { ui, api, allowedHosts }
}
