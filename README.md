# Launch Kit

The smallest app that passes the **Launch kit contract**. It is a template: a company forks it,
fills it in, and registers the fork with [Launch](https://github.com/rocketflare-dev) as the kit its
people build apps from. Start with [FORKING.md](FORKING.md).

What is in it:

- **One Cloudflare Worker** (`apps/web`). A Hono API serves `GET /api/health`, `GET /api/ready`,
  OIDC sign-in, a signed-cookie session, `GET /api/me` and an example `notes` resource. The Worker
  also serves a static page built by Vite.
- **Neon Postgres** through Drizzle: HTTP for queries and a WebSocket pool for transactions
  (`DATABASE_DRIVER=neon`), or postgres.js on a local Docker Postgres. There is one migration, and
  it grants the `app` role.
- **The contract** in [`launch.kit.json`](launch.kit.json), and a dependency-free conformance check
  in [`scripts/kit-check.mjs`](scripts/kit-check.mjs).
- **The scripts Launch drives**: `init` (make a copy into an app), `bootstrap` (first run, or a
  session against a Neon branch), `dev`, `gate` (lint, typecheck, test, build), `upgrade` (port a
  later kit release into an app), and the deployer client for
  [deployer protocol v1](docs/DEPLOYER.md).
- **CI**: `ci.yml` (the `Gate` check), `deploy.yml` (tag → staging, release → production) and
  `kit.yml` (the kit's own conformance and scaffold checks).
- **Agent instructions**: [CLAUDE.md](CLAUDE.md) (also `AGENTS.md`), and the `setup` and `upgrade`
  skills in `.claude/skills/`.

```bash
pnpm bootstrap                 # Node 24, pnpm 10, Docker: install, Postgres, .dev.vars, migrate, dev
pnpm gate                      # lint, typecheck, test, build
node scripts/kit-check.mjs     # does it still conform?
```

**One package, inside a pnpm workspace.** The app lives in `apps/web` and the root holds only the
scripts and tooling. That matches the layout Launch already drives for the Rocketflare kit
(`apps/web/wrangler*.toml`, `apps/web/.dev.vars`), and it leaves room for a CLI or a shared package
later without moving anything. There is no shared package today, because nothing needs one yet.

License: MIT.
