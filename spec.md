# plan.md — Conquest (Discord bot)

## Overview

**Conquest** is a persistent, server-wide strategy game run by a Discord bot of the same name. Players join real-world countries, gather resources cooperatively in private country channels, and vote to invade other countries, staking troops and supplies of their choosing. Conquered countries are absorbed: their players join the winner, their stockpile is looted, and their territory is locked to the winner. Failed invasions hand the attacker's entire stake to the defender. The game ends when one country dominates, then resets automatically.

Use the name consistently: the bot's Discord identity, repo/package name (`conquest`), README, and all user-facing copy (help pages, game log posts, error messages) should say **Conquest** — never "the bot."

**Stack:** TypeScript, Node.js (LTS), discord.js v14+, SQLite for persistence (better-sqlite3 or Prisma + SQLite — implementer's choice). All interactions via slash commands and message-component buttons. No message-content intent required.

**Toolchain:** the development environment is provided by a **Nix flake using flake-parts** (see "Toolchain" section below). All tooling (Node, package manager, etc.) must come from the flake's devShell — do not assume globally installed tools.

---

## Core concepts

### Countries
- The game uses the full list of real-world countries (ship a static JSON of ISO 3166-1 entries: code, name, flag emoji). All countries always "exist."
- A country is **inactive** until its first player joins, at which point it becomes **active** and gets a private channel.
- A country that is conquered is marked **defeated** and becomes a territory of the winner: not joinable, displayed as owned by the conqueror. Its channel is kept as a read-only archive (see Channels & roles).
- If a country's last player leaves (or leaves the server), the country **deactivates**: its channel and role are deleted, its stockpile is wiped, and any territories it owned become unclaimed (inactive, joinable again, their archived channels deleted).

### Players
- A player belongs to at most one country per guild.
- `/join <country>` — join any joinable country (inactive, or active; **defeated countries are not joinable**). Autocomplete should only offer joinable countries. Joining an inactive country activates it.
- `/leave` — leave your country. Apply a rejoin cooldown (default 24h) to prevent country-hopping during invasions. If a player leaves mid-invasion, their pending votes are discarded and vote thresholds recalculated.
- All game state is per-guild; the bot must support multiple guilds with isolated games.

### Channels & roles
- Admin runs `/setup category:<category>` once (require Manage Guild permission). The bot stores the category ID and manages all country channels inside it. Warn if the category is non-empty, but allow it.
- **Permissions are role-based, not per-user overwrites.** When a country activates, the bot creates a country role (e.g. `🇫🇷 France`) and a private text channel in the category (e.g. `🇫🇷-france`) with overwrites: deny @everyone, allow the country role (View + Send). Joining/leaving/transferring players means adding/removing the role — never editing channel overwrites per user. (Guild role cap is 250, so ≤50 country roles is safe.)
- **On defeat (conquest):** the channel is NOT deleted. It becomes a read-only archive: deny Send for the defeated country's role and grant the **winning country's role View (read-only) access**, so the conquerors can browse the fallen country's message history. Rename with a marker (e.g. `🏳️-france`). Delete the defeated country's role after the transfer completes (its members now hold the winner's role and can still read the archive through it), and record the archive as belonging to the winner. If the winner is later conquered, ownership of its archives transfers again — update each archived channel's overwrites to the new winner's role.
- Discord caps categories at 50 channels, and **archived defeated channels count toward the cap**. The cap only matters when a join would activate a new country (create a channel); joining an already-active country is always allowed. If activation would exceed the cap, refuse with an ephemeral error: "Country limit reached — join an existing country instead." The `/join` autocomplete should stop offering inactive countries while at cap, and offer them again once slots free up (deactivation, or game reset). Since conquest no longer frees slots, hitting the cap increasingly funnels players into existing countries late-game — acceptable, but note it in the README.
- A public **game log channel** (created by setup, e.g. `#war-room`) posts global events: country activated, invasion declared, battle results, conquests, game end/reset.

---

## Resources

Three resource types, pooled at the **country level** (shared stockpile, since planning is cooperative):

| Resource | Gather command | Default cooldown (per player) | Yield |
|---|---|---|---|
| Food | `/farm` | 30 min | random 8–15 |
| Gold | `/mine` | 30 min | random 8–15 |
| Troops | `/recruit` | 60 min | converts 10 gold + 10 food → random 3–6 troops; fails with message if stockpile insufficient |

- Cooldowns are per-player per-command, tracked as timestamps in the DB (survive restarts). Larger countries generate more, which self-balances since they are bigger targets.
- `/resources` — show your country's stockpile and your own cooldown timers (ephemeral).
- All numbers above (yields, costs, cooldowns) must live in a single config/constants module so admins/devs can tune them easily. Stretch goal: per-guild overrides via an admin command.

---

## Invasions

### Declaring (attacker side)
1. Any player runs `/invade country:<target> troops:<amount> [gold:<amount>] [food:<amount>]`. The attacker chooses their **stake**: troops are mandatory (minimum 1), gold and food are optional supplies.
   - Validations: caller is in an active country; target is active, not the caller's own country, and not defeated; attacker stockpile covers the full stake; attacker country is not on invasion cooldown; neither country is already involved in a pending invasion; target is not under new-country protection.
2. This opens an **attack vote** in the attacker's country channel: a Components V2 vote message (see UI & message design) showing target and the full committed stake, with Approve/Reject buttons.
   - Threshold: strict majority of the country's current player count. A 1-player country passes with their own single vote (the initiator's `/invade` counts as their Approve).
   - Window: 6 hours. If majority approval isn't reached in time, the vote fails and nothing is spent.
3. On approval, the entire stake is **escrowed** (removed from attacker stockpile immediately), the invasion is declared publicly in the game log **including the stake size** (big stakes should be visible drama), and the defender's channel is pinged.

### Defending
4. Defenders get a **defense window** (default 24h from declaration). Any defender may run `/defend troops:<amount> [gold:<amount>] [food:<amount>]` to propose a defense commitment (same stake structure), which opens a defense vote in their channel (same majority/button mechanics, window capped at the remaining defense time). Approved defense stakes are escrowed. Only one defense proposal may be pending at a time; a rejected proposal may be replaced by a new one within the window.
5. If the window ends with no approved defense, defense = 0.

### Resolution
6. At the end of the defense window (resolve at window end regardless of when the defense vote passes, so defenders can't probe timing). **Supplies boost power**: committed gold+food act as war supplies with diminishing returns —
   - `supplyBonus(side) = min((gold + food) / (2 × troops), 0.5)` — i.e. up to +50% power at 2 supplies per troop; beyond that, extra supplies add no power (but are still at stake).
   - `attackPower = troops × (1 + supplyBonus) × random(0.9–1.1)`
   - `defensePower = troops × (1 + supplyBonus) × 1.2 (home advantage) × random(0.9–1.1)`
   - Higher power wins. Ties go to the defender. A zero-troop side has zero power regardless of supplies.
7. **Attacker wins (conquest):**
   - Attacker suffers 50% casualties on committed troops (rounded up); surviving troops return. Committed gold/food supplies are **consumed by the campaign** (not returned). Defender's committed stake is destroyed in the fighting.
   - Defender's remaining (un-staked) stockpile is looted into the attacker's stockpile.
   - All defender players are transferred into the attacker's country: remove the defeated role, assign the winner's role, post a welcome message in the winner's channel.
   - The defeated country and **all territories it owned** become territories of the attacker (status `defeated`, owner = attacker).
   - Defender's channel is archived read-only per Channels & roles (winner's role gains view access; defeated role deleted). Result announced in game log.
8. **Defender wins:**
   - **The attacker's entire committed stake is captured by the defender**: staked troops, gold, and food all transfer into the defender's stockpile (troops are captured/defect rather than destroyed). This replaces the old "invasion resources are lost" rule — failed invasions now directly strengthen the target, so overreaching is dangerous.
   - Defender suffers 30% casualties on their committed troops (rounded up); the rest of their stake returns to their stockpile.
   - No other changes. Result announced in game log, including the captured haul.

### Cooldowns and protection
- After an invasion resolves (win or lose), the **attacking** country cannot declare again for 12h.
- A country that just successfully defended gets 12h of immunity from new invasions.
- **New-country protection:** a freshly activated country cannot be invaded for 48h (it may still invade others, which immediately voids its protection).
- All timers are stored as absolute timestamps in the DB. A periodic sweeper (every ~30s) checks for expired votes, defense windows, and protections; nothing may rely on in-memory timers alone, so the bot recovers cleanly from restarts.

---

## Win condition and reset

- Configurable **domination threshold** (default: 10 territories). When a country's territory count reaches the threshold, or when it is the only active country in the guild for 72 consecutive hours, it wins.
- On win: post a victory announcement in the game log (winner, roster, territory list, game duration), then **reset**: delete **all country roles and all country channels** (active and archived), wipe all countries/players/resources/invasions for the guild, keep the setup config, and start fresh. Players must `/join` again.
- Admin commands: `/game reset` (manual reset, confirm with a button), `/game config threshold:<n>` (set domination threshold).

---

## Commands summary

| Command | Who | Effect |
|---|---|---|
| `/setup category:<cat>` | Admin | Configure category + create game log channel |
| `/join country:<name>` | Anyone | Join a joinable country (autocomplete) |
| `/leave` | Player | Leave country (24h rejoin cooldown) |
| `/farm`, `/mine`, `/recruit` | Player | Gather resources (per-player cooldowns) |
| `/resources` | Player | Show country stockpile + own cooldowns (ephemeral) |
| `/invade country:<t> troops:<n> [gold] [food]` | Player | Start attack vote with a multi-resource stake |
| `/defend troops:<n> [gold] [food]` | Player (under invasion) | Start defense vote with a multi-resource stake |
| `/map` | Anyone | Rendered world-map image + legend in one V2 card; see Map rendering below |
| `/country [name]` | Anyone | Details for one country (players, territories, protection/cooldown status; stockpile visible only to its own members) |
| `/help [topic]` | Anyone | Paginated V2 help pages; see Help system below |
| `/game reset` / `/game config` | Admin | Admin controls |

---

## UI & message design (Components V2)

All bot-authored game messages use **Discord Components V2** (display components), not classic embeds. Messages must set the `IsComponentsV2` flag, which disables the legacy `content`, `embeds`, `poll`, and `stickers` fields — so there is no mixing: every game message is built from `ContainerBuilder`, `TextDisplayBuilder`, `SectionBuilder`, `SeparatorBuilder`, `MediaGalleryBuilder`, `ThumbnailBuilder`, and `FileBuilder` (discord.js v14.19+).

- **Vote messages (attack & defense):** a Container with an accent color (attacker/defender color), TextDisplays for the proposal details (target, committed troops, deadline as a Discord relative timestamp `<t:...:R>`), a Separator, a live-updating tally line (edited on each vote), and an ActionRow with Approve/Reject buttons. Disable the buttons and restyle the Container when the vote resolves.
- **Battle results & game log posts:** Containers with a result-colored accent, a Section pairing the headline with a flag thumbnail, and for conquests the freshly rendered map PNG attached via MediaGallery/File component.
- **`/map`:** the PNG via a MediaGallery or File component inside a Container, with the legend/leaderboard as TextDisplays beneath it — one coherent card instead of embed-plus-attachment.
- **`/help`:** Containers per page; pagination buttons and the topic select menu in ActionRows at the bottom. Same stateless customIds as specced.
- **`/resources`, `/country`:** compact Containers using Sections with a flag thumbnail accessory, Separators between resource/territory groups.
- Mind the limits: up to 40 components and 4,000 text characters per message — paginate long territory lists rather than truncating. A message sent as V2 cannot be edited back to legacy content, which is fine since every game message starts as V2.
- General UX rules: Discord native timestamps for all deadlines/cooldowns (auto-localized, live-counting); ephemeral replies for anything personal (gather results, errors, help); public messages only for shared state; every error message states what to do next, not just what failed.

### Autocomplete & argument UX
Every argument-taking command uses the most helpful input mechanism Discord offers:

- `/join country:` — **autocomplete**, filtered to joinable countries only (inactive + not at channel cap, or active). Show flag emoji + name; match on name substring and ISO code.
- `/invade country:` — **autocomplete**, filtered to *currently legal targets* for the caller's country: active, not self, not defeated, not protected, not immune, not already in an invasion. An empty list is itself informative ("no valid targets right now").
- `/country name:` — **autocomplete** over all activated-this-game countries (active + defeated), so people can look up fallen empires too.
- `/invade` and `/defend` resource options (`troops:`, `gold:`, `food:`) — integer options with **numeric autocomplete suggestions** derived from the live stockpile of that resource (e.g. 25% / 50% / 75% / all, with the amounts shown), while still accepting any typed number.
- `/help topic:` and `/map region:` — fixed **choices** (not autocomplete), since the sets are small and static.
- `/setup category:` — native **channel option** restricted to category-type channels, so admins pick from a picker instead of typing IDs.
- Autocomplete responses must return within Discord's ~3s window — serve them from the DB/cache, never from Discord API calls.
- **Autocomplete is a suggestion UI, not validation**: users can submit values not in the list, so every command revalidates server-side (the validation rules in Invasions apply regardless of what autocomplete offered).

---

- `/help [topic]` with an optional topic argument (as a slash-command choice list): `about`, `guide`, `resources`, `invasions`, `rules`. No argument → an index page listing topics.
  - `about` — what the game is, elevator pitch, how a round ends.
  - `guide` — how to start playing: join a country, gather, coordinate, invade.
  - `resources` — the three resources, gather commands, cooldowns, recruit costs.
  - `invasions` — vote flow, defense window, resolution math, cooldowns/protections.
  - `rules` — leave/rejoin cooldowns, one-invasion-at-a-time, channel cap, win condition.
- Each topic is one or more Components V2 Containers with **Previous/Next buttons for pagination** where content exceeds one page; a topic **select menu** on the message lets users switch topics without re-running the command. Replies are ephemeral so help doesn't clutter channels.
- Help content should render numbers (cooldowns, costs, thresholds) from the same config/constants module the game uses, so the docs never drift from actual behavior.
- Pagination buttons must be stateless (`help:<topic>:<page>` customIds) like the vote buttons, so they survive restarts.

---

## Map rendering (`/map`)

Render a flat world map image showing the game state, attached to the `/map` reply as a PNG.

- **Base asset:** ship a public-domain world map SVG in the repo where each country's `<path>` carries its ISO 3166-1 alpha-2 code as an id/class (Wikimedia's `BlankMap-World.svg` and Natural Earth-derived SVGs are public domain and structured this way). This must use the same ISO codes as the countries JSON so lookups are trivial.
- **Coloring:** don't draw geometry — just rewrite fills on the base SVG per render:
  - Inactive: light gray.
  - Active: a stable, distinct color per country, assigned deterministically (hash of country code into a curated palette of ~20 high-contrast colors) so a country keeps its color across renders.
  - Defeated territory: the **owner's color at reduced opacity/lightness**, so empires read as one blob with a bright capital.
  - Optionally stroke countries currently involved in a pending invasion in red.
