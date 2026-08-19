# Conquest

A Discord bot running a persistent, server-wide strategy game. Players join
real-world countries, pool resources in private country channels, vote to stake
troops and supplies on invasions, and absorb the countries they conquer. When
one country dominates, the round ends and the game resets.

`spec.md` is the authoritative design document.

## Status

Phases 1 and 2 of the build order are implemented: the Nix toolchain, the
project scaffold, the SQLite layer with the full game schema, per-guild
configuration and `/setup`, and now countries — `/join`, `/leave`,
`/country`, a text-only `/map`, and the country role and channel lifecycle.
Resources, invasions, and map rendering follow.

| Command | Who | Effect |
|---|---|---|
| `/setup category:<cat>` | Admin | Configure the category and game log |
| `/join country:<name>` | Anyone | Join a country, founding it if nobody has |
| `/leave` | Player | Leave your country (24h rejoin cooldown) |
| `/country [name]` | Anyone | Players, territories, and status of a country |
| `/map` | Anyone | Who holds what (text standings until rendering lands) |

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

Conquest needs **Manage Channels** and **Manage Roles**; `/setup` refuses to
run without them and names what is missing.

It also needs the **Server Members Intent**, which is privileged: enable it
under Bot → Privileged Gateway Intents in the developer portal. Conquest uses
it to notice a player leaving the server — which releases their country, and
disbands it if they were its last player — and to look members up when their
country role changes. The Message Content intent is never used.

### Setting up a server

An admin with Manage Server runs `/setup category:<category>`. Conquest creates
a `#war-room` game log pinned to the top of that category, with the country
channels appearing underneath it as countries activate. The war room is
read-only: everyone can read it and react, only Conquest can post.

Discord caps a category at 50 channels. The war room takes one, archived
channels of defeated countries keep theirs, and Conquest never frees a slot, so
capacity only shrinks over a round. Late-game joins therefore funnel players
into countries that already exist rather than founding new ones — intended, but
worth knowing.

Re-running `/setup` re-points the category and reuses the existing game log,
moving it back to the top of the category and restoring its read-only
permissions. It does not reset the domination threshold or wipe the game.

### Country data

`src/data/countries.json` is the shipped list of ISO 3166-1 countries: code,
name, flag emoji, and continent. It is generated and committed, so a running
game cannot have the world shift under it:

```sh
nix develop -c pnpm generate-countries
```

The alpha-2 code is the join between that file, every `country_code` in the
database, and the map SVG that arrives with map rendering — those must stay
identical.

## Architecture

- **All state is per-guild.** Multiple servers run isolated games in one process.
- **No in-memory timers.** Every deadline, cooldown, and protection is an
  absolute timestamp in SQLite, so a restart mid-invasion loses nothing.
- **Stateless components.** Button `customId`s carry everything needed and are
  revalidated against the database on click.
- **Role-based permissions.** A country is a role plus a private channel; there
  are no per-user channel overwrites.
- **One tunables module.** `src/config/constants.ts` holds every yield, cost,
  cooldown, window, and threshold, and `/help` renders its numbers from it.
- **Autocomplete is UX, not validation.** It answers from the database and
  cache alone, and every command decides again server-side.
- **Components V2 everywhere.** Every Conquest message is built from containers,
  never legacy embeds.

## License

MIT — see `LICENSE.txt`.
