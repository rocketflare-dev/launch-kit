# Changelog

## Unreleased

## 0.1.1

- `scripts/kit-check.mjs`: an app manifest with `"app": null` is the kit itself, not a copy, so
  only its `kit` block is checked and the names are checked against the kit's slug. A copy's
  app manifest still needs `kit.id`, `kit.version` and `kit.commit` (`init` writes all three).
- `scripts/lib/kit-manifest.mjs` matches Launch's schema on three optional fields: `kit.repo` (a
  non-empty string), `worker.titles` (binding → title suffix, lowercase letters, digits and
  dashes) and `launchProvides.oidc.label` (an UPPER_SNAKE env name).
- The checker and its three libraries are shared with the Rocketflare kit
  (`rocketflare-dev/rocketflare`); each file's header names the other copy, and the two change
  together.

## 0.1.0

- First release: the smallest app that passes the Launch kit contract (schema 1). It has a Hono
  Worker with health, readiness, OIDC sign-in, a signed-cookie session, `/api/me` and an example
  `notes` resource, and serves a static UI. It uses Neon Postgres through Drizzle (HTTP plus a
  WebSocket pool) and runs on local Docker Postgres. It ships `launch.kit.json`, the conformance
  check `scripts/kit-check.mjs`, the `init`, `bootstrap`, `dev`, `gate` and `upgrade` scripts,
  CI with the `Gate` check, the deployer-protocol-v1 deploy workflow, and the `setup` and
  `upgrade` skills.
