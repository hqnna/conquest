import {beforeEach, describe, expect, it} from 'vitest';
import type {Database} from 'better-sqlite3';
import {COOLDOWNS} from '../src/config/constants.js';
import {openTestDatabase} from '../src/db/index.js';
import {
  countCountryMembers,
  getPlayer,
  joinCountry,
  leaveCountry,
  listCountryMembers,
  memberCounts,
  transferPlayers,
} from '../src/db/players.js';

const NOW = 1_700_000_000_000;

describe('player repository', () => {
  let db: Database;

  beforeEach(() => {
    db = openTestDatabase();
  });

  it('records a join', () => {
    const player = joinCountry(db, {
      guildId: 'g1',
      userId: 'u1',
      code: 'FR',
      now: NOW,
    });
    expect(player).toEqual({
      guildId: 'g1',
      userId: 'u1',
      countryCode: 'FR',
      joinedAt: NOW,
      rejoinCooldownUntil: null,
    });
  });

  it('applies a rejoin cooldown on leaving', () => {
    joinCountry(db, {guildId: 'g1', userId: 'u1', code: 'FR', now: NOW});
    leaveCountry(db, {
      guildId: 'g1',
      userId: 'u1',
      now: NOW,
      withCooldown: true,
    });
    expect(getPlayer(db, 'g1', 'u1')).toEqual({
      guildId: 'g1',
      userId: 'u1',
      countryCode: null,
      joinedAt: null,
      rejoinCooldownUntil: NOW + COOLDOWNS.rejoin,
    });
  });

  it('skips the cooldown when the player left the server', () => {
    joinCountry(db, {guildId: 'g1', userId: 'u1', code: 'FR', now: NOW});
    leaveCountry(db, {
      guildId: 'g1',
      userId: 'u1',
      now: NOW,
      withCooldown: false,
    });
    expect(getPlayer(db, 'g1', 'u1')?.rejoinCooldownUntil).toBeNull();
  });

  it('clears a spent cooldown when the player joins again', () => {
    joinCountry(db, {guildId: 'g1', userId: 'u1', code: 'FR', now: NOW});
    leaveCountry(db, {
      guildId: 'g1',
      userId: 'u1',
      now: NOW,
      withCooldown: true,
    });
    const rejoined = joinCountry(db, {
      guildId: 'g1',
      userId: 'u1',
      code: 'DE',
      now: NOW + COOLDOWNS.rejoin + 1,
    });
    expect(rejoined.countryCode).toBe('DE');
    expect(rejoined.rejoinCooldownUntil).toBeNull();
  });

  it('lists and counts a country roster in join order', () => {
    joinCountry(db, {guildId: 'g1', userId: 'u2', code: 'FR', now: NOW + 2});
    joinCountry(db, {guildId: 'g1', userId: 'u1', code: 'FR', now: NOW + 1});
    joinCountry(db, {guildId: 'g1', userId: 'u3', code: 'DE', now: NOW});

    expect(listCountryMembers(db, 'g1', 'FR')).toEqual(['u1', 'u2']);
    expect(countCountryMembers(db, 'g1', 'FR')).toBe(2);
    expect(countCountryMembers(db, 'g1', 'BE')).toBe(0);
    expect(memberCounts(db, 'g1')).toEqual(
      new Map([
        ['FR', 2],
        ['DE', 1],
      ]),
    );
  });

  it('counts nobody for players who have left', () => {
    joinCountry(db, {guildId: 'g1', userId: 'u1', code: 'FR', now: NOW});
    leaveCountry(db, {
      guildId: 'g1',
      userId: 'u1',
      now: NOW,
      withCooldown: true,
    });
    expect(countCountryMembers(db, 'g1', 'FR')).toBe(0);
    expect(memberCounts(db, 'g1').size).toBe(0);
  });

  it('keeps guilds isolated', () => {
    joinCountry(db, {guildId: 'g1', userId: 'u1', code: 'FR', now: NOW});
    joinCountry(db, {guildId: 'g2', userId: 'u1', code: 'DE', now: NOW});
    expect(getPlayer(db, 'g1', 'u1')?.countryCode).toBe('FR');
    expect(getPlayer(db, 'g2', 'u1')?.countryCode).toBe('DE');
  });

  it('moves a conquered country whole into its conqueror', () => {
    joinCountry(db, {guildId: 'g1', userId: 'u1', code: 'DE', now: NOW});
    joinCountry(db, {guildId: 'g1', userId: 'u2', code: 'DE', now: NOW + 1});
    joinCountry(db, {guildId: 'g1', userId: 'u3', code: 'FR', now: NOW});

    const moved = transferPlayers(db, {
      guildId: 'g1',
      fromCode: 'DE',
      toCode: 'FR',
      now: NOW + 10,
    });

    expect(moved).toEqual(['u1', 'u2']);
    expect(listCountryMembers(db, 'g1', 'FR').sort()).toEqual([
      'u1',
      'u2',
      'u3',
    ]);
    expect(countCountryMembers(db, 'g1', 'DE')).toBe(0);
  });
});
