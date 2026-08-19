import type {Database} from 'better-sqlite3';
import {GAME} from '../config/constants.js';

/** Per-guild setup, written by `/setup` and `/game config`. */
export interface GuildConfig {
  guildId: string;
  /** Category holding every country channel. */
  categoryId: string;
  /** Public channel Conquest posts global events to. */
  logChannelId: string;
  /** Territories a country needs to win the round. */
  dominationThreshold: number;
  /** When `/setup` first ran for this guild. */
  createdAt: number;
}

interface GuildConfigRow {
  guild_id: string;
  category_id: string;
  log_channel_id: string;
  domination_threshold: number;
  created_at: number;
}

function toGuildConfig(row: GuildConfigRow): GuildConfig {
  return {
    guildId: row.guild_id,
    categoryId: row.category_id,
    logChannelId: row.log_channel_id,
    dominationThreshold: row.domination_threshold,
    createdAt: row.created_at,
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
 * first `/setup` and updating it on later runs. The domination threshold and
 * creation time are preserved across re-runs so re-pointing the category does
 * not silently reset a guild's tuning.
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
       (guild_id, category_id, log_channel_id, domination_threshold, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (guild_id) DO UPDATE SET
       category_id = excluded.category_id,
       log_channel_id = excluded.log_channel_id`,
  ).run(
    input.guildId,
    input.categoryId,
    input.logChannelId,
    GAME.defaultDominationThreshold,
    now,
  );
  // The row is guaranteed to exist immediately after the upsert.
  return getGuildConfig(db, input.guildId)!;
}

/** Sets the number of territories needed to win in this guild. */
export function setDominationThreshold(
  db: Database,
  guildId: string,
  threshold: number,
): void {
  const result = db
    .prepare(
      'UPDATE guild_config SET domination_threshold = ? WHERE guild_id = ?',
    )
    .run(threshold, guildId);
  if (result.changes === 0) {
    throw new Error(`No Conquest configuration for guild ${guildId}`);
  }
}

/** Removes a guild's configuration, e.g. when Conquest is kicked. */
export function deleteGuildConfig(db: Database, guildId: string): void {
  db.prepare('DELETE FROM guild_config WHERE guild_id = ?').run(guildId);
}
