/** File listing and glob matching shared by init, upgrade and their tests. Node built-ins only. */
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

/** `**` any depth, `*` within one segment, `?` one character. A plain path matches itself. */
export function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*' && glob[i + 1] === '*') {
      re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'
      i += glob[i + 2] === '/' ? 2 : 1
    } else if (ch === '*') re += '[^/]*'
    else if (ch === '?') re += '[^/]'
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

export const matchesAny = (file, globs) => globs.some(g => globToRegExp(g).test(file))

const isSymlink = file => {
  try {
    return lstatSync(file).isSymbolicLink()
  } catch {
    return false
  }
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.wrangler', 'coverage'])

/** Every file in the repo: git's view (tracked + untracked, ignores honoured), else a walk. */
export function repoFiles(dir) {
  try {
    const out = execFileSync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    )
    // `--cached` still lists a tracked file deleted in the working tree: keep only what exists.
    return [...new Set(out.split('\0').filter(Boolean))]
      .filter(rel => existsSync(path.join(dir, rel)) || isSymlink(path.join(dir, rel)))
      .sort()
  } catch {
    const files = []
    const walk = rel => {
      for (const name of readdirSync(path.join(dir, rel))) {
        if (SKIP_DIRS.has(name)) continue
        const child = rel ? `${rel}/${name}` : name
        if (statSync(path.join(dir, child)).isDirectory()) walk(child)
        else files.push(child)
      }
    }
    walk('')
    return files.sort()
  }
}

/** Is the git tree dirty? `null` when `dir` is not a git checkout. */
export function gitDirty(dir) {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.trim().length > 0
  } catch {
    return null
  }
}

export function gitHead(dir) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

/** A NUL byte in the first 8 KB means binary. */
export function isBinary(file) {
  const bytes = readFileSync(file).subarray(0, 8192)
  return bytes.includes(0)
}
