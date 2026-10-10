/**
 * The rename rule `scripts/init.mjs` applies to a copy and `scripts/upgrade.mjs` applies to the
 * kit's later files: the kit's tokens (`scaffold.tokens` in launch.kit.json) → the app's. Order:
 * domain, display name, slug. The slug is replaced where it stands alone or as a prefix
 * (`launch-kit-staging`, `@launch-kit/web`) — never after a `/`, `.`, `-` or a word character, so a
 * repository path (`owner/launch-kit`) keeps naming the kit.
 */
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function replaceTokens(text, from, to) {
  let out = text
  if (from.domain && from.domain !== to.domain) out = out.split(from.domain).join(to.domain)
  if (from.display && from.display !== to.display) out = out.split(from.display).join(to.display)
  if (from.slug && from.slug !== to.slug) {
    out = out.replace(new RegExp(`(?<![\\w/.-])${escapeRe(from.slug)}(?![a-z0-9])`, 'g'), to.slug)
  }
  return out
}

/** A kit manifest's tokens: `scaffold.tokens`, else derived from `kit`. */
export function kitTokens(manifest) {
  return (
    manifest?.scaffold?.tokens ?? {
      slug: manifest?.kit?.id,
      display: manifest?.kit?.name,
      domain: `${manifest?.kit?.id}.dev`,
    }
  )
}
