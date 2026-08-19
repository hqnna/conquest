import type {Migration} from '../migrations.js';

/**
 * Two things the pipeline needs that the original data model left open.
 *
 * `attack_message_id` — the sweeper resolves votes that expire while nobody
 * is clicking, so it has to find the vote message to disable its buttons.
 * A button interaction carries its own message, but an expiry has no
 * interaction to carry anything.
 *
 * `defense_proposals` — the design allows one pending defence proposal at a
 * time, replaceable after a rejection, while `invasions.defense_*` holds the
 * stake that was actually approved. A proposal therefore needs somewhere of
 * its own to live, with who proposed it and its own vote deadline. Votes stay
 * keyed by invasion and kind as designed; opening a new proposal clears the
 * previous round's defence votes.
 */
export const migration: Migration = {
  version: 2,
  name: 'invasion-messaging',
  sql: `
    ALTER TABLE invasions ADD COLUMN attack_message_id TEXT;

    CREATE TABLE defense_proposals (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      invasion_id   INTEGER NOT NULL REFERENCES invasions (id) ON DELETE CASCADE,
      proposer_id   TEXT    NOT NULL,
      troops        INTEGER NOT NULL CHECK (troops >= 0),
      gold          INTEGER NOT NULL DEFAULT 0 CHECK (gold >= 0),
      food          INTEGER NOT NULL DEFAULT 0 CHECK (food >= 0),
      status        TEXT    NOT NULL
                            CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
      vote_deadline INTEGER NOT NULL,
      message_id    TEXT,
      created_at    INTEGER NOT NULL,
      resolved_at   INTEGER
    );

    CREATE INDEX defense_proposals_by_invasion
      ON defense_proposals (invasion_id, status);
  `,
};
