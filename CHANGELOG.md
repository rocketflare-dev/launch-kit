# Changelog

## Unreleased

## 0.1.0

- First release: the smallest app that passes the Launch kit contract (schema 1). It has a Hono
  Worker with health, readiness, OIDC sign-in, a signed-cookie session, `/api/me` and an example
  `notes` resource, and serves a static UI. It uses Neon Postgres through Drizzle (HTTP plus a
  WebSocket pool) and runs on local Docker Postgres. It ships `launch.kit.json`, the conformance
  check `scripts/kit-check.mjs`, the `init`, `bootstrap`, `dev`, `gate` and `upgrade` scripts,
  CI with the `Gate` check, the deployer-protocol-v1 deploy workflow, and the `setup` and
  `upgrade` skills.
