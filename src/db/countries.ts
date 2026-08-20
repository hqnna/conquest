import type {Database} from 'better-sqlite3';
import {settingsFor} from './guild-settings.js';

/** Lifecycle of a country within one guild's game. */
export type CountryStatus = 'inactive' | 'active' | 'defeated';

/** A country's row in the game database. */
export interface CountryState {
  guildId: string;
  code: string;
  name: string;
  status: CountryStatus;
  /** Conqueror's code while defeated, otherwise null. */
  ownerCode: string | null;
  /** Private channel while active; the read-only archive while defeated. */
  channelId: string | null;
  /** Country role; null once defeated, as the role is deleted after transfer. */
  roleId: string | null;
  food: number;
  gold: number;
  troops: number;
  activatedAt: number | null;
  /** New-country protection: cannot be invaded until this timestamp. */
  protectedUntil: number | null;
  /** Cannot declare an invasion until this timestamp. */
  invadeCooldownUntil: number | null;
  /** Cannot be invaded until this timestamp, after a successful defence. */
  defenseImmunityUntil: number | null;
}

interface CountryRow {
  guild_id: string;
  code: string;
  name: string;
  status: CountryStatus;
  owner_code: string | null;
  channel_id: string | null;
  role_id: string | null;
  food: number;
  gold: number;
  troops: number;
  activated_at: number | null;
  protected_until: number | null;
  invade_cooldown_until: number | null;
  defense_immunity_until: number | null;
}

function toCountryState(row: CountryRow): CountryState {
  return {
    guildId: row.guild_id,
    code: row.code,
    name: row.name,
    status: row.status,
    ownerCode: row.owner_code,
    channelId: row.channel_id,
    roleId: row.role_id,
    food: row.food,
    gold: row.gold,
    troops: row.troops,
    activatedAt: row.activated_at,
    protectedUntil: row.protected_until,
    invadeCooldownUntil: row.invade_cooldown_until,
    defenseImmunityUntil: row.defense_immunity_until,
  };
}

/**
 * Reads one country's state.
 *
 * Countries with no row have never been activated in this guild; they are
 * inactive and joinable, which is why callers treat `undefined` as inactive
 * rather than as an error.
 */
export function getCountry(
  db: Database,
  guildId: string,
  code: string,
): CountryState | undefined {
  const row = db
    .prepare('SELECT * FROM countries WHERE guild_id = ? AND code = ?')
    .get(guildId, code) as CountryRow | undefined;
  return row && toCountryState(row);
}

/** Every country this guild's game has touched, in code order. */
export function listCountries(db: Database, guildId: string): CountryState[] {
  return (
    db
      .prepare('SELECT * FROM countries WHERE guild_id = ? ORDER BY code')
      .all(guildId) as CountryRow[]
  ).map(toCountryState);
}

/** Countries with the given status, in code order. */
export function listCountriesByStatus(
  db: Database,
  guildId: string,
  status: CountryStatus,
): CountryState[] {
  return (
    db
      .prepare(
        'SELECT * FROM countries WHERE guild_id = ? AND status = ? ORDER BY code',
      )
      .all(guildId, status) as CountryRow[]
  ).map(toCountryState);
}

/** Countries conquered by, and now owned by, the given country. */
export function listTerritories(
  db: Database,
  guildId: string,
  ownerCode: string,
): CountryState[] {
  return (
    db
      .prepare(
        'SELECT * FROM countries WHERE guild_id = ? AND owner_code = ? ORDER BY code',
      )
      .all(guildId, ownerCode) as CountryRow[]
  ).map(toCountryState);
}

/** How many countries this one has taken by force. */
export function conquestCount(
  db: Database,
  guildId: string,
  code: string,
): number {
  return (
    db
      .prepare(
        'SELECT count(*) AS held FROM countries WHERE guild_id = ? AND owner_code = ?',
      )
      .get(guildId, code) as {held: number}
  ).held;
}

