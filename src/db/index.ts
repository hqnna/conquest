import SQLite from 'better-sqlite3';
import type {Database} from 'better-sqlite3';
import {migrate} from './migrations.js';

export type {Database};

/**
 * Opens the game database and brings its schema up to date.
 *
 * @param path filesystem path, or `':memory:'` for tests.
 */
export function openDatabase(path: string): Database {
  const db = new SQLite(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Conquest's writes are short transactions; wait rather than fail if the
  // sweeper and an interaction handler collide.
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

/** Opens a fresh in-memory database with the full schema, for tests. */
export function openTestDatabase(): Database {
  return openDatabase(':memory:');
}
