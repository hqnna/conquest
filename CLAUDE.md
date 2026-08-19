# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

The repo is pre-implementation: only `README.md`, `LICENSE.txt`, and `spec.md` exist. There is no source tree, `package.json`, or `flake.nix` yet.

`spec.md` is the authoritative design document for the whole project — read it before writing code. It defines game rules, the SQLite schema, UI conventions, the Nix toolchain, and a suggested build order (flake/DB/setup → countries & channels → resources → invasions → cooldowns/win → map → polish). When implementing, follow it rather than re-deriving decisions; if something in it is wrong or underspecified, say so and propose a change instead of silently diverging.

## What this is

**Conquest** — a Discord bot running a persistent, per-guild strategy game. Players join real-world countries, pool resources in private country channels, vote to stake troops/gold/food on invasions, and absorb conquered countries. One country dominating ends the round and auto-resets the guild's game.

Stack per spec: TypeScript, Node LTS, discord.js v14.19+, SQLite (better-sqlite3 or Prisma — implementer's choice). Slash commands and message components only; no message-content intent.

## Toolchain

All tooling comes from a Nix flake devShell built on flake-parts (`perSystem`, standard four systems) — do not assume globally installed Node/pnpm/tsc. Scripts and CI invoke through the shell:

```
nix develop -c <cmd>      # e.g. nix develop -c pnpm test
```

`flake.lock` is committed. Package scripts to provide: `dev`, `build`, `lint`, `test`.

## Architecture invariants

These cut across many files and are easy to violate one file at a time:

- **All state is per-guild.** Every query, cache key, and command handler scopes by `guild_id`; multiple guilds run isolated games in one process.
- **No in-memory timers.** Vote deadlines, defense windows, cooldowns, and protections are absolute timestamps in SQLite. A ~30s sweeper resolves anything expired, so the bot recovers cleanly from a restart mid-invasion.
- **Stateless component interactions.** Button/select `customId`s encode everything needed (`vote:<invasionId>:<kind>:<choice>`, `help:<topic>:<page>`) and are revalidated against the DB on click — never rely on registered collectors surviving a restart.
- **Permissions are role-based.** A country has a role and a private channel; joining/leaving means adding/removing the role. Never write per-user channel overwrites. Conquest archives the loser's channel read-only and grants the winner's role view access; the loser's role is deleted afterward.
- **Escrow and transfers are transactional.** Staking, resolution, looting, territory reassignment, and player transfer must be single DB transactions — a partial conquest is a corrupt game.
- **One invasion per country at a time**, as attacker or defender; declarations that would overlap are rejected.
- **Tunables live in one config/constants module** (yields, costs, cooldowns, windows, thresholds, casualty rates, supply-bonus cap). `/help` renders its numbers from that module so docs cannot drift from behavior.
- **Every bot message is Components V2** (`IsComponentsV2` flag, `ContainerBuilder`/`TextDisplayBuilder`/`SectionBuilder`/…). That flag disables `content`, `embeds`, `poll`, and `stickers` — there is no mixing with legacy embeds. Limits: 40 components, 4,000 chars; paginate rather than truncate.
- **Autocomplete is UX, not validation.** It must answer from DB/cache within ~3s and never call the Discord API; every command revalidates submitted values server-side.
- **Discord caps**: 50 channels per category, and archived defeated channels still count. Conquest never frees a slot. Only country *activation* is gated by the cap.
- **Map rendering** recolors a shipped ISO-coded world SVG (same codes as the countries JSON) and rasterizes it; the rasterizer sits behind a small interface so `@resvg/resvg-js` can be swapped for the nixpkgs `resvg` CLI. Cache PNGs keyed by a hash of relevant state.

## Testing

Everything gets unit tests — new modules and behavior changes land with their tests in the same commit, not as follow-up work. Pay particular attention to resolution math, vote thresholds, and conquest transfer (players, territories, loot), tested against an in-memory DB. Provide a dev mode with drastically shortened timers for manual playtesting.

## Style, lint, and commits

- **Google style.** ESLint and the formatter follow Google's rules — use `gts` (Google TypeScript Style, which ships the ESLint config and formatter together) rather than hand-rolling a config. Don't add per-file disables to dodge a rule; fix the code, or change the shared config deliberately.
- **Format, lint, and test must all pass before every commit.** Run them (`nix develop -c pnpm format`, `... lint`, `... test`) and get a clean result first — never commit with a known failure and a note to fix it later.
- **Commits are logical and incremental.** One coherent change per commit, each leaving the tree green. Don't batch unrelated work, and don't split so finely that individual commits don't build.
- **Conventional Commits** for messages: `type(scope): summary` — e.g. `feat(invasions): escrow attacker stake on vote approval`, `fix(map): keep country colors stable across renders`, `test(resolution): cover tie goes to defender`. Types in use: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `build`, `ci`.

## Naming

User-facing copy, package name, and the bot identity all say **Conquest** — never "the bot."