/** How many territories each country holds, highest first. */
export function territoryCounts(
  db: Database,
  guildId: string,
): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT owner_code AS code, count(*) AS held
         FROM countries
        WHERE guild_id = ? AND owner_code IS NOT NULL
        GROUP BY owner_code`,
    )
    .all(guildId) as Array<{code: string; held: number}>;
  return new Map(rows.map(row => [row.code, row.held]));
}

/**
 * Marks a country active with its freshly created channel and role, starting
 * its new-country protection.
 *
 * Works whether or not the country has a row already: a country that was
 * activated and later deactivated is activated again from a clean slate.
 */
export function activateCountry(
  db: Database,
  input: {
    guildId: string;
    code: string;
    name: string;
    channelId: string;
    roleId: string;
    now: number;
  },
): CountryState {
  const protectedUntil =
    input.now + settingsFor(db, input.guildId).invasions.newCountryProtection;
  db.prepare(
    `INSERT INTO countries
       (guild_id, code, name, status, owner_code, channel_id, role_id,
        food, gold, troops, activated_at, protected_until,
        invade_cooldown_until, defense_immunity_until)
     VALUES (?, ?, ?, 'active', NULL, ?, ?, 0, 0, 0, ?, ?, NULL, NULL)
     ON CONFLICT (guild_id, code) DO UPDATE SET
       name = excluded.name,
       status = 'active',
       owner_code = NULL,
       channel_id = excluded.channel_id,
       role_id = excluded.role_id,
       food = 0, gold = 0, troops = 0,
       activated_at = excluded.activated_at,
       protected_until = excluded.protected_until,
       invade_cooldown_until = NULL,
       defense_immunity_until = NULL`,
  ).run(
    input.guildId,
    input.code,
    input.name,
    input.channelId,
    input.roleId,
    input.now,
    protectedUntil,
  );
  return getCountry(db, input.guildId, input.code)!;
}

/**
 * Wipes a country back to inactive when its last player leaves: stockpile
 * gone, channel and role forgotten, and every territory it held released.
 *
 * One transaction — a half-released empire would leave territories owned by a
 * country that no longer exists.
 *
 * @returns the territories that became unclaimed, so their archived channels
 *   can be deleted.
 */
export function deactivateCountry(
  db: Database,
  guildId: string,
  code: string,
): CountryState[] {
  return db.transaction(() => {
    const released = listTerritories(db, guildId, code);
    db.prepare(
      `UPDATE countries
          SET status = 'inactive', owner_code = NULL, channel_id = NULL,
              role_id = NULL, food = 0, gold = 0, troops = 0,
              activated_at = NULL, protected_until = NULL,
              invade_cooldown_until = NULL, defense_immunity_until = NULL
        WHERE guild_id = ? AND owner_code = ?`,
    ).run(guildId, code);
    db.prepare(
      `UPDATE countries
          SET status = 'inactive', owner_code = NULL, channel_id = NULL,
              role_id = NULL, food = 0, gold = 0, troops = 0,
              activated_at = NULL, protected_until = NULL,
              invade_cooldown_until = NULL, defense_immunity_until = NULL
        WHERE guild_id = ? AND code = ?`,
    ).run(guildId, code);
    return released;
  })();
}

/** Records the channel a defeated country's archive now lives in. */
export function setCountryChannel(
  db: Database,
  guildId: string,
  code: string,
  channelId: string | null,
): void {
  db.prepare(
    'UPDATE countries SET channel_id = ? WHERE guild_id = ? AND code = ?',
  ).run(channelId, guildId, code);
}

/** Forgets a country's role, e.g. after a defeated country's role is deleted. */
export function clearCountryRole(
  db: Database,
  guildId: string,
  code: string,
): void {
  db.prepare(
    'UPDATE countries SET role_id = NULL WHERE guild_id = ? AND code = ?',
  ).run(guildId, code);
}
