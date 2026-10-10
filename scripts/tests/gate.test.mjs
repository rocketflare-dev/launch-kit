import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { GATE_STEPS, gateList, parseGateArgs } from '../lib/gate-lib.mjs'
import { findVerified, isAttestation, planLookup } from '../lib/gate-verified-lib.mjs'
import { runNode } from './helpers.mjs'

describe('pnpm gate', () => {
  it('--list --json prints gate list schema 1 with the steps Launch runs', () => {
    const res = runNode('scripts/gate.mjs', ['--list', '--json'])
    assert.equal(res.status, 0)
    const list = JSON.parse(res.stdout)
    assert.equal(list.schema, 1)
    assert.deepEqual(
      list.steps.map(s => s.id),
      ['lint', 'typecheck', 'test', 'build']
    )
    for (const step of list.steps) {
      assert.equal(typeof step.command, 'string')
      assert.equal(step.database, step.id === 'test')
    }
    assert.deepEqual(gateList(), list)
  })

  it('runs named steps in gate order and refuses unknown ones', () => {
    assert.deepEqual(parseGateArgs(['test', 'lint']).steps, ['lint', 'test'])
    assert.deepEqual(parseGateArgs(['--skip', 'build']).steps, ['lint', 'typecheck', 'test'])
    assert.match(parseGateArgs(['deploy']).error, /unknown step/)
    assert.match(parseGateArgs(['--json']).error, /--json only applies/)
    assert.equal(GATE_STEPS.length, 4)
  })

  it('exits 2 on a usage error', () => {
    assert.equal(runNode('scripts/gate.mjs', ['nope']).status, 2)
  })
})

describe('gate-verified (ci.yml: was this tree already gated by Launch?)', () => {
  const sha = 'a'.repeat(40)
  const head = 'b'.repeat(40)
  const tree = 'c'.repeat(40)

  it('looks nothing up without LAUNCH_GATE_APP_ID, or on another event', () => {
    assert.equal(
      planLookup({ appId: '', eventName: 'pull_request', sha, prHeadSha: head }).lookup,
      false
    )
    assert.equal(planLookup({ appId: '7', eventName: 'workflow_call', sha }).lookup, false)
  })

  it('trusts only a successful launch/gate check run from the app, for this tree', () => {
    const run = {
      app: { id: 7 },
      name: 'launch/gate',
      status: 'completed',
      conclusion: 'success',
      external_id: `tree:${tree}`,
    }
    assert.equal(isAttestation(run, { appId: 7, tree }), true)
    assert.equal(isAttestation({ ...run, app: { id: 8 } }, { appId: 7, tree }), false)
    assert.equal(isAttestation({ ...run, external_id: 'tree:x' }, { appId: 7, tree }), false)
  })

  it('finds the attestation on a pull request head', async () => {
    const plan = planLookup({ appId: '7', eventName: 'pull_request', sha, prHeadSha: head })
    const api = async p =>
      p.startsWith(`commits/${head}/check-runs`)
        ? {
            check_runs: [
              {
                app: { id: 7 },
                name: 'launch/gate',
                status: 'completed',
                conclusion: 'success',
                external_id: `tree:${tree}`,
              },
            ],
          }
        : { check_runs: [] }
    assert.equal((await findVerified({ tree, plan, api })).verified, true)
  })
})
