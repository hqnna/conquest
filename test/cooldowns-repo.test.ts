import {beforeEach, describe, expect, it} from 'vitest';
import type {Database} from 'better-sqlite3';
import {
  clearCooldowns,
  getCooldown,
  listCooldowns,
  setCooldown,
} from '../src/db/cooldowns.js';
import {openTestDatabase} from '../src/db/index.js';

const NOW = 1_700_000_000_000;

describe('gather cooldowns', () => {
  let db: Database;

  beforeEach(() => {
    db = openTestDatabase();
  });

  it('reports no cooldown for a player who never gathered', () => {
    expect(getCooldown(db, 'g1', 'u1', 'farm')).toBeNull();
    expect(listCooldowns(db, 'g1', 'u1').size).toBe(0);
  });

  it('stores a cooldown per player, per command', () => {
    setCooldown(db, 'g1', 'u1', 'farm', NOW + 100);
    setCooldown(db, 'g1', 'u1', 'mine', NOW + 200);
    setCooldown(db, 'g1', 'u2', 'farm', NOW + 300);

    expect(getCooldown(db, 'g1', 'u1', 'farm')).toBe(NOW + 100);
    expect(getCooldown(db, 'g1', 'u1', 'mine')).toBe(NOW + 200);
    expect(getCooldown(db, 'g1', 'u1', 'recruit')).toBeNull();
    expect(getCooldown(db, 'g1', 'u2', 'farm')).toBe(NOW + 300);
  });

  it('replaces a cooldown rather than stacking rows', () => {
    setCooldown(db, 'g1', 'u1', 'farm', NOW + 100);
    setCooldown(db, 'g1', 'u1', 'farm', NOW + 500);
    expect(getCooldown(db, 'g1', 'u1', 'farm')).toBe(NOW + 500);
    expect(listCooldowns(db, 'g1', 'u1').size).toBe(1);
  });

  it('keeps guilds apart, so one game cannot gate another', () => {
    setCooldown(db, 'g1', 'u1', 'farm', NOW + 100);
    expect(getCooldown(db, 'g2', 'u1', 'farm')).toBeNull();
  });

  it('lists every cooldown a player has', () => {
    setCooldown(db, 'g1', 'u1', 'farm', NOW + 100);
    setCooldown(db, 'g1', 'u1', 'recruit', NOW + 900);
    expect(listCooldowns(db, 'g1', 'u1')).toEqual(
      new Map([
        ['farm', NOW + 100],
        ['recruit', NOW + 900],
      ]),
    );
  });

  it('clears only the guild it is asked to clear', () => {
    setCooldown(db, 'g1', 'u1', 'farm', NOW + 100);
    setCooldown(db, 'g2', 'u1', 'farm', NOW + 100);
    clearCooldowns(db, 'g1');
    expect(getCooldown(db, 'g1', 'u1', 'farm')).toBeNull();
    expect(getCooldown(db, 'g2', 'u1', 'farm')).toBe(NOW + 100);
  });
});
