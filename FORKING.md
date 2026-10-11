# Forking the kit

This repository is a **meta-kit**: the smallest app that passes the Launch kit contract
(`launch.kit.json`, schema 1). To give your people something to build with, a company forks it,
fills it in with its own UI, rules and examples, and registers the fork with Launch as a kit. Every
app Launch creates from the fork is a copy of it. The fork stays the kit, so its later releases
can be ported into those apps.

`scaffold.kitOnly` deletes this file from every copy.

## 1. Fork it

Click **Use this template** on GitHub, or fork it, into your organisation. A private repository
works: Launch reads it through its GitHub App installation.

Then decide on three names and use them consistently:

| Token (`scaffold.tokens`) | Today | Becomes in every app |
|---|---|---|
| `slug` | `launch-kit` | the app's slug: the Worker name, every resource name prefix, package names |
| `display` | `Launch Kit` | the app's display name |
| `domain` | `launch-kit.dev` | the app's domain |

If you rename the tokens in the files, for example to `acme-kit`, change `scaffold.tokens` in
`launch.kit.json` to match. Also change `kit.id`, `kit.name`, `kit.description` and `kit.repo`
(your fork's clone URL), so that `node scripts/init.mjs` and `node scripts/kit-check.mjs` read the
same names you wrote. Keep each token distinctive. `init` replaces every occurrence of it, so a
display name such as "App" would rewrite far too much.

## 2. What to replace

These parts are yours. Change them freely:

- **`CLAUDE.md`**, the instructions every session agent follows. It is how the kit governs what
  gets built with it, so put your architecture, conventions, review rules and forbidden patterns
  here. Keep the "contract" table unless you change the contract itself.
- **The UI.** `apps/web/src/ui` is a plain HTML page with one script. Swap in React, Svelte or
  anything else that builds into `apps/web/dist/ui`. Vite on `DEV_UI_PORT` must proxy `/api` and
  `/auth` to `DEV_API_PORT`.
- **The API.** Keep the health routes and the sign-in, and add your own routes in
  `apps/web/src/app.ts`, or split them into files.
- **The example.** The `notes` table, its routes and its tests show the pattern. Replace them with
  yours, delete the table in a new migration, or keep it.
- **Bindings.** Add KV, Queues, R2, Durable Objects, Workflows or Workers AI to **both** tomls
  (see the CLAUDE.md rules).
- **Skills.** `.claude/skills/setup` and `.claude/skills/upgrade` are starting points. Add skills
  for your own workflows.
- **README.md** and **docs/**.

## 3. What not to touch

Launch drives every app through these. Change them only together with `launch.kit.json`, and run
`node scripts/kit-check.mjs` after any change.

- `.github/workflows/deploy.yml`: the triggers (a tag `X.Y.Z` deploys staging, a published release
  deploys production), the `environment` dispatch input, `permissions: id-token: write`, and the
  `deployer.mjs start → upload → activate → finish` steps. Launch's deployer only accepts a token
  from **this file in this repository**, so do not move the steps into a reusable workflow.
- `scripts/deployer.mjs`, `scripts/bundle.mjs` and `docs/DEPLOYER.md` (protocol v1).
- `GET /api/health` and `GET /api/ready` (`health` in the manifest).
- The sign-in paths, `apps/web/src/auth/paths.ts`: `/auth/callback` (where sign-in returns,
  `launchProvides.oidc.callbackPath`) and `/` (where a sign-out lands, `signedOutPath`). Launch
  registers `<app url><path>` with the app's OIDC client, so a path changed in one place and not
  the other breaks sign-in.
- The variable names Launch sets (`launchProvides`): `APP_URL`, `DATABASE_URL`, `DATABASE_DRIVER`,
  `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `AUTH_OIDC_ONLY`,
  `BOOTSTRAP_ADMIN_EMAILS` and `SESSION_SECRET`. If you rename one, rename it in the manifest too.
- `pnpm gate` with its `--list --json` output (lint, typecheck, test, build), and the test step's
  `TEST_DATABASE_BRANCH` / `TEST_DATABASE_ENDPOINT` handling in `scripts/test.mjs`.
- The CI job named `Gate` and its `LAUNCH_GATE_APP_ID` step.
- `scripts/init.mjs`, `scripts/bootstrap.mjs` (`--db-url`, `--no-dev`, `--yes`,
  `KIT_BOOTSTRAP_SKIP`, `KIT_ALLOW_ROOT`) and `scripts/dev.mjs` (`DEV_UI_PORT`, `DEV_API_PORT`,
  `DEV_ALLOWED_HOSTS`).
- Resource naming in the tomls: `<slug>-<suffix>`, `-staging` in staging, ids as
  `<PLACEHOLDER>`, the two files the same shape, no routes.

`launch.kit.json` is checked in Launch with zod (`@launch/shared/kit-manifest`) and here with
`scripts/lib/kit-manifest.mjs`. Readers ignore fields they do not know, so you may add your own.

## 4. Check it

```bash
node scripts/kit-check.mjs --exec   # the static conformance check, plus the gate list
pnpm gate                           # the kit itself is green
```

The `Kit` workflow (`.github/workflows/kit.yml`) runs both on every push. It also proves that a
fresh copy works: init, then install, then the copy's own kit check and its gate. Launch runs the
same scaffold before it marks a kit verified.

## 5. Release a kit version

1. Bump `version` in the root `package.json` (for example to `0.2.0`).
2. Write `docs/upgrades/0.2.0.md`, the porting note for apps moving from the previous version:
   what changed, what an app must do by hand, and what to check. `scripts/upgrade.mjs` prints it
   during an upgrade, and the upgrade skill follows it. Add a section to `CHANGELOG.md`.
3. Commit, then tag the commit with exactly the version and push the tag:
   `git tag 0.2.0 && git push origin 0.2.0`. Kit tags must match `kit.tagPattern` (`X.Y.Z`).
4. Publish a GitHub release for the tag (`gh release create 0.2.0`). In the kit repository itself,
   `deploy.yml` skips everything, because there is nothing to deploy until an app exists.

## 6. Register the fork with Launch

A platform admin adds it once:

- in the UI: **Platform → Kits → Add kit**, then the repository and the tag; or
- from the CLI: `launch kits add <owner>/<repo> --tag 0.2.0`.

Launch reads `launch.kit.json` at that tag and runs the conformance check (the static rules here,
plus the scaffold). Once the kit is verified, people can pick it in **Create app**. To move the kit
forward, re-pin it to a newer tag (`launch kits pin`). Existing apps then show an upgrade.
