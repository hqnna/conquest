# plan.md — Conquest (Discord bot)

## Overview

**Conquest** is a persistent, server-wide strategy game run by a Discord bot of the same name. Players join real-world countries, gather resources cooperatively in private country channels, and vote to invade other countries, staking troops and supplies of their choosing. An invasion that is answered becomes a war of attrition fought over many rounds, until one side has nothing left in the field and must reinforce or give up. Conquered countries are absorbed: their players join the winner, their stockpile is looted, and their territory is locked to the winner. The game ends when one country dominates, then resets automatically.

Use the name consistently: the bot's Discord identity, repo/package name (`conquest`), README, and all user-facing copy (help pages, game log posts, error messages) should say **Conquest** — never "the bot."

**Stack:** TypeScript, Node.js (LTS), discord.js v14+, SQLite for persistence (better-sqlite3 or Prisma + SQLite — implementer's choice). All interactions via slash commands and message-component buttons. No message-content intent required.

**Toolchain:** the development environment is provided by a **Nix flake using flake-parts** (see "Toolchain" section below). All tooling (Node, package manager, etc.) must come from the flake's devShell — do not assume globally installed tools.

---

## Core concepts

### Countries
- The game uses the full list of real-world countries (ship a static JSON of ISO 3166-1 entries: code, name, flag emoji). All countries always "exist."
- A country is **inactive** until its first player joins, at which point it becomes **active** and gets a private channel.
- A country that is conquered is marked **defeated** and becomes a territory of the winner: not joinable, displayed as owned by the conqueror. Its channel is kept as a read-only archive (see Channels & roles).
- A country's **territory count** is the land it holds: its own homeland plus every country it has conquered. A country that has taken nobody still holds one territory, its own.
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
- A public **war room** (created by setup, `#war-room`) posts global events: country activated, invasion declared, battle results, conquests, merges, game end/reset. It is not a broadcast channel: **everyone can talk in it**. Country channels are private to their members, so the war room is the only place countries can negotiate with one another — alliances, threats, and merge offers all happen there. Overwrites grant @everyone View, Read History, Add Reactions, Send Messages, Send in Threads, and Create Public Threads, and deny Create Private Threads (a private back room would put a conversation outside the country roles that govern it).

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
- All numbers above (yields, costs, cooldowns) live in a single config/constants module. Per-guild overrides are stored in `guild_settings` and resolved into a `Settings` object that everything the game reads goes through; `/game tune`, `/game settings`, and `/game reset-settings` are the admin commands. The tunables are declared once in a registry that drives the command choices, the bounds checking, and how a stored value is applied.

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
5. If the window ends with **no approved defense**, the invasion is a walkover: the attacker wins by default and the country is absorbed as a **voluntary merge**. Nothing was fought, so the attacker's entire committed stake returns to its stockpile.

### The war
An invasion is not settled in one roll. Once a defense takes the field, the two committed forces grind each other down over many rounds until one of them has nothing left.

6. **Power.** Committed gold+food act as war supplies with diminishing returns —
   - `supplyBonus(side) = min((gold + food) / (2 × troops), 0.5)` — capped at +50% power, which the formula reaches at **one** supply per troop. Beyond that extra supplies add no power, but are still at stake.
   - `power = troops × (1 + supplyBonus)`, and the defender's is multiplied by `1.2` for home advantage.
   - A zero-troop side has zero power regardless of supplies: supplies do not fight, they make troops fight harder.
7. **Rounds.** Every tick (default 1h) both sides lose a share of *everything* they committed — troops, gold, and food alike, each rolled separately with luck of 0.9–1.1.
   - `lossRate(side) = clamp(0.15 × enemyPower / ownPower, 0.05, 0.5)` — an even war costs both sides 15% a round; being outgunned two to one costs double, while the stronger side pays half. The clamps keep a single round survivable and every war finite.
   - Losses are computed for both sides from the same pre-tick state, so neither swings first and a mutual wipe-out is possible.
   - Each round is announced in both country channels.
8. **Reinforce or give up.** When a side's committed **troops** reach zero its force is spent, the fighting pauses, and its country is called on to answer within a reinforcement window (default 6h):
   - `/reinforce troops:<n> [gold] [food]` opens a vote in that country's channel, by the same majority as any other commitment. Approved reinforcements are escrowed from the country's stockpile, join the field, and the fighting resumes.
   - `/surrender` ends it immediately. So does letting the window run out: **silence is surrender**.
   - If the country's stockpile is fully drained it has nothing to send, and the war is lost on the spot without waiting out the window.
   - Only the side being asked may reinforce, and only while it is being asked. Reinforcement is the answer to a spent force, not a way to pour troops into a war at any moment.
9. **Attacker gives up (or is fought dry) — invasion fails:**
   - Whatever survives of the **attacker's** committed force marches home into its stockpile. It loses the war, not its army.
   - Whatever survives of the **defender's** committed force returns to the defender's stockpile.
   - The defender gets defense immunity; the attacker gets its invasion cooldown. No other changes. Result announced in game log.
10. **Defender gives up (or is fought dry) — conquest:**
    - Whatever survives of the attacker's committed force marches home.
    - Whatever the **defender** still had committed is captured by the attacker, along with everything else it owned.
    - Defender's remaining stockpile is looted into the attacker's stockpile.
    - All defender players are transferred into the attacker's country: remove the defeated role, assign the winner's role, post a welcome message in the winner's channel.
    - The defeated country and **all territories it owned** become territories of the attacker (status `defeated`, owner = attacker).
    - Defender's channel is archived read-only per Channels & roles (winner's role gains view access; defeated role deleted). Result announced in game log.

