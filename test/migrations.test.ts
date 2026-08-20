import {describe, expect, it} from 'vitest';
import SQLite from 'better-sqlite3';
import {MIGRATIONS, migrate} from '../src/db/migrations.js';
import {openTestDatabase} from '../src/db/index.js';

interface TableRow {
  name: string;
}

function tableNames(db: SQLite.Database): string[] {
  return db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all()
    .map(row => (row as TableRow).name);
}

describe('migrations', () => {
  it('creates every table in the data model', () => {
    const db = openTestDatabase();
    expect(tableNames(db)).toEqual(
      expect.arrayContaining([
        'countries',
        'gather_cooldowns',
        'guild_config',
        'invasions',
        'merge_votes',
        'merges',
        'players',
        'schema_migrations',
        'votes',
      ]),
    );
  });

  it('records every applied migration exactly once', () => {
    const db = openTestDatabase();
    const applied = db
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all()
      .map(row => (row as {version: number}).version);
    expect(applied).toEqual(MIGRATIONS.map(m => m.version));
  });

  it('is idempotent, so a restart re-runs nothing', () => {
    const db = openTestDatabase();
    expect(migrate(db)).toEqual([]);
  });

  it('applies only migrations the database has not seen', () => {
    const db = new SQLite(':memory:');
    expect(migrate(db, MIGRATIONS.slice(0, 1)).length).toBe(1);
    expect(migrate(db, MIGRATIONS)).toEqual(
      MIGRATIONS.slice(1).map(m => m.version),
    );
  });

  it('retires the old win conditions when it upgrades an older database', () => {
    const db = new SQLite(':memory:');
    // Everything up to and including guild settings, but not total conquest.
    migrate(
      db,
      MIGRATIONS.filter(m => m.version < 6),
    );
    db.prepare(
      `INSERT INTO guild_settings (guild_id, key, value, set_at)
       VALUES ('g', 'domination_threshold', 4, 0),
              ('g', 'last_standing_duration', 60, 0),
              ('g', 'war_tick', 5, 0)`,
    ).run();

    expect(migrate(db, MIGRATIONS)).toEqual([6, 7]);

    expect(
      db.prepare('SELECT key FROM guild_settings ORDER BY key').all(),
    ).toEqual([{key: 'war_tick'}]);
    const columns = db
      .prepare('SELECT name FROM pragma_table_info(?)')
      .all('guild_config')
      .map(row => (row as TableRow).name);
    expect(columns).not.toContain('sole_active_code');
    expect(columns).not.toContain('sole_active_since');
  });

  it('leaves the schema untouched when a migration fails', () => {
    const db = new SQLite(':memory:');
    const broken = [
      {version: 1, name: 'broken', sql: 'CREATE TABLE ok (a); CREATE TABLE ;'},
    ];
    expect(() => migrate(db, broken)).toThrow();
    expect(tableNames(db)).not.toContain('ok');
    expect(
      db.prepare('SELECT count(*) AS n FROM schema_migrations').get(),
    ).toEqual({n: 0});
  });
});

describe('schema constraints', () => {
  it('rejects unknown country statuses', () => {
    const db = openTestDatabase();
    expect(() =>
      db
        .prepare(
          "INSERT INTO countries (guild_id, code, name, status) VALUES ('g', 'FR', 'France', 'conquering')",
        )
        .run(),
    ).toThrow();
  });

  it('rejects negative stockpiles', () => {
    const db = openTestDatabase();
    expect(() =>
      db
        .prepare(
          "INSERT INTO countries (guild_id, code, name, status, troops) VALUES ('g', 'FR', 'France', 'active', -1)",
        )
        .run(),
    ).toThrow();
  });

  it('scopes country codes per guild', () => {
    const db = openTestDatabase();
    const insert = db.prepare(
      'INSERT INTO countries (guild_id, code, name, status) VALUES (?, ?, ?, ?)',
    );
    insert.run('guild-a', 'FR', 'France', 'active');
    insert.run('guild-b', 'FR', 'France', 'active');
    expect(() => insert.run('guild-a', 'FR', 'France', 'active')).toThrow();
  });

  it('allows one vote per voter per invasion side', () => {
    const db = openTestDatabase();
    db.prepare(
      `INSERT INTO invasions
         (id, guild_id, attacker_code, defender_code, attack_troops,
          attack_gold, attack_food, status, attack_vote_deadline, created_at)
       VALUES (1, 'g', 'FR', 'DE', 10, 0, 0, 'attack_vote', 0, 0)`,
    ).run();
    const vote = db.prepare(
      'INSERT INTO votes (invasion_id, kind, user_id, choice, created_at) VALUES (?, ?, ?, ?, 0)',
    );
    vote.run(1, 'attack', 'user-1', 'approve');
    vote.run(1, 'defense', 'user-1', 'approve');
    expect(() => vote.run(1, 'attack', 'user-1', 'reject')).toThrow();
  });

  it('deletes votes with their invasion', () => {
    const db = openTestDatabase();
    db.prepare(
      `INSERT INTO invasions
         (id, guild_id, attacker_code, defender_code, attack_troops,
          attack_gold, attack_food, status, attack_vote_deadline, created_at)
       VALUES (1, 'g', 'FR', 'DE', 10, 0, 0, 'attack_vote', 0, 0)`,
    ).run();
    db.prepare(
      "INSERT INTO votes (invasion_id, kind, user_id, choice, created_at) VALUES (1, 'attack', 'u', 'approve', 0)",
    ).run();
    db.prepare('DELETE FROM invasions WHERE id = 1').run();
    expect(db.prepare('SELECT count(*) AS n FROM votes').get()).toEqual({n: 0});
  });
});