- **Rasterization:** manipulate the SVG as a string/DOM (cheerio or targeted string replacement on the id/class), then rasterize with `@resvg/resvg-js` (preferred: fast, napi prebuilt binaries) or `sharp` as fallback. No headless browser. Under Nix, if napi prebuilds misbehave in the devShell, fall back to nixpkgs' `resvg` CLI invoked as a subprocess — abstract the rasterizer behind a small interface so this is swappable.
- **Message:** attach the PNG inside a Container (MediaGallery/File component) with a compact legend as TextDisplays (color swatch emoji ≈ approximation, or just a text list): active countries with player counts and territory counts, sorted by territories. Include leader progress toward the domination threshold.
- **Caching:** rendering is cheap but not free — cache the PNG keyed by a hash of the relevant state (statuses + owners + pending invasions) and reuse until state changes. Also post the fresh map to the game log automatically after every conquest.
- **Nice-to-have:** `/map` option `region:<continent>` cropping the viewBox to a continent for readability on mobile.

---

## Data model (SQLite)

- `guild_config(guild_id PK, category_id, log_channel_id, domination_threshold, created_at)`
- `countries(guild_id, code PK w/ guild, name, status ENUM[inactive, active, defeated], owner_code NULL, channel_id NULL, role_id NULL, food, gold, troops, activated_at, protected_until, invade_cooldown_until, defense_immunity_until)` — defeated countries keep `channel_id` (the archive) but have `role_id` NULL after their role is deleted.
- `players(guild_id, user_id PK w/ guild, country_code, joined_at, rejoin_cooldown_until)`
- `gather_cooldowns(guild_id, user_id, command, next_available_at)`
- `invasions(id PK, guild_id, attacker_code, defender_code, attack_troops, attack_gold, attack_food, defense_troops NULL, defense_gold NULL, defense_food NULL, status ENUM[attack_vote, defense_window, resolved_attacker_win, resolved_defender_win, cancelled], attack_vote_deadline, defense_deadline, created_at, resolved_at)`
- `votes(id PK, invasion_id, kind ENUM[attack, defense], user_id, choice ENUM[approve, reject], created_at)` — one row per voter per vote; changing a vote updates the row.

