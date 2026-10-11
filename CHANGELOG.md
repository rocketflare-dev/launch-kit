# Changelog

## Unreleased

## 0.1.3

- `scripts/kit-check.mjs` accepts a provisioned copy. Launch's `write_config` commits an app's
  real KV ids into its tomls, and the checker refused every real id outside `--provisioned`
  ("must be a <PLACEHOLDER> in the kit"), so every app Launch provisioned failed its own Gate. Now
  the kit's ids must still be placeholders; a copy's may be placeholders (not yet provisioned) or
  real; `--provisioned` still requires real ids everywhere.
- No test judges the repository it runs in. The checker's tests run on a fixture kit built in a
  temp dir (`scripts/tests/fixtures/kit-fixture.mjs`), fresh and provisioned the way Launch's
  `write_config` does it. The tests of this repository's own files (its manifest, tomls and
  workflows parse) and the end-to-end `init` and `upgrade` runs on a copy of the repository moved
  to `scripts/tests/kit-only/`, which no app carries. Whether the kit conforms is kit.yml's
  `Kit check` step.
- kit.yml's `Scaffold a copy` provisions the copy as Launch does, checks it with `--provisioned`
  and runs its gate in that state.

## 0.1.2

- `scripts/lib/kit-manifest.mjs` matches Launch's schema on two additions:
  `launchProvides.generated[].kind` accepts `base64-32` (32 random bytes as standard base64, 44
  characters) as well as `hex64`, and `declaredConfig.plain` lists the names in `optional` that are
  not secrets (UPPER_SNAKE env names, default `[]`; absent, every optional name is a secret).

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
