# Conquest

A Discord bot running a persistent, server-wide strategy game. Players join
real-world countries, pool resources in private country channels, vote to stake
troops and supplies on invasions, and absorb the countries they conquer. When
one country dominates, the round ends and the game resets.

`spec.md` is the authoritative design document.

## Status

The whole build order is implemented: the Nix toolchain and project scaffold,
the SQLite layer with the full game schema, per-guild configuration and
`/setup`, countries with their role and channel lifecycle, resource gathering,
the invasion pipeline as a war of attrition, the win condition with its reset
flow, map rendering, and the `/help` system.

| Command | Who | Effect |
|---|---|---|
| `/setup category:<cat>` | Admin | Configure the category and game log |
| `/join country:<name>` | Anyone | Join a country, founding it if nobody has |
| `/leave` | Player | Leave your country (24h rejoin cooldown) |
| `/country [name]` | Anyone | Players, territories, and status of a country |
| `/farm`, `/mine`, `/recruit` | Player | Gather for your country, on per-player cooldowns |
| `/resources` | Player | Your country stockpile and your own cooldowns |
| `/invade country:<t> troops:<n> [gold] [food]` | Player | Put an invasion to your country |
| `/defend troops:<n> [gold] [food]` | Player | Put a defence to your country while under attack |
| `/reinforce troops:<n> [gold] [food]` | Player | Send fresh forces to a war your country is losing |
| `/surrender` | Player | Give up a war your country cannot continue |
| `/game reset` | Admin | Wipe the world and start a fresh round (confirmed) |
| `/game settings` | Admin | Show every setting, and what this server changed |
| `/game tune setting:<s> [value]` | Admin | Retune one setting, or restore its default |
| `/game reset-settings` | Admin | Put every setting back to the shipped default |
| `/map [region]` | Anyone | The rendered world map, with the standings as its legend |
| `/help [topic]` | Anyone | Paginated help, with its numbers read from the tunables |

## Development

All tooling comes from the Nix flake's devShell — nothing is assumed to be
installed globally.

```sh
nix develop                # enter the shell
nix develop -c pnpm install
nix develop -c pnpm build  # type-check and compile to build/
nix develop -c pnpm lint   # Google TypeScript Style, via gts
nix develop -c pnpm format # apply the formatter and autofixes
nix develop -c pnpm test   # unit tests, against an in-memory database
```

direnv users can `direnv allow` and drop the `nix develop -c` prefix.

### Running Conquest

Set the bot's credentials, register its commands, then start it:

```sh
export DISCORD_TOKEN=...        # bot token
export DISCORD_CLIENT_ID=...    # application ID
export DISCORD_GUILD_ID=...     # optional: register to one guild, updates instantly
nix develop -c pnpm deploy-commands
nix develop -c pnpm dev
```

| Variable | Default | Meaning |
|---|---|---|
| `DISCORD_TOKEN` | — | Bot token (required) |
| `DISCORD_CLIENT_ID` | — | Application ID (required) |
| `DISCORD_GUILD_ID` | — | Register commands to one guild instead of globally |
| `CONQUEST_DB_PATH` | `conquest.db` | SQLite file holding all game state |
| `CONQUEST_DEV_MODE` | unset | `1` shortens every game timer for playtesting |

Dev mode divides every duration by 120, which turns a multi-day round into a
playable few minutes: gathering every 15 seconds, a 12-minute defence window,
war rounds every 30 seconds. `/help` reports the shortened numbers honestly,
because it reads them from the same module the game does.

Conquest needs **Manage Channels** and **Manage Roles**; `/setup` refuses to
run without them and names what is missing.

It also needs the **Server Members Intent**, which is privileged: enable it
under Bot → Privileged Gateway Intents in the developer portal. Conquest uses
it to notice a player leaving the server — which releases their country, and
disbands it if they were its last player — and to look members up when their
country role changes. The Message Content intent is never used.

### Setting up a server

An admin with Manage Server runs `/setup category:<category>`. Conquest creates
a `#war-room` pinned to the top of that category, with the country channels
appearing underneath it as countries activate. Conquest posts every global
event there — declarations, battles, conquests, the end of a round — and
everyone can talk in it. Country channels are private to their own members, so
the war room is the only place countries can reach each other: it is where
threats, bargains, and merge offers are made. Public threads are allowed;
private ones are not.

Discord caps a category at 50 channels. The war room takes one, archived
channels of defeated countries keep theirs, and Conquest never frees a slot, so
capacity only shrinks over a round. Late-game joins therefore funnel players
into countries that already exist rather than founding new ones — intended, but
worth knowing.

Re-running `/setup` re-points the category and reuses the existing war room,
moving it back to the top of the category and restoring its permissions. It
does not reset the guild's tuning or wipe the game.

### Country data

`src/data/countries.json` is the shipped list of ISO 3166-1 countries: code,
name, flag emoji, and continent. It is generated and committed, so a running
game cannot have the world shift under it:

```sh
nix develop -c pnpm generate-countries
```

The alpha-2 code is the join between that file, every `country_code` in the
database, and the map SVG — those must stay identical.

### The map

`src/data/world.svg` is generated from Natural Earth data (public domain) with
every country path carrying its ISO alpha-2 code as its `id`, alongside
`world-map.json` holding the canvas size and a viewBox per continent. Both are
committed, so the running bot needs neither the map packages nor a network:

```sh
nix develop -c pnpm generate-map
```

Rendering never rewrites geometry. Conquest injects a single stylesheet and CSS
outranks the presentation attributes already on the paths, so colouring a
country is one rule keyed by its code. Rendered PNGs are cached against a hash
of exactly the state a picture depends on — statuses, owners, wars, crop, width
— so an unchanged world is never drawn twice.