### Cooldowns and protection
- After an invasion resolves (win or lose), the **attacking** country cannot declare again for 12h.
- A country that just successfully defended gets 12h of immunity from new invasions.
- **New-country protection:** a freshly activated country cannot be invaded for 48h (it may still invade others, which immediately voids its protection).
- All timers are stored as absolute timestamps in the DB. A periodic sweeper (every ~30s) checks for expired votes, defense windows, war rounds due, reinforcement deadlines, and protections; nothing may rely on in-memory timers alone, so the bot recovers cleanly from restarts.

---

## Win condition and reset

- **Total conquest is the only way to win.** A country wins the moment it is the only active country left in the guild *and* it took at least one country by force. Both halves matter: the first country founded is alone until somebody else joins, and a lone survivor whose only rival quietly disbanded conquered nothing. There is no territory threshold and no last-country-standing clock — the round ends when one country holds every other, or it does not end.
- On win: post a victory announcement in the game log (winner, roster, territory list, game duration), then **reset**: delete **all country roles and all country channels** (active and archived), wipe all countries/players/resources/invasions for the guild, keep the setup config, and start fresh. Players must `/join` again.
- Admin commands: `/game reset` (manual reset, confirm with a button).

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
| `/reinforce troops:<n> [gold] [food]` | Player (force spent) | Vote to send fresh forces and continue the war |
| `/surrender` | Player (force spent) | Give up the war immediately |
| `/map` | Anyone | Rendered world-map image + legend in one V2 card; see Map rendering below |
| `/country [name]` | Anyone | Details for one country (players, territories, protection/cooldown status; stockpile visible only to its own members) |
| `/help [topic]` | Anyone | Paginated V2 help pages; see Help system below |
| `/game reset` | Admin | Wipe the world and start a fresh round |
| `/game settings` / `/game tune` / `/game reset-settings` | Admin | Per-server tuning |

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

- **Base asset:** ship a public-domain world map SVG in the repo where each country's `<path>` carries its ISO 3166-1 alpha-2 code as its `id`. Conquest generates it from Natural Earth data (public domain, via `world-atlas`) rather than fetching a prebuilt one, so the codes match the countries JSON by construction; the generator also emits a viewBox per continent for the `region` crop.
- **Coloring:** don't draw geometry — inject one `<style>` block per render, which outranks the fills already on the paths (a bare `path{}` default so that a `#FR{}` rule beats it):
  - Inactive: light gray.
  - Active: a stable, distinct color per country, assigned deterministically (hash of country code into a curated palette of ~20 high-contrast colors) so a country keeps its color across renders.
  - Defeated territory: the **owner's color at reduced opacity/lightness**, so empires read as one blob with a bright capital.
  - Optionally stroke countries currently involved in a pending invasion in red.
