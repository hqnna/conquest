import {beforeEach, describe, expect, it} from 'vitest';
import type {Database} from 'better-sqlite3';
import {GAME} from '../src/config/constants.js';
import {openTestDatabase} from '../src/db/index.js';
import {
  deleteGuildConfig,
  getGuildConfig,
  setDominationThreshold,
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

  it('stores the category, log channel, and default threshold', () => {
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
      dominationThreshold: GAME.defaultDominationThreshold,
      createdAt: 1_000,
    });
    expect(getGuildConfig(db, 'guild-1')).toEqual(config);
  });

  it('re-running setup repoints the category without resetting tuning', () => {
    upsertGuildConfig(db, {
      guildId: 'guild-1',
      categoryId: 'cat-1',
      logChannelId: 'log-1',
      now: 1_000,
    });
    setDominationThreshold(db, 'guild-1', 3);

    const updated = upsertGuildConfig(db, {
      guildId: 'guild-1',
      categoryId: 'cat-2',
      logChannelId: 'log-2',
      now: 2_000,
    });

    expect(updated.categoryId).toBe('cat-2');
    expect(updated.logChannelId).toBe('log-2');
    expect(updated.dominationThreshold).toBe(3);
    expect(updated.createdAt).toBe(1_000);
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
    setDominationThreshold(db, 'guild-2', 4);

    expect(getGuildConfig(db, 'guild-1')?.categoryId).toBe('cat-1');
    expect(getGuildConfig(db, 'guild-1')?.dominationThreshold).toBe(
      GAME.defaultDominationThreshold,
    );
    expect(getGuildConfig(db, 'guild-2')?.dominationThreshold).toBe(4);
  });

  it('refuses to set a threshold for an unconfigured guild', () => {
    expect(() => setDominationThreshold(db, 'guild-x', 5)).toThrow(
      /No Conquest configuration/,
    );
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
