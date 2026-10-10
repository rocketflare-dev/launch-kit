---
name: upgrade
description: Port a later release of the kit this app was made from into the app, as a three-way merge of the kit's own change plus its porting notes. Use when asked to upgrade the kit, update to kit X.Y.Z, or when a Launch upgrade session starts.
---

# Upgrade the app to a later kit release

The app records the kit it came from in `.launch-app.json` (`kit.id`, `kit.version`, `kit.commit`
and `kit.repo`). An upgrade ports the kit's change between that version and the target into this
app. It does not recreate the app, and it leaves the app's own work in place.

This is a **three-way merge, then your judgement.** `scripts/upgrade.mjs` merges every file the kit
changed, with the kit's names rewritten to the app's. It cannot know what a change *means*. The
porting notes and this skill cover that part.

## Rules

- **Never commit, push, tag or release.** Only edit files. Launch reviews and ships the result.
- Start from a clean tree (`git status`). If the tree is dirty, stop and say why.
- Never rewrite or delete an applied migration (`apps/web/migrations/`). If the kit's new schema
  needs DDL, change `apps/web/src/db/schema.ts` and run `pnpm db:generate`.
- Keep what the app changed on purpose. When the kit and the app disagree, the app's intent wins,
  unless the porting note says the kit's change is required (a contract or security fix).

## Steps

1. **Plan.** Run `node scripts/upgrade.mjs --to <X.Y.Z>`. It lists the files that would be
   updated, merged, added or deleted, any conflicts, and prints the **porting note** for every
   version crossed. Read every note before you change anything.
2. **Apply.** Run `node scripts/upgrade.mjs --to <X.Y.Z> --apply`. Exit 0 means the merge was clean.
   Exit 3 means it was applied with conflicts.
3. **Resolve.** For each file it lists as a conflict, edit out every `<<<<<<<` / `=======` /
   `>>>>>>>` block, keeping both intents where you can. `grep -rn '^<<<<<<<' .` must find nothing.
   Then do the hand steps each porting note lists.
4. **Check.** Run `pnpm install`, then `pnpm gate`, then `node scripts/kit-check.mjs`. Fix what
   fails, because the upgrade is not done until all three pass.
5. **Confirm** that `.launch-app.json` says `kit.version` is `<X.Y.Z>`.

## Result line

End your final message with exactly one line on its own:

- `LAUNCH-UPGRADE: DONE` when the upgrade is applied, every porting note is followed, the gate
  passes and `.launch-app.json` says the target version.
- `LAUNCH-UPGRADE: STOPPED` otherwise, with the reason on the line before it.

## By hand, outside Launch

```bash
git switch -c kit-upgrade-X.Y.Z
pnpm kit:upgrade --to X.Y.Z --apply   # same script
# resolve, pnpm install, pnpm gate, then commit and open a PR yourself
```

If the app came from a fork of the kit, `kit.repo` in `.launch-app.json` points at the fork. Pass
`--repo <url>` to read another.
