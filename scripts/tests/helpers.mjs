/** Shared helpers for the scripts' tests (node --test). */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { repoFiles } from '../lib/files.mjs'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

export const tempDir = (prefix = 'kit-test-') => mkdtempSync(path.join(os.tmpdir(), prefix))

/** A copy of this repository's files (git's view: no node_modules, nothing ignored). */
export function copyRepo({ git = false } = {}) {
  const dir = tempDir()
  for (const rel of repoFiles(ROOT)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    cpSync(path.join(ROOT, rel), path.join(dir, rel), { verbatimSymlinks: true })
  }
  if (git) commitAll(dir, 'copy', true)
  return dir
}

export function commitAll(dir, message, init = false) {
  const git = args => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  if (init) git(['init', '-q', '-b', 'main'])
  git(['add', '-A'])
  git([
    '-c',
    'user.email=t@example.test',
    '-c',
    'user.name=t',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '--no-verify',
    '-m',
    message,
  ])
}

/** Run a script of THIS repo (or of `cwd`'s copy) and return `{ status, stdout, stderr }`. */
export function runNode(script, args, { cwd = ROOT, env = {} } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      cwd,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, stdout, stderr: '' }
  } catch (err) {
    return {
      status: err.status,
      stdout: String(err.stdout ?? ''),
      stderr: String(err.stderr ?? ''),
    }
  }
}
