import type {Database} from 'better-sqlite3';
import {settingsFor} from './guild-settings.js';

/** A player's membership in this guild's game. */
export interface PlayerState {
  guildId: string;
  userId: string;
  /** Country they belong to, or null while between countries. */
  countryCode: string | null;
  joinedAt: number | null;
  /** Cannot join a country again until this timestamp. */
  rejoinCooldownUntil: number | null;
}

interface PlayerRow {
  guild_id: string;
  user_id: string;
  country_code: string | null;
  joined_at: number | null;
  rejoin_cooldown_until: number | null;
}

function toPlayerState(row: PlayerRow): PlayerState {
  return {
    guildId: row.guild_id,
    userId: row.user_id,
    countryCode: row.country_code,
    joinedAt: row.joined_at,
    rejoinCooldownUntil: row.rejoin_cooldown_until,
  };
}

/** Reads a player's membership, or `undefined` if they never joined. */
export function getPlayer(
  db: Database,
  guildId: string,
  userId: string,
): PlayerState | undefined {
  const row = db
    .prepare('SELECT * FROM players WHERE guild_id = ? AND user_id = ?')
    .get(guildId, userId) as PlayerRow | undefined;
  return row && toPlayerState(row);
}

/** User IDs of everyone currently in a country, in join order. */
export function listCountryMembers(
  db: Database,
  guildId: string,
  code: string,
): string[] {
  return (
    db
      .prepare(
        `SELECT user_id FROM players
          WHERE guild_id = ? AND country_code = ?
          ORDER BY joined_at, user_id`,
      )
      .all(guildId, code) as Array<{user_id: string}>
  ).map(row => row.user_id);
}

/**
 * How many players a country has. Vote thresholds are a majority of this, so
 * it is read at resolution time rather than cached.
 */
export function countCountryMembers(
  db: Database,
  guildId: string,
  code: string,
): number {
  const row = db
    .prepare(
      'SELECT count(*) AS members FROM players WHERE guild_id = ? AND country_code = ?',
    )
    .get(guildId, code) as {members: number};
  return row.members;
}

/** Players per country, for listings and the map legend. */
export function memberCounts(
  db: Database,
  guildId: string,
): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT country_code AS code, count(*) AS members
         FROM players
        WHERE guild_id = ? AND country_code IS NOT NULL
        GROUP BY country_code`,
    )
    .all(guildId) as Array<{code: string; members: number}>;
  return new Map(rows.map(row => [row.code, row.members]));
}

/** Puts a player in a country, clearing any spent rejoin cooldown. */
export function joinCountry(
  db: Database,
  input: {guildId: string; userId: string; code: string; now: number},
): PlayerState {
  db.prepare(
    `INSERT INTO players (guild_id, user_id, country_code, joined_at, rejoin_cooldown_until)
     VALUES (?, ?, ?, ?, NULL)
     ON CONFLICT (guild_id, user_id) DO UPDATE SET
       country_code = excluded.country_code,
       joined_at = excluded.joined_at,
       rejoin_cooldown_until = NULL`,
  ).run(input.guildId, input.userId, input.code, input.now);
  return getPlayer(db, input.guildId, input.userId)!;
}

/**
 * Takes a player out of their country.
 *
 * @param withCooldown false when the player left the server rather than the
 *   country — there is nothing to discourage, and no one to hold to it.
 */
export function leaveCountry(
  db: Database,
  input: {
    guildId: string;
    userId: string;
    now: number;
    withCooldown: boolean;
  },
): void {
  const until = input.withCooldown
    ? input.now + settingsFor(db, input.guildId).cooldowns.rejoin
    : null;
  db.prepare(
    `UPDATE players
        SET country_code = NULL, joined_at = NULL, rejoin_cooldown_until = ?
      WHERE guild_id = ? AND user_id = ?`,
  ).run(until, input.guildId, input.userId);
}

/**
 * Moves every player of one country into another, as happens when a country
 * is conquered and absorbed.
 *
 * @returns the user IDs that moved, in the order their roles should be
 *   updated.
 */
export function transferPlayers(
  db: Database,
  input: {guildId: string; fromCode: string; toCode: string; now: number},
): string[] {
  return db.transaction(() => {
    const moving = listCountryMembers(db, input.guildId, input.fromCode);
    db.prepare(
      `UPDATE players
          SET country_code = ?, joined_at = ?
        WHERE guild_id = ? AND country_code = ?`,
    ).run(input.toCode, input.now, input.guildId, input.fromCode);
    return moving;
  })();
}
