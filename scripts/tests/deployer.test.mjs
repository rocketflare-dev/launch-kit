/**
 * scripts/deployer.mjs (docs/DEPLOYER.md, protocol v1) against a fake deployer that is also
 * GitHub's OIDC token endpoint, over a fixture outdir, toml and assets in a temp dir. The script
 * runs as an async child process so the fake server can answer it.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'
import { payloadDigest } from '../lib/bundle-lib.mjs'
import { ROOT, tempDir } from './helpers.mjs'

const SCRIPT = path.join(ROOT, 'scripts/deployer.mjs')
const MIGRATOR_URL = 'postgresql://migrator:s3cr%2Ft@db.example.test/app'
let server
let base
let seen
let script
const dir = tempDir()

before(async () => {
  server = createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const raw = Buffer.concat(chunks).toString()
    const url = new URL(req.url, base)
    seen.push({
      method: req.method,
      path: url.pathname,
      auth: req.headers.authorization,
      body: raw ? JSON.parse(raw) : undefined,
    })
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (url.pathname === '/oidc')
      return reply(200, { value: `jwt-for:${url.searchParams.get('audience')}` })
    if (url.pathname === '/d/deploy/start') return reply(200, { id: 'tkt-1', status: script.start })
    if (url.pathname === '/d/deploy/tkt-1' && req.method === 'GET')
      return reply(200, { id: 'tkt-1', status: script.poll })
    if (url.pathname === '/d/deploy/tkt-1/upload')
      return reply(script.uploadStatus, script.uploadBody)
    if (url.pathname === '/d/deploy/tkt-1/activate')
      return reply(200, { id: 'tkt-1', status: 'active' })
    if (url.pathname === '/d/deploy/tkt-1/finish')
      return reply(200, { id: 'tkt-1', status: 'finished' })
    reply(404, { error: 'no' })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
  mkdirSync(path.join(dir, 'web/dist/deploy'), { recursive: true })
  mkdirSync(path.join(dir, 'web/dist/ui/assets'), { recursive: true })
  writeFileSync(
    path.join(dir, 'web/wrangler.toml'),
    'name = "x"\nmain = "src/worker.ts"\n[assets]\ndirectory = "./dist/ui"\n'
  )
  writeFileSync(path.join(dir, 'web/dist/deploy/worker.js'), 'export default {}')
  writeFileSync(path.join(dir, 'web/dist/deploy/worker.js.map'), '{}')
  writeFileSync(path.join(dir, 'web/dist/ui/index.html'), '<html></html>')
  writeFileSync(path.join(dir, 'web/dist/ui/.assetsignore'), 'x')
})
after(() => {
  server.close()
  rmSync(dir, { recursive: true, force: true })
})
beforeEach(() => {
  seen = []
  script = {
    start: 'approved',
    poll: 'approved',
    uploadStatus: 200,
    uploadBody: { id: 'tkt-1', status: 'uploaded', migratorUrl: MIGRATOR_URL },
  }
  writeFileSync(path.join(dir, 'github.env'), '')
})

function run(command, env = {}) {
  return new Promise(resolve => {
    execFile(
      process.execPath,
      [SCRIPT, command],
      {
        cwd: dir,
        env: {
          PATH: process.env.PATH,
          DEPLOYER_URL: `${base}/d`,
          ACTIONS_ID_TOKEN_REQUEST_URL: `${base}/oidc?x=1`,
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'req',
          GITHUB_ENV: path.join(dir, 'github.env'),
          TOML: 'web/wrangler.toml',
          RELEASE_VERSION: '1.2.3',
          DEPLOYER_POLL_SECONDS: '0',
          ...env,
        },
      },
      (err, stdout, stderr) => resolve({ status: err ? err.code : 0, stdout, stderr })
    )
  })
}

describe('deployer client (protocol v1)', () => {
  it('start → upload → activate → finish, with a fresh OIDC token for the audience each call', async () => {
    assert.equal((await run('start')).status, 0)
    assert.match(readFileSync(path.join(dir, 'github.env'), 'utf8'), /DEPLOYER_TICKET=tkt-1/)
    const upload = await run('upload', { DEPLOYER_TICKET: 'tkt-1' })
    assert.equal(upload.status, 0, upload.stderr)
    // The migrator URL is masked and exported, never printed in the clear.
    assert.match(upload.stdout, /::add-mask::postgresql:\/\/migrator/)
    assert.ok(!upload.stdout.replace(/::add-mask::.*\n/g, '').includes('s3cr'))
    assert.match(readFileSync(path.join(dir, 'github.env'), 'utf8'), /MIGRATOR_URL=postgresql/)
    assert.equal((await run('activate', { DEPLOYER_TICKET: 'tkt-1' })).status, 0)
    assert.equal((await run('finish', { DEPLOYER_TICKET: 'tkt-1' })).status, 0)

    const calls = seen.filter(s => s.path.startsWith('/d/'))
    assert.deepEqual(
      calls.map(c => c.path),
      [
        '/d/deploy/start',
        '/d/deploy/tkt-1/upload',
        '/d/deploy/tkt-1/activate',
        '/d/deploy/tkt-1/finish',
      ]
    )
    for (const c of calls) assert.equal(c.auth, `Bearer jwt-for:${base}`)
    const body = calls[1].body
    assert.equal(body.protocol, 1)
    assert.equal(body.version, '1.2.3')
    assert.equal(body.main, 'worker.js')
    assert.deepEqual(Object.keys(body.modules), ['worker.js'])
    assert.deepEqual(Object.keys(body.assets), ['/index.html'])
    assert.equal(body.digest, payloadDigest({ modules: body.modules, assets: body.assets }))
    assert.match(body.toml, /name = "x"/)
  })

  it('fails on a rejected ticket', async () => {
    script.start = 'pending'
    script.poll = 'rejected'
    const res = await run('start')
    assert.equal(res.status, 1)
    assert.match(res.stderr, /rejected/)
  })

  it('fails an upload the deployer refuses', async () => {
    script.uploadStatus = 403
    script.uploadBody = { error: 'binding not registered', refused: ['kv_namespaces X=1'] }
    const res = await run('upload', { DEPLOYER_TICKET: 'tkt-1' })
    assert.equal(res.status, 1)
    assert.match(res.stderr, /binding not registered/)
  })

  it('finish without a ticket is a no-op', async () => {
    const res = await run('finish')
    assert.equal(res.status, 0)
    assert.equal(seen.length, 0)
  })

  it('a missing OIDC permission is a clear error', async () => {
    const res = await run('start', { ACTIONS_ID_TOKEN_REQUEST_URL: '' })
    assert.equal(res.status, 1)
    assert.match(res.stderr, /id-token: write/)
  })
})
