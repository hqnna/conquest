import type {Migration} from '../migrations.js';

/**
 * The complete game schema from the design document.
 *
 * Timestamps are epoch milliseconds stored as INTEGER, so every deadline,
 * cooldown, and protection survives a restart — Conquest never relies on an
 * in-memory timer.
 *
 * Foreign keys are declared only where a cascade is unambiguous. References
 * between countries (`owner_code`) and from players to countries are composite
 * and partially nullable, where SQLite's cascade actions cannot express what
 * the game needs; those are maintained by the repositories inside
 * transactions instead.
 */
export const migration: Migration = {
  version: 1,
  name: 'initial-schema',
  sql: `
    CREATE TABLE guild_config (
      guild_id             TEXT    PRIMARY KEY,
      category_id          TEXT    NOT NULL,
      log_channel_id       TEXT    NOT NULL,
      domination_threshold INTEGER NOT NULL,
      created_at           INTEGER NOT NULL
    );

    CREATE TABLE countries (
      guild_id               TEXT    NOT NULL,
      code                   TEXT    NOT NULL,
      name                   TEXT    NOT NULL,
      status                 TEXT    NOT NULL
                                     CHECK (status IN ('inactive', 'active', 'defeated')),
      owner_code             TEXT,
      channel_id             TEXT,
      role_id                TEXT,
      food                   INTEGER NOT NULL DEFAULT 0 CHECK (food >= 0),
      gold                   INTEGER NOT NULL DEFAULT 0 CHECK (gold >= 0),
      troops                 INTEGER NOT NULL DEFAULT 0 CHECK (troops >= 0),
      activated_at           INTEGER,
      protected_until        INTEGER,
      invade_cooldown_until  INTEGER,
      defense_immunity_until INTEGER,
      PRIMARY KEY (guild_id, code)
    );

    CREATE INDEX countries_by_status ON countries (guild_id, status);
    CREATE INDEX countries_by_owner ON countries (guild_id, owner_code);

    CREATE TABLE players (
      guild_id              TEXT NOT NULL,
      user_id               TEXT NOT NULL,
      country_code          TEXT,
      joined_at             INTEGER,
      rejoin_cooldown_until INTEGER,
      PRIMARY KEY (guild_id, user_id)
    );

    CREATE INDEX players_by_country ON players (guild_id, country_code);

    CREATE TABLE gather_cooldowns (
      guild_id           TEXT    NOT NULL,
      user_id            TEXT    NOT NULL,
      command            TEXT    NOT NULL,
      next_available_at  INTEGER NOT NULL,
      PRIMARY KEY (guild_id, user_id, command)
    );

    CREATE TABLE invasions (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id             TEXT    NOT NULL,
      attacker_code        TEXT    NOT NULL,
      defender_code        TEXT    NOT NULL,
      attack_troops        INTEGER NOT NULL CHECK (attack_troops >= 0),
      attack_gold          INTEGER NOT NULL DEFAULT 0 CHECK (attack_gold >= 0),
      attack_food          INTEGER NOT NULL DEFAULT 0 CHECK (attack_food >= 0),
      defense_troops       INTEGER CHECK (defense_troops IS NULL OR defense_troops >= 0),
      defense_gold         INTEGER CHECK (defense_gold IS NULL OR defense_gold >= 0),
      defense_food         INTEGER CHECK (defense_food IS NULL OR defense_food >= 0),
      status               TEXT    NOT NULL
                                   CHECK (status IN (
                                     'attack_vote',
                                     'defense_window',
                                     'resolved_attacker_win',
                                     'resolved_defender_win',
                                     'cancelled'
                                   )),
      attack_vote_deadline INTEGER NOT NULL,
      defense_deadline     INTEGER,
      created_at           INTEGER NOT NULL,
      resolved_at          INTEGER
    );

    CREATE INDEX invasions_by_status ON invasions (guild_id, status);
    CREATE INDEX invasions_by_attacker ON invasions (guild_id, attacker_code);
    CREATE INDEX invasions_by_defender ON invasions (guild_id, defender_code);

    CREATE TABLE votes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      invasion_id INTEGER NOT NULL REFERENCES invasions (id) ON DELETE CASCADE,
      kind        TEXT    NOT NULL CHECK (kind IN ('attack', 'defense')),
      user_id     TEXT    NOT NULL,
      choice      TEXT    NOT NULL CHECK (choice IN ('approve', 'reject')),
      created_at  INTEGER NOT NULL,
      UNIQUE (invasion_id, kind, user_id)
    );
  `,
};
