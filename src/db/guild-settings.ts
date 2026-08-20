import type {Database} from 'better-sqlite3';
import {
  TUNABLES_BY_KEY,
  applyOverrides,
  isInRange,
} from '../config/settings.js';
import type {Settings, Tunable} from '../config/settings.js';

/** One thing a guild has decided for itself. */
export interface Override {
  key: string;
  /** In the unit an admin typed, not the unit the game uses. */
  value: number;
  setAt: number;
}

/** Everything a guild has retuned. */
export function listOverrides(db: Database, guildId: string): Override[] {
  return (
    db
      .prepare(
        'SELECT key, value, set_at FROM guild_settings WHERE guild_id = ? ORDER BY key',
      )
      .all(guildId) as Array<{key: string; value: number; set_at: number}>
  ).map(row => ({key: row.key, value: row.value, setAt: row.set_at}));
}

/**
 * Retunes one setting for one guild.
 *
 * @throws if the value is outside what the tunable accepts, which is checked
 *   here as well as at the command, because a bad number stored is a bad
 *   number every time it is read.
 */
export function setOverride(
  db: Database,
  guildId: string,
  key: string,
  value: number,
  now: number,
): void {
  const tunable = TUNABLES_BY_KEY.get(key);
  if (!tunable) throw new Error(`Unknown setting ${key}`);
  if (!isInRange(tunable, value)) {
    throw new Error(
      `${key} must be a whole number between ${tunable.min} and ${tunable.max}`,
    );
  }
  db.prepare(
    `INSERT INTO guild_settings (guild_id, key, value, set_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (guild_id, key) DO UPDATE SET
       value = excluded.value, set_at = excluded.set_at`,
  ).run(guildId, key, value, now);
}

/** Puts one setting back to what Conquest ships with. */
export function clearOverride(
  db: Database,
  guildId: string,
  key: string,
): boolean {
  return (
    db
      .prepare('DELETE FROM guild_settings WHERE guild_id = ? AND key = ?')
      .run(guildId, key).changes > 0
  );
}

/** Puts every setting back to what Conquest ships with. */
export function clearOverrides(db: Database, guildId: string): number {
  return db
    .prepare('DELETE FROM guild_settings WHERE guild_id = ?')
    .run(guildId).changes;
}

/**
 * Resolved settings for a guild: the shipped defaults with its overrides
 * applied.
 *
 * Cached, because this is read on every gather, every war round, and every
 * sweep. The cache is per guild and dropped whenever that guild's overrides
 * change, so a retune takes effect on the next command rather than the next
 * restart.
 */
const cache = new Map<string, Settings>();

/** Reads a guild's settings, resolving and caching them if needed. */
export function settingsFor(db: Database, guildId: string): Settings {
  const cached = cache.get(guildId);
  if (cached) return cached;

  const resolved = applyOverrides(
    new Map(listOverrides(db, guildId).map(row => [row.key, row.value])),
  );
  cache.set(guildId, resolved);
  return resolved;
}

/** Drops a guild's cached settings, or every guild's. */
export function forgetSettings(guildId?: string): void {
  if (guildId === undefined) cache.clear();
  else cache.delete(guildId);
}

/** What a guild has changed, against what it would otherwise be. */
export interface SettingSummary {
  tunable: Tunable;
  value: number;
  isDefault: boolean;
}

/** Every tunable with the guild's current value, for `/game settings`. */
export function summariseSettings(
  db: Database,
  guildId: string,
): SettingSummary[] {
  const settings = settingsFor(db, guildId);
  const overridden = new Set(
    listOverrides(db, guildId).map(override => override.key),
  );
  return [...TUNABLES_BY_KEY.values()].map(tunable => ({
    tunable,
    value: tunable.read(settings),
    isDefault: !overridden.has(tunable.key),
  }));
}
