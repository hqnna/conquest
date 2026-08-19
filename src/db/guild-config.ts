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
  /** When the current round began: setup, or the last reset. */
  roundStartedAt: number;
  /** The only country left standing, if there is exactly one. */
  soleActiveCode: string | null;
  /** Since when it has been alone. Being alone long enough wins the round. */
  soleActiveSince: number | null;
}

interface GuildConfigRow {
  guild_id: string;
  category_id: string;
  log_channel_id: string;
  domination_threshold: number;
  created_at: number;
  round_started_at: number | null;
  sole_active_code: string | null;
  sole_active_since: number | null;
}

function toGuildConfig(row: GuildConfigRow): GuildConfig {
  return {
    guildId: row.guild_id,
    categoryId: row.category_id,
    logChannelId: row.log_channel_id,
    dominationThreshold: row.domination_threshold,
    createdAt: row.created_at,
    roundStartedAt: row.round_started_at ?? row.created_at,
    soleActiveCode: row.sole_active_code,
    soleActiveSince: row.sole_active_since,
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
       (guild_id, category_id, log_channel_id, domination_threshold, created_at,
        round_started_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (guild_id) DO UPDATE SET
       category_id = excluded.category_id,
       log_channel_id = excluded.log_channel_id`,
  ).run(
    input.guildId,
    input.categoryId,
    input.logChannelId,
    GAME.defaultDominationThreshold,
    now,
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

/** Every guild that has run `/setup`, for the sweeper's global passes. */
export function getGuildIds(db: Database): string[] {
  return (
    db.prepare('SELECT guild_id FROM guild_config').all() as Array<{
      guild_id: string;
    }>
  ).map(row => row.guild_id);
}

/**
 * Records which country is the only one left, and since when.
 *
 * Passing null clears it, which is what happens the moment anybody else joins
 * the world: the clock starts again from scratch rather than resuming.
 */
export function setSoleActive(
  db: Database,
  guildId: string,
  code: string | null,
  since: number | null,
): void {
  db.prepare(
    'UPDATE guild_config SET sole_active_code = ?, sole_active_since = ? WHERE guild_id = ?',
  ).run(code, code === null ? null : since, guildId);
}

/** Starts a fresh round, keeping the guild's setup and its tuning. */
export function startRound(db: Database, guildId: string, now: number): void {
  db.prepare(
    `UPDATE guild_config
        SET round_started_at = ?, sole_active_code = NULL, sole_active_since = NULL
      WHERE guild_id = ?`,
  ).run(now, guildId);
}

/** Removes a guild's configuration, e.g. when Conquest is kicked. */
export function deleteGuildConfig(db: Database, guildId: string): void {
  db.prepare('DELETE FROM guild_config WHERE guild_id = ?').run(guildId);
}
