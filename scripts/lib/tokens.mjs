/**
 * The rename rule `scripts/init.mjs` applies to a copy and `scripts/upgrade.mjs` applies to the
 * kit's later files: the kit's tokens (`scaffold.tokens` in launch.kit.json) → the app's. The domain
 * and the display name are replaced wherever they appear; the slug where it stands alone or as a
 * prefix (`launch-kit-staging`, `@launch-kit/web`) — never after a `/`, `.`, `-` or a word
 * character, so a repository path (`owner/launch-kit`) keeps naming the kit.
 *
 * One pass, the longest token first at each position, so no token is renamed inside another's
 * replacement or inside a longer token (a slug inside the domain or the display name, a display
 * name inside the slug). When the display name IS the slug (`wtf` / `wtf`) an occurrence cannot
 * say which it is; it is renamed as the slug, so a resource name never receives a display name
 * (`wtf-staging` → `Beta Desk-staging`). Such an app's display-name sites take the new slug.
 */
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function replaceTokens(text, from, to) {
  const rules = []
  if (from.domain && from.domain !== to.domain)
    rules.push({ len: from.domain.length, source: escapeRe(from.domain), to: to.domain })
  if (from.slug && from.slug !== to.slug)
    rules.push({
      len: from.slug.length,
      source: `(?<![\\w/.-])${escapeRe(from.slug)}(?![a-z0-9])`,
      to: to.slug,
    })
  if (from.display && from.display !== to.display && from.display !== from.slug)
    rules.push({ len: from.display.length, source: escapeRe(from.display), to: to.display })
  if (!rules.length) return text
  // Longest first; on a tie the order above (domain, slug, display) holds: sort is stable.
  rules.sort((a, b) => b.len - a.len)
  const re = new RegExp(rules.map(r => `(${r.source})`).join('|'), 'g')
  return text.replace(
    re,
    (...groups) => rules[groups.slice(1, rules.length + 1).findIndex(g => g !== undefined)].to
  )
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
