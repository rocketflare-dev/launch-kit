/**
 * scripts/init.mjs's pure rules. The end-to-end run on a copy of the kit is kit-only
 * (kit-only/init.test.mjs): only the kit is a fresh kit.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseArgs, replaceTokens, UsageError } from '../init.mjs'

describe('init rules (pure)', () => {
  const from = { slug: 'launch-kit', display: 'Launch Kit', domain: 'launch-kit.dev' }
  const to = { slug: 'acme', display: 'Acme', domain: 'acme.com' }

  it('replaces the domain, the display name and the slug as a name or prefix', () => {
    assert.equal(
      replaceTokens(
        'name = "launch-kit-staging" APP_URL = "https://app.launch-kit.dev" "@launch-kit/web" Launch Kit',
        from,
        to
      ),
      'name = "acme-staging" APP_URL = "https://app.acme.com" "@acme/web" Acme'
    )
  })

  it('never rewrites a repository path or a longer word', () => {
    const text = 'github.com/rocketflare-dev/launch-kit.git launch-kitchen my-launch-kit'
    assert.equal(replaceTokens(text, from, to), text)
  })

  it('renames an app whose display name is its slug (wtf / wtf) without breaking its names', () => {
    // A copy init'ed as `wtf "wtf"`, renamed again: every `wtf` is ambiguous, and the slug's rule
    // (a name or prefix, never inside a path) wins, so a resource name never gets a display name.
    const app = { slug: 'wtf', display: 'wtf', domain: 'wtf.example.com' }
    const next = { slug: 'beta-desk', display: 'Beta Desk', domain: 'beta.example' }
    assert.equal(
      replaceTokens(
        'name = "wtf-staging" "@wtf/web" APP_NAME = "wtf" https://app.wtf.example.com guidemode/wtf',
        app,
        next
      ),
      'name = "beta-desk-staging" "@beta-desk/web" APP_NAME = "beta-desk" https://app.beta.example guidemode/wtf'
    )
    // The same names again change nothing; the first rename from the kit is unaffected.
    const text = 'name = "wtf-staging" APP_NAME = "wtf"'
    assert.equal(replaceTokens(text, app, app), text)
    assert.equal(
      replaceTokens('name = "launch-kit-staging" APP_NAME = "Launch Kit"', from, app),
      'name = "wtf-staging" APP_NAME = "wtf"'
    )
  })

  it('never lets one token rename inside another (slug inside the display or the domain)', () => {
    const app = { slug: 'acme', display: 'acme portal', domain: 'acme.example.com' }
    const next = { slug: 'zeta', display: 'Zeta Desk', domain: 'zeta.example' }
    assert.equal(
      replaceTokens('"acme-staging" APP_NAME = "acme portal" https://acme.example.com', app, next),
      '"zeta-staging" APP_NAME = "Zeta Desk" https://zeta.example'
    )
    const inSlug = { slug: 'wtf-app', display: 'wtf', domain: 'wtf-app.example.com' }
    assert.equal(
      replaceTokens('name = "wtf-app-staging" APP_NAME = "wtf"', inSlug, next),
      'name = "zeta-staging" APP_NAME = "Zeta Desk"'
    )
  })

  it('parseArgs defaults the display name and the domain', () => {
    assert.deepEqual(
      (({ slug, display, domain }) => ({ slug, display, domain }))(parseArgs(['acme-portal'])),
      { slug: 'acme-portal', display: 'Acme Portal', domain: 'acme-portal.example.com' }
    )
    assert.throws(() => parseArgs(['a']), UsageError)
  })
})
