/**
 * A fixed-window counter in KV (`RATE_LIMIT_KV`): at most `limit` hits per client per window.
 * KV is eventually consistent, so this slows abuse rather than counting exactly — enough for
 * sign-in. The key is the client IP Cloudflare reports.
 */
export async function rateLimited(
  kv: KVNamespace,
  bucket: string,
  client: string,
  limit = 30,
  windowS = 60
): Promise<boolean> {
  const window = Math.floor(Date.now() / 1000 / windowS)
  const key = `rl:${bucket}:${client}:${window}`
  const count = Number((await kv.get(key)) ?? '0') + 1
  if (count > limit) return true
  // KV's minimum TTL is 60 s.
  await kv.put(key, String(count), { expirationTtl: Math.max(60, windowS * 2) })
  return false
}