- **Rasterization:** manipulate the SVG as a string/DOM (cheerio or targeted string replacement on the id/class), then rasterize with `@resvg/resvg-js` (preferred: fast, napi prebuilt binaries) or `sharp` as fallback. No headless browser. Under Nix, if napi prebuilds misbehave in the devShell, fall back to nixpkgs' `resvg` CLI invoked as a subprocess — abstract the rasterizer behind a small interface so this is swappable.
- **Message:** attach the PNG inside a Container (MediaGallery/File component) with a compact legend as TextDisplays (color swatch emoji ≈ approximation, or just a text list): active countries with player counts and territory counts, sorted by territories. There is no progress bar to render: the win condition is holding everything.
- **Caching:** rendering is cheap but not free — cache the PNG keyed by a hash of the relevant state (statuses + owners + pending invasions) and reuse until state changes. Also post the fresh map to the game log automatically after every conquest.
- **Nice-to-have:** `/map` option `region:<continent>` cropping the viewBox to a continent for readability on mobile.

---

## Data model (SQLite)

- `guild_config(guild_id PK, category_id, log_channel_id, created_at, round_started_at, sole_active_code NULL, sole_active_since NULL)`
- `guild_settings(guild_id, key, value, set_at, PK (guild_id, key))` — one row per setting a guild has changed, holding the value in the unit an admin typed. Unknown keys and out-of-range values are ignored when resolving, so a tunable that was removed or narrowed cannot stop a guild's game working. — `round_started_at` is when the current round began (setup, or the last reset), so a victory can report how long it took.
- `countries(guild_id, code PK w/ guild, name, status ENUM[inactive, active, defeated], owner_code NULL, channel_id NULL, role_id NULL, food, gold, troops, activated_at, protected_until, invade_cooldown_until, defense_immunity_until)` — defeated countries keep `channel_id` (the archive) but have `role_id` NULL after their role is deleted.
- `players(guild_id, user_id PK w/ guild, country_code, joined_at, rejoin_cooldown_until)`
- `gather_cooldowns(guild_id, user_id, command, next_available_at)`
- `invasions(id PK, guild_id, attacker_code, defender_code, attack_*, defense_* NULL, attack_field_*, defense_field_*, status ENUM[attack_vote, defense_window, war, reinforcing, resolved_attacker_win, resolved_defender_win, cancelled], attack_vote_deadline, defense_deadline, next_tick_at, reinforcing_side NULL, reinforce_deadline, rounds, attack_message_id, created_at, resolved_at)` — the `attack_*`/`defense_*` columns are everything a side has committed over the whole war and only grow with reinforcements; the `*_field_*` columns are what is still standing, and are what the rounds eat away.
- `stake_proposals(id PK, invasion_id, side ENUM[attacker, defender], kind ENUM[defense, reinforcement], proposer_id, troops, gold, food, status ENUM[pending, approved, rejected, expired], vote_deadline, message_id, created_at, resolved_at)` — at most one pending proposal per invasion.
- `votes(id PK, invasion_id, kind ENUM[attack, defense], user_id, choice ENUM[approve, reject], created_at)` — one row per voter per vote; changing a vote updates the row. `kind` is the side, so an attacker's reinforcement vote is an `attack` vote; opening a new proposal clears that side's previous round of votes.

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
- **Testing:** unit-test the attrition math (including that every war terminates), vote-threshold logic, and conquest transfer (players, territories, loot) with an in-memory DB. Provide a dev mode with drastically shortened timers for manual playtesting.

## Suggested build order

1. Flake scaffold (flake-parts devShell), project scaffold, DB layer, guild config, `/setup`.
2. Countries + `/join`/`/leave` + role & channel lifecycle (create, archive-on-defeat, delete-on-deactivate/reset) + `/country`; text-only `/map` placeholder.
3. Resources: gather commands, cooldowns, `/resources`.
4. Invasion pipeline: attack vote → escrow → defense window → resolution → conquest transfer.
5. Cooldowns, protections, win condition, reset flow.
6. Map rendering: SVG recolor pipeline, rasterizer abstraction, caching, auto-post after conquests.
7. Polish: Components V2 message design, flags, game log formatting, `/help` system, dev mode, tests.
