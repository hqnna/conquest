# Conquest

A Discord bot running a persistent, server-wide strategy game. Players join
real-world countries, pool resources in private country channels, vote to stake
troops and supplies on invasions, and absorb the countries they conquer. When
one country dominates, the round ends and the game resets.

`spec.md` is the authoritative design document.

## Status

Phase 1 of the build order is implemented: the Nix toolchain, the project
scaffold, the SQLite layer with the full game schema, per-guild configuration,
and `/setup`. Countries, resources, invasions, and the map follow.

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

### Setting up a server

An admin with Manage Server runs `/setup category:<category>`. Conquest stores
the category, creates a public `#war-room` game log, and posts there. Country
channels are created inside the category as countries activate.

The game log is created **outside** the chosen category on purpose: Discord
caps a category at 50 channels, archived channels of defeated countries keep
their slot, and Conquest never frees one. Reserving all 50 slots for countries
means late-game joins increasingly funnel players into countries that already
exist, rather than founding new ones — intended, but worth knowing.

Re-running `/setup` re-points the category and reuses the existing game log if
it still exists. It does not reset the domination threshold or wipe the game.

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
- **Components V2 everywhere.** Every Conquest message is built from containers,
  never legacy embeds.

## License

MIT — see `LICENSE.txt`.
