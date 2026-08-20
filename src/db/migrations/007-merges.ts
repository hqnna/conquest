import type {Migration} from '../migrations.js';

/**
 * Merges: a country may also be given away rather than taken.
 *
 * A merge needs both countries to agree, so it runs as two votes in turn —
 * the country offering itself, then the country asked to absorb it — and each
 * has its own deadline and its own vote message to close when it settles.
 * Both deadlines are absolute timestamps, like every other one in Conquest, so
 * the sweeper settles them after a restart.
 *
 * Merge votes live in their own table rather than in `votes`, whose rows are
 * keyed to an invasion and cascade with it. Nothing about a merge belongs to
 * an invasion.
 */
export const migration: Migration = {
  version: 7,
  name: 'merges',
  sql: `
    CREATE TABLE merges (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id          TEXT    NOT NULL,
      from_code         TEXT    NOT NULL,
      into_code         TEXT    NOT NULL,
      proposer_id       TEXT    NOT NULL,
      status            TEXT    NOT NULL
                                CHECK (status IN (
                                  'offer_vote',
                                  'accept_vote',
                                  'completed',
                                  'declined',
                                  'expired',
                                  'cancelled'
                                )),
      offer_deadline    INTEGER NOT NULL,
      accept_deadline   INTEGER,
      offer_message_id  TEXT,
      accept_message_id TEXT,
      created_at        INTEGER NOT NULL,
      resolved_at       INTEGER
    );

    CREATE INDEX merges_by_status ON merges (guild_id, status);
    CREATE INDEX merges_by_from ON merges (guild_id, from_code);
    CREATE INDEX merges_by_into ON merges (guild_id, into_code);

    CREATE TABLE merge_votes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      merge_id   INTEGER NOT NULL REFERENCES merges (id) ON DELETE CASCADE,
      kind       TEXT    NOT NULL CHECK (kind IN ('offer', 'accept')),
      user_id    TEXT    NOT NULL,
      choice     TEXT    NOT NULL CHECK (choice IN ('approve', 'reject')),
      created_at INTEGER NOT NULL,
      UNIQUE (merge_id, kind, user_id)
    );
  `,
};