All state-mutating operations (escrow, resolution, transfers) must be wrapped in transactions.

---

## Toolchain (Nix flake + flake-parts)

- Provide a `flake.nix` built on **flake-parts** (`inputs.flake-parts`, `nixpkgs`), using `perSystem` for the standard systems (`x86_64-linux`, `aarch64-linux`, `x86_64-darwin`, `aarch64-darwin`).
- `perSystem.devShells.default` must include: Node.js LTS (`nodejs_22` or current LTS in nixpkgs), the chosen package manager (pnpm preferred, else npm from the Node package), `typescript` / `typescript-language-server` for editor support, and `sqlite` for inspecting the DB. If better-sqlite3 is chosen, include the native build prerequisites (`python3`, `pkg-config`, a C/C++ toolchain via `stdenv`) so `node-gyp` builds inside the shell.
- Commit a `flake.lock`. Optionally add an `.envrc` with `use flake` for direnv users.
- Nice-to-have, not required for v1: a `perSystem.packages.default` that builds the bot (e.g. via `buildNpmPackage`/`pnpm2nix`) and a NixOS module or systemd unit example for deployment. Don't block gameplay work on this.
- CI/scripts (`lint`, `test`, `build`, `dev`) should run via the devShell (`nix develop -c <cmd>`) so they work identically everywhere.

