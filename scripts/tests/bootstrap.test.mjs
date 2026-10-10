import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { devVarsFor, parseArgs, UsageError } from '../bootstrap.mjs'
import { devPorts, parseDevVars, setDevVars } from '../lib/dev-vars.mjs'
import { neonEndpoint, testTarget } from '../test.mjs'

describe('bootstrap', () => {
  it('takes the session flags Launch passes', () => {
    const opts = parseArgs([
      '--db-url',
      'postgresql://u:p@ep-x.eu.aws.neon.tech/app',
      '--driver',
      'neon',
      '--no-install',
      '--no-dev',
      '--yes',
    ])
    assert.equal(opts.driver, 'neon')
    assert.equal(opts.dev, false)
    assert.ok(opts.skip.has('install'))
  })

  it('picks the neon driver for a Neon URL and postgres otherwise', () => {
    assert.equal(parseArgs(['--db-url', 'postgres://u@ep-x.neon.tech/db']).driver, 'neon')
    assert.equal(parseArgs([]).driver, 'postgres')
  })

  it('honours KIT_BOOTSTRAP_SKIP and refuses an unknown step', () => {
    assert.deepEqual([...parseArgs([], { KIT_BOOTSTRAP_SKIP: 'migrate,install' }).skip].sort(), [
      'install',
      'migrate',
    ])
    assert.throws(() => parseArgs([], { KIT_BOOTSTRAP_SKIP: 'seed' }), UsageError)
    assert.throws(() => parseArgs(['--db-url', 'mysql://x']), UsageError)
    assert.throws(() => parseArgs(['--what']), UsageError)
  })

  it('writes the dev vars and keeps an existing session secret', () => {
    const ports = { ui: 5173, api: 8787, allowedHosts: ['.preview.test'] }
    const vars = devVarsFor({
      dbUrl: 'postgres://x',
      driver: 'neon',
      ports,
      existing: { SESSION_SECRET: 'keep' },
    })
    assert.equal(vars.APP_URL, 'http://localhost:5173')
    assert.equal(vars.DEV_ALLOWED_HOSTS, '.preview.test')
    assert.equal(vars.SESSION_SECRET, 'keep')
    assert.match(
      devVarsFor({ dbUrl: 'x', driver: 'postgres', ports, existing: {} }).SESSION_SECRET,
      /^[0-9a-f]{64}$/
    )
  })
})

describe('.dev.vars and the dev ports', () => {
  it('sets keys in place and appends new ones, keeping comments', () => {
    const text = '# local\nA=1\nB="two"\n'
    assert.deepEqual(parseDevVars(text), { A: '1', B: 'two' })
    assert.equal(setDevVars(text, { B: '3', C: '4' }), '# local\nA=1\nB=3\nC=4\n')
  })

  it('reads the ports from the shell, then .dev.vars, then the defaults', () => {
    assert.deepEqual(devPorts({}, {}), { ui: 3000, api: 3001, allowedHosts: [] })
    assert.deepEqual(
      devPorts({ DEV_UI_PORT: '5173' }, { DEV_UI_PORT: '4000', DEV_API_PORT: '8787' }).ui,
      5173
    )
    assert.throws(() => devPorts({ DEV_UI_PORT: '80x' }, {}))
    assert.throws(() => devPorts({ DEV_UI_PORT: '3000', DEV_API_PORT: '3000' }, {}))
  })
})

describe('the test database (scripts/test.mjs)', () => {
  const url = 'postgresql://o:p@ep-cool-1234-pooler.eu-central-1.aws.neon.tech/app'

  it('runs on a Neon gate branch only with all three variables agreeing', () => {
    assert.equal(neonEndpoint(url), 'ep-cool-1234')
    const ok = testTarget({
      DATABASE_URL: url,
      TEST_DATABASE_BRANCH: 'gate-ab12-1',
      TEST_DATABASE_ENDPOINT: 'ep-cool-1234',
    })
    assert.deepEqual(ok, { ok: true, target: 'neon', url, driver: 'neon' })
    assert.equal(
      testTarget({
        DATABASE_URL: url,
        TEST_DATABASE_BRANCH: 'main',
        TEST_DATABASE_ENDPOINT: 'ep-cool-1234',
      }).ok,
      false
    )
    assert.equal(
      testTarget({
        DATABASE_URL: url,
        TEST_DATABASE_BRANCH: 'gate-ab12-1',
        TEST_DATABASE_ENDPOINT: 'ep-other',
      }).ok,
      false
    )
  })

  it('otherwise runs on a local database and refuses a remote one', () => {
    assert.equal(testTarget({}).target, 'local')
    assert.equal(testTarget({ TEST_DATABASE_URL: 'postgres://x@db.prod.test/app' }).ok, false)
  })
})
