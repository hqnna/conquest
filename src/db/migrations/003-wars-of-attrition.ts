import type {Migration} from '../migrations.js';

/**
 * Invasions become wars fought over many rounds.
 *
 * An invasion now carries two figures per side: what has been committed in
 * total, which only grows as reinforcements are approved, and what is still
 * standing on the field, which the attrition ticks eat away. When a side's
 * force is spent it must reinforce or give up, so the row also tracks whose
 * turn it is to answer that and by when.
 *
 * `status` gains `war` and `reinforcing`. SQLite cannot loosen a CHECK
 * constraint in place, so the table is rebuilt and its rows carried over.
 *
 * `defense_proposals` becomes `stake_proposals`: the same vote now covers the
 * opening defence and every reinforcement either side proposes, so a proposal
 * records which side it belongs to.
 */
export const migration: Migration = {
  version: 3,
  name: 'wars-of-attrition',
  sql: `
    CREATE TABLE invasions_rebuilt (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id               TEXT    NOT NULL,
      attacker_code          TEXT    NOT NULL,
      defender_code          TEXT    NOT NULL,

      -- Everything committed over the whole war, reinforcements included.
      attack_troops          INTEGER NOT NULL CHECK (attack_troops >= 0),
      attack_gold            INTEGER NOT NULL DEFAULT 0 CHECK (attack_gold >= 0),
      attack_food            INTEGER NOT NULL DEFAULT 0 CHECK (attack_food >= 0),
      defense_troops         INTEGER CHECK (defense_troops IS NULL OR defense_troops >= 0),
      defense_gold           INTEGER CHECK (defense_gold IS NULL OR defense_gold >= 0),
      defense_food           INTEGER CHECK (defense_food IS NULL OR defense_food >= 0),

      -- What is still standing on the field right now.
      attack_field_troops    INTEGER NOT NULL DEFAULT 0 CHECK (attack_field_troops >= 0),
      attack_field_gold      INTEGER NOT NULL DEFAULT 0 CHECK (attack_field_gold >= 0),
      attack_field_food      INTEGER NOT NULL DEFAULT 0 CHECK (attack_field_food >= 0),
      defense_field_troops   INTEGER NOT NULL DEFAULT 0 CHECK (defense_field_troops >= 0),
      defense_field_gold     INTEGER NOT NULL DEFAULT 0 CHECK (defense_field_gold >= 0),
      defense_field_food     INTEGER NOT NULL DEFAULT 0 CHECK (defense_field_food >= 0),

      status                 TEXT    NOT NULL
                                     CHECK (status IN (
                                       'attack_vote',
                                       'defense_window',
                                       'war',
                                       'reinforcing',
                                       'resolved_attacker_win',
                                       'resolved_defender_win',
                                       'cancelled'
                                     )),
      attack_vote_deadline   INTEGER NOT NULL,
      defense_deadline       INTEGER,
      -- When the next blow lands.
      next_tick_at           INTEGER,
      -- Which side must answer for its spent force, and by when.
      reinforcing_side       TEXT    CHECK (reinforcing_side IS NULL
                                            OR reinforcing_side IN ('attacker', 'defender')),
      reinforce_deadline     INTEGER,
      rounds                 INTEGER NOT NULL DEFAULT 0 CHECK (rounds >= 0),
      attack_message_id      TEXT,
      created_at             INTEGER NOT NULL,
      resolved_at            INTEGER
    );

    INSERT INTO invasions_rebuilt
      (id, guild_id, attacker_code, defender_code,
       attack_troops, attack_gold, attack_food,
       defense_troops, defense_gold, defense_food,
       attack_field_troops, attack_field_gold, attack_field_food,
       defense_field_troops, defense_field_gold, defense_field_food,
       status, attack_vote_deadline, defense_deadline,
       attack_message_id, created_at, resolved_at)
    SELECT
       id, guild_id, attacker_code, defender_code,
       attack_troops, attack_gold, attack_food,
       defense_troops, defense_gold, defense_food,
       attack_troops, attack_gold, attack_food,
       COALESCE(defense_troops, 0), COALESCE(defense_gold, 0), COALESCE(defense_food, 0),
       status, attack_vote_deadline, defense_deadline,
       attack_message_id, created_at, resolved_at
      FROM invasions;

    DROP TABLE invasions;
    ALTER TABLE invasions_rebuilt RENAME TO invasions;

    CREATE INDEX invasions_by_status ON invasions (guild_id, status);
    CREATE INDEX invasions_by_attacker ON invasions (guild_id, attacker_code);
    CREATE INDEX invasions_by_defender ON invasions (guild_id, defender_code);
    CREATE INDEX invasions_by_tick ON invasions (status, next_tick_at);

    CREATE TABLE stake_proposals (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      invasion_id   INTEGER NOT NULL REFERENCES invasions (id) ON DELETE CASCADE,
      side          TEXT    NOT NULL CHECK (side IN ('attacker', 'defender')),
      kind          TEXT    NOT NULL CHECK (kind IN ('defense', 'reinforcement')),
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

    INSERT INTO stake_proposals
      (id, invasion_id, side, kind, proposer_id, troops, gold, food,
       status, vote_deadline, message_id, created_at, resolved_at)
    SELECT
       id, invasion_id, 'defender', 'defense', proposer_id, troops, gold, food,
       status, vote_deadline, message_id, created_at, resolved_at
      FROM defense_proposals;

    DROP TABLE defense_proposals;

    CREATE INDEX stake_proposals_by_invasion
      ON stake_proposals (invasion_id, status);
  `,
};
