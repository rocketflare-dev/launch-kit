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

  it('parseArgs defaults the display name and the domain', () => {
    assert.deepEqual(
      (({ slug, display, domain }) => ({ slug, display, domain }))(parseArgs(['acme-portal'])),
      { slug: 'acme-portal', display: 'Acme Portal', domain: 'acme-portal.example.com' }
    )
    assert.throws(() => parseArgs(['a']), UsageError)
  })
})
