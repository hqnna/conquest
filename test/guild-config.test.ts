import {beforeEach, describe, expect, it} from 'vitest';
import type {Database} from 'better-sqlite3';
import {openTestDatabase} from '../src/db/index.js';
import {
  deleteGuildConfig,
  getGuildConfig,
  upsertGuildConfig,
} from '../src/db/guild-config.js';

describe('guild config', () => {
  let db: Database;

  beforeEach(() => {
    db = openTestDatabase();
  });

  it('returns undefined before setup has run', () => {
    expect(getGuildConfig(db, 'guild-1')).toBeUndefined();
  });

  it('stores the category, the log channel, and the round start', () => {
    const config = upsertGuildConfig(db, {
      guildId: 'guild-1',
      categoryId: 'cat-1',
      logChannelId: 'log-1',
      now: 1_000,
    });

    expect(config).toEqual({
      guildId: 'guild-1',
      categoryId: 'cat-1',
      logChannelId: 'log-1',
      createdAt: 1_000,
      roundStartedAt: 1_000,
    });
    expect(getGuildConfig(db, 'guild-1')).toEqual(config);
  });

  it('re-running setup repoints the category without restarting the round', () => {
    upsertGuildConfig(db, {
      guildId: 'guild-1',
      categoryId: 'cat-1',
      logChannelId: 'log-1',
      now: 1_000,
    });

    const updated = upsertGuildConfig(db, {
      guildId: 'guild-1',
      categoryId: 'cat-2',
      logChannelId: 'log-2',
      now: 2_000,
    });

    expect(updated.categoryId).toBe('cat-2');
    expect(updated.logChannelId).toBe('log-2');
    expect(updated.createdAt).toBe(1_000);
    expect(updated.roundStartedAt).toBe(1_000);
  });

  it('keeps guilds isolated from each other', () => {
    upsertGuildConfig(db, {
      guildId: 'guild-1',
      categoryId: 'cat-1',
      logChannelId: 'log-1',
    });
    upsertGuildConfig(db, {
      guildId: 'guild-2',
      categoryId: 'cat-2',
      logChannelId: 'log-2',
    });

    expect(getGuildConfig(db, 'guild-1')?.categoryId).toBe('cat-1');
    expect(getGuildConfig(db, 'guild-2')?.categoryId).toBe('cat-2');
  });

  it('deletes only the named guild', () => {
    upsertGuildConfig(db, {
      guildId: 'guild-1',
      categoryId: 'c',
      logChannelId: 'l',
    });
    upsertGuildConfig(db, {
      guildId: 'guild-2',
      categoryId: 'c',
      logChannelId: 'l',
    });

    deleteGuildConfig(db, 'guild-1');

    expect(getGuildConfig(db, 'guild-1')).toBeUndefined();
    expect(getGuildConfig(db, 'guild-2')).toBeDefined();
  });
});