## Implementation notes and edge cases

- **Restart safety:** on boot, reload all pending invasions/votes and re-register button collectors (or handle button interactions statelessly by parsing `customId` like `vote:<invasionId>:<kind>:<choice>` and validating against the DB — prefer this stateless approach).
- **Member leaves guild:** treat as `/leave` without cooldown; recalculate any pending vote thresholds; if country hits 0 players mid-invasion, cancel the invasion and refund the other side's escrow.
- **Concurrency:** a country may be involved in at most one invasion at a time (as attacker or defender). Reject overlapping declarations.
- **Permissions failures:** if the bot lacks channel-management or **Manage Roles** permissions, fail loudly with an actionable error message. Validate both during `/setup`. Country roles must sit below the bot's highest role in the hierarchy (they will, since the bot creates them).
- **Rate limits:** channel creation/edits, role creation/deletion, and especially **bulk role assignment during a conquest transfer** (every defeated player gets the winner's role) should be queued/serialized to respect Discord rate limits; a large transfer may take a minute — post a progress/"transfer complete" message.
- **Announcements:** every state change that affects more than one country goes to the game log channel; country-internal events (votes, gather results) stay in country channels or ephemeral replies.
- **Testing:** unit-test the resolution math, vote-threshold logic, and conquest transfer (players, territories, loot) with an in-memory DB. Provide a dev mode with drastically shortened timers for manual playtesting.

## Suggested build order

1. Flake scaffold (flake-parts devShell), project scaffold, DB layer, guild config, `/setup`.
2. Countries + `/join`/`/leave` + role & channel lifecycle (create, archive-on-defeat, delete-on-deactivate/reset) + `/country`; text-only `/map` placeholder.
3. Resources: gather commands, cooldowns, `/resources`.
4. Invasion pipeline: attack vote → escrow → defense window → resolution → conquest transfer.
5. Cooldowns, protections, win condition, reset flow.
6. Map rendering: SVG recolor pipeline, rasterizer abstraction, caching, auto-post after conquests.
7. Polish: Components V2 message design, flags, game log formatting, `/help` system, dev mode, tests.
