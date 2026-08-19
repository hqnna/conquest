import type {Migration} from '../migrations.js';

/**
 * What a guild needs to know about the round it is currently playing.
 *
 * `round_started_at` is when the current round began, which is when `/setup`
 * ran or when the last reset finished — not when the guild was first
 * configured, so a victory announcement can say how long the round took.
 *
 * `sole_active_code` and `sole_active_since` track the other way to win: a
 * country that is the only one left standing wins once it has been alone for
 * long enough. The clock has to survive restarts and reset the moment anybody
 * else joins the world, so it is a stored timestamp rather than a timer.
 */
export const migration: Migration = {
  version: 4,
  name: 'round-tracking',
  sql: `
    ALTER TABLE guild_config ADD COLUMN round_started_at INTEGER;
    ALTER TABLE guild_config ADD COLUMN sole_active_code TEXT;
    ALTER TABLE guild_config ADD COLUMN sole_active_since INTEGER;

    UPDATE guild_config SET round_started_at = created_at
     WHERE round_started_at IS NULL;
  `,
};
