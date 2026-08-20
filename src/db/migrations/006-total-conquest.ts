import type {Migration} from '../migrations.js';

/**
 * Total conquest is the only way to win.
 *
 * The domination threshold and the last-country-standing clock are both gone:
 * a country wins when every other country that raised a flag is its territory,
 * and nothing else. That leaves the clock's two columns and any guild's stored
 * tuning of either number meaningless, so both are dropped rather than left to
 * confuse the next reader.
 */
export const migration: Migration = {
  version: 6,
  name: 'total-conquest',
  sql: `
    DELETE FROM guild_settings
     WHERE key IN ('domination_threshold', 'last_standing_duration');

    ALTER TABLE guild_config DROP COLUMN sole_active_code;
    ALTER TABLE guild_config DROP COLUMN sole_active_since;
  `,
};