The rasterizer sits behind a small interface with two implementations:
`@resvg/resvg-js` in process, and the nixpkgs `resvg` command as a fallback if
that native binding will not load. Conquest probes them at startup and says
which it picked. If neither works, `/map` falls back to text standings rather
than failing.

### How a war runs

1. `/invade` opens a vote in the attacker's channel. Nothing is spent yet, and
   the caller's own approval is already counted — a one-player country passes
   on it alone.
2. On a majority the stake is escrowed immediately, the war is declared in the
   game log with the stake in full, and the defender's channel is pinged.
   Marching voids the attacker's own new-country protection.
3. The defender has a window to `/defend`. **Ignoring an invasion loses it**:
   if nothing is approved in time the country is absorbed without a fight, and
   the attacker's army comes home untouched.
4. If a defence does take the field, the two forces grind each other down over
   hourly rounds. Losses are weighted by the enemy's power — supplies add up to
   +50%, home ground adds a fifth — so the outmatched side bleeds faster, and
   luck swings each blow by a tenth either way.
5. When a side's troops are gone its country must answer: `/reinforce` and
   carry the vote, or `/surrender`. **Silence is surrender.** A country whose
   stockpile is fully drained has nothing to send and loses on the spot.
6. An attacker that gives up marches its survivors home — it loses the war,
   not its army. A defender that gives up loses everything: its surviving
   force, its stockpile, its players, its territories, and its channel, which
   becomes a read-only archive its conquerors can read.

Every deadline is an absolute timestamp in SQLite, and a sweeper settles
whatever has expired. Restarting mid-war loses nothing but the seconds
Conquest was down.

A country's **territory count** is the land it holds: its own homeland plus
every country it has conquered. A country that has taken nobody still holds
one territory, its own.

### Merging

A country can also be given away. `/merge country:<name>` offers your country
to another one, and it takes two votes: yours decides whether to make the
offer, then theirs decides whether to accept it. Each side needs a strict
majority within its window, the proposer's own approval is already counted,
and if either side votes no — or says nothing — nothing moves.

Both votes are needed on purpose. A one-sided merge would be a hostile
takeover: the players who move in vote with their new country afterwards, so a
large country walking into a small one would decide what the small one does
from the inside.

When it goes through, the merge does exactly what a conquest does, because it
leaves the world in the same shape: the absorbed country's players, stockpile
and territories all become the other country's, its channel becomes a
read-only archive, and its role is deleted. Taking a country in voids the
absorbing country's new-country protection, exactly as marching on somebody
would.

War outranks it. A country in a war can neither offer nor accept, and an
invasion that reaches the field mid-vote calls the merge off in both channels.

### How a round ends

There is one way to win, and it is **total conquest**: be the only country
left active, having taken at least one country — beaten in war, or handed over
by a merge. Both halves matter.
The first country founded is the only active one until somebody else joins,
and a lone survivor whose only rival disbanded on its own never conquered
anything — neither wins a round.

Winning wipes the world: a victory announcement naming the victors, their
conquests and how long the round ran, then every country channel and role is
deleted and all countries, players, cooldowns, and wars go with them. The
category, the game log, and the guild's tuning survive, so nobody has to
run `/setup` again — players simply `/join` a fresh world.

`/game reset` does the same on demand behind a confirmation button.

## Architecture

- **All state is per-guild.** Multiple servers run isolated games in one process.
- **No in-memory timers.** Every deadline, cooldown, and protection is an
  absolute timestamp in SQLite, so a restart mid-invasion loses nothing.
- **Stateless components.** Button `customId`s carry everything needed and are
  revalidated against the database on click.
- **Role-based permissions.** A country is a role plus a private channel; there
  are no per-user channel overwrites.
- **One tunables module.** `src/config/constants.ts` holds every yield, cost,
  cooldown, window, and threshold Conquest ships with, and a guild may override
  any of them. Everything the game reads goes through settings resolved for
  that guild, and `/help` renders its numbers from the same place — so the
  help documents the game each server actually plays.
- **Autocomplete is UX, not validation.** It answers from the database and
  cache alone, and every command decides again server-side.
- **Stateless components.** Vote buttons encode the invasion, side, and choice
  in their `customId` and revalidate against the database on every click, so
  they survive restarts with no collector to lose.
- **Escrow is transactional.** Staking, resolution, looting, and the conquest
  transfer are each one database transaction — a partial conquest would be a
  corrupt game.
- **Components V2 everywhere.** Every Conquest message is built from containers,
  never legacy embeds.

## Per-server settings

Every server plays the shipped game until an admin changes something:

```
/game settings                       # what this server plays, and what it changed
/game tune setting:"Defence window" value:90
/game tune setting:"Defence window"  # no value restores the default
/game reset-settings                 # restore everything
```

Fifteen settings are tunable — gather and recruit cooldowns, recruit cost,
rejoin and invasion cooldowns, the attack, defence, and merge vote windows,
protections, the war round interval and reinforcement window, the per-round
loss rate, home advantage, and the supply cap. Values are given in the
units an admin thinks in — minutes, percent, or a count — and stored that way,
so what comes back out is what somebody asked for.

The tunables are declared once, in `src/config/settings.ts`. That one registry
drives the command's choices, its bounds checking, what `/game settings` prints,
and how a stored value is applied, so a new tunable cannot be half-added. The
bounds are not decoration: a zero-length war round would spin and a defence
window of seconds would make an invasion unanswerable.

Changes apply from the next command. Deadlines already running keep the value
they started with, so a war in progress is never retuned underneath the
countries fighting it.

## License

MIT — see `LICENSE.txt`.
