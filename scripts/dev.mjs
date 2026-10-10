#!/usr/bin/env node
/**
 * The local dev stack (`pnpm dev`, `launch.kit.json` → `session.devStart` / `devStop`):
 *
 *   node scripts/dev.mjs start    wrangler dev (the API, DEV_API_PORT, default 3001) and Vite (the
 *                                 UI, DEV_UI_PORT, default 3000; proxies /api and /auth to the API),
 *                                 both bound to 0.0.0.0, in the foreground until Ctrl-C
 *   node scripts/dev.mjs stop     stop a running stack (from another shell, or Launch)
 *   node scripts/dev.mjs status   what is running
 *
 * Ports and allowed hosts: the shell first, then apps/web/.dev.vars, then the defaults. Launch sets
 * DEV_UI_PORT, DEV_API_PORT and DEV_ALLOWED_HOSTS (its preview host suffix) in a session.
 * The supervisor's pid and its children's process groups are kept in apps/web/.wrangler/dev.json
 * (git-ignored), so `stop` kills exactly this checkout's stack and nothing else.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { devPorts, WEB_DIR } from './lib/dev-vars.mjs'

const STATE = path.join(WEB_DIR, '.wrangler/dev.json')
const WEB_PACKAGE = JSON.parse(readFileSync(path.join(WEB_DIR, 'package.json'), 'utf8')).name

const alive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE, 'utf8'))
  } catch {
    return null
  }
}

function killGroups(groups, signal) {
  for (const pid of groups) {
    try {
      process.kill(-pid, signal)
    } catch {
      // already gone
    }
  }
}

async function stop() {
  const state = readState()
  if (!state || !alive(state.supervisor)) {
    if (state) killGroups(state.groups ?? [], 'SIGKILL')
    rmSync(STATE, { force: true })
    console.log('dev: nothing running')
    return
  }
  try {
    process.kill(state.supervisor, 'SIGTERM')
  } catch {
    // raced with its own exit
  }
  killGroups(state.groups ?? [], 'SIGTERM')
  for (let i = 0; i < 30 && alive(state.supervisor); i++) await new Promise(r => setTimeout(r, 100))
  killGroups(state.groups ?? [], 'SIGKILL')
  if (alive(state.supervisor)) process.kill(state.supervisor, 'SIGKILL')
  rmSync(STATE, { force: true })
  console.log('dev: stopped')
}

function status() {
  const state = readState()
  if (state && alive(state.supervisor)) {
    console.log(`dev: running (pid ${state.supervisor}) — UI :${state.ui}, API :${state.api}`)
  } else console.log('dev: not running')
}

function start() {
  const existing = readState()
  if (existing && alive(existing.supervisor)) {
    console.error(`dev: already running (pid ${existing.supervisor}); node scripts/dev.mjs stop`)
    process.exit(1)
  }
  const ports = devPorts()
  mkdirSync(path.join(WEB_DIR, 'dist/ui'), { recursive: true }) // wrangler refuses a missing [assets] dir
  mkdirSync(path.dirname(STATE), { recursive: true })
  const env = {
    ...process.env,
    DEV_UI_PORT: String(ports.ui),
    DEV_API_PORT: String(ports.api),
    DEV_ALLOWED_HOSTS: ports.allowedHosts.join(','),
    WRANGLER_SEND_METRICS: 'false',
  }
  const children = ['dev:api', 'dev:ui'].map(script =>
    spawn('pnpm', ['--filter', WEB_PACKAGE, script], {
      cwd: path.resolve(WEB_DIR, '../..'),
      env,
      stdio: 'inherit',
      detached: true, // its own process group, so stop kills wrangler's and vite's whole trees
    })
  )
  writeFileSync(
    STATE,
    JSON.stringify({
      supervisor: process.pid,
      groups: children.map(c => c.pid),
      ui: ports.ui,
      api: ports.api,
    })
  )
  console.log(`dev: UI http://localhost:${ports.ui} · API http://localhost:${ports.api}`)
  let stopping = false
  const shutdown = code => {
    if (stopping) return
    stopping = true
    killGroups(
      children.map(c => c.pid),
      'SIGTERM'
    )
    setTimeout(() => {
      killGroups(
        children.map(c => c.pid),
        'SIGKILL'
      )
      rmSync(STATE, { force: true })
      process.exit(code)
    }, 1500).unref()
  }
  process.on('SIGINT', () => shutdown(0))
  process.on('SIGTERM', () => shutdown(0))
  for (const child of children) {
    child.on('exit', code => {
      if (!stopping) {
        console.error(`dev: a server exited (${code}); stopping the other`)
        shutdown(code ?? 1)
      }
    })
  }
}

const command = process.argv[2]
if (command === 'start') start()
else if (command === 'stop') await stop()
else if (command === 'status') status()
else {
  console.error('usage: node scripts/dev.mjs start|stop|status')
  process.exit(2)
}
