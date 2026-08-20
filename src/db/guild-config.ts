import type {Database} from 'better-sqlite3';

/** Per-guild setup, written by `/setup` and `/game config`. */
export interface GuildConfig {
  guildId: string;
  /** Category holding every country channel. */
  categoryId: string;
  /** Public channel Conquest posts global events to. */
  logChannelId: string;
  /** When `/setup` first ran for this guild. */
  createdAt: number;
  /** When the current round began: setup, or the last reset. */
  roundStartedAt: number;
}

interface GuildConfigRow {
  guild_id: string;
  category_id: string;
  log_channel_id: string;
  created_at: number;
  round_started_at: number | null;
}

function toGuildConfig(row: GuildConfigRow): GuildConfig {
  return {
    guildId: row.guild_id,
    categoryId: row.category_id,
    logChannelId: row.log_channel_id,
    createdAt: row.created_at,
    roundStartedAt: row.round_started_at ?? row.created_at,
  };
}

/** Returns the guild's configuration, or `undefined` if `/setup` never ran. */
export function getGuildConfig(
  db: Database,
  guildId: string,
): GuildConfig | undefined {
  const row = db
    .prepare('SELECT * FROM guild_config WHERE guild_id = ?')
    .get(guildId) as GuildConfigRow | undefined;
  return row && toGuildConfig(row);
}

/**
 * Writes the guild's category and log channel, creating the configuration on
 * first `/setup` and updating it on later runs. The round's start and the
 * creation time are preserved across re-runs, so re-pointing the category
 * does not silently restart a guild's game.
 */
export function upsertGuildConfig(
  db: Database,
  input: {
    guildId: string;
    categoryId: string;
    logChannelId: string;
    now?: number;
  },
): GuildConfig {
  const now = input.now ?? Date.now();
  db.prepare(
    `INSERT INTO guild_config
       (guild_id, category_id, log_channel_id, created_at, round_started_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (guild_id) DO UPDATE SET
       category_id = excluded.category_id,
       log_channel_id = excluded.log_channel_id`,
  ).run(input.guildId, input.categoryId, input.logChannelId, now, now);
  // The row is guaranteed to exist immediately after the upsert.
  return getGuildConfig(db, input.guildId)!;
}

/** Every guild that has run `/setup`, for the sweeper's global passes. */
export function getGuildIds(db: Database): string[] {
  return (
    db.prepare('SELECT guild_id FROM guild_config').all() as Array<{
      guild_id: string;
    }>
  ).map(row => row.guild_id);
}

/** Starts a fresh round, keeping the guild's setup and its tuning. */
export function startRound(db: Database, guildId: string, now: number): void {
  db.prepare(
    'UPDATE guild_config SET round_started_at = ? WHERE guild_id = ?',
  ).run(now, guildId);
}

/** Removes a guild's configuration, e.g. when Conquest is kicked. */
export function deleteGuildConfig(db: Database, guildId: string): void {
  db.prepare('DELETE FROM guild_config WHERE guild_id = ?').run(guildId);
}
