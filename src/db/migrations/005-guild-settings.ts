import type {Migration} from '../migrations.js';

/**
 * Per-guild tuning, in one place.
 *
 * The domination threshold had a column of its own, from when it was the only
 * thing a guild could change. It moves into the general table so there is one
 * mechanism rather than two, and every guild's stored value is carried across
 * — a guild that had retuned it keeps what it chose.
 *
 * Values are stored in the units an admin types, not the units the game uses,
 * so what comes back out of the database is what somebody actually asked for.
 */
export const migration: Migration = {
  version: 5,
  name: 'guild-settings',
  sql: `
    CREATE TABLE guild_settings (
      guild_id TEXT    NOT NULL,
      key      TEXT    NOT NULL,
      value    INTEGER NOT NULL,
      set_at   INTEGER NOT NULL,
      PRIMARY KEY (guild_id, key)
    );

    INSERT INTO guild_settings (guild_id, key, value, set_at)
    SELECT guild_id, 'domination_threshold', domination_threshold, created_at
      FROM guild_config
     WHERE domination_threshold IS NOT NULL;

    ALTER TABLE guild_config DROP COLUMN domination_threshold;
  `,
};
