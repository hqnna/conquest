import type {Database} from 'better-sqlite3';
import {migration as initialSchema} from './migrations/001-initial-schema.js';
import {migration as invasionMessaging} from './migrations/002-invasion-messaging.js';
import {migration as guildSettings} from './migrations/005-guild-settings.js';
import {migration as roundTracking} from './migrations/004-round-tracking.js';
import {migration as totalConquest} from './migrations/006-total-conquest.js';
import {migration as warsOfAttrition} from './migrations/003-wars-of-attrition.js';

/** One forward-only schema change. */
export interface Migration {
  /** Monotonic version; migrations run in ascending order, exactly once. */
  version: number;
  /** Human-readable name, recorded in the migrations table. */
  name: string;
  /** DDL executed inside a transaction with the version bookkeeping. */
  sql: string;
}

/** Every migration, in the order they must be applied. */
export const MIGRATIONS: readonly Migration[] = [
  initialSchema,
  invasionMessaging,
  warsOfAttrition,
  roundTracking,
  guildSettings,
  totalConquest,
];

const MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    applied_at INTEGER NOT NULL
  );
`;

/**
 * Applies every migration the database has not seen yet. Each migration and
 * its bookkeeping row commit together, so an interrupted run never leaves a
 * half-applied schema.
 *
 * @returns the versions applied by this call.
 */
export function migrate(
  db: Database,
  migrations: readonly Migration[] = MIGRATIONS,
): number[] {
  db.exec(MIGRATIONS_TABLE);

  // A migration may rebuild a table other tables reference. SQLite ignores
  // this pragma inside a transaction, so it is set around the whole run.
  db.pragma('foreign_keys = OFF');

  const applied = new Set(
    db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map(row => (row as {version: number}).version),
  );

  const record = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );

  const ran: number[] = [];
  for (const migration of [...migrations].sort(
    (a, b) => a.version - b.version,
  )) {
    if (applied.has(migration.version)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      record.run(migration.version, migration.name, Date.now());
    })();
    ran.push(migration.version);
  }

  db.pragma('foreign_keys = ON');
  return ran;
}
