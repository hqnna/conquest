import {beforeEach, describe, expect, it} from 'vitest';
import type {Database} from 'better-sqlite3';
import {activateCountry} from '../src/db/countries.js';
import {openTestDatabase} from '../src/db/index.js';
import {
  addResources,
  getStockpile,
  lootStockpile,
  spendResources,
} from '../src/db/resources.js';

const NOW = 1_700_000_000_000;

function activate(db: Database, code: string, guildId = 'g1') {
  activateCountry(db, {
    guildId,
    code,
    name: code,
    channelId: `chan-${code}`,
    roleId: `role-${code}`,
    now: NOW,
  });
}

describe('stockpiles', () => {
  let db: Database;

  beforeEach(() => {
    db = openTestDatabase();
    activate(db, 'FR');
    activate(db, 'DE');
  });

  it('starts a country empty', () => {
    expect(getStockpile(db, 'g1', 'FR')).toEqual({food: 0, gold: 0, troops: 0});
  });

  it('has no stockpile for a country that does not exist', () => {
    expect(getStockpile(db, 'g1', 'BE')).toBeUndefined();
  });

  it('adds only the resources it is given', () => {
    addResources(db, 'g1', 'FR', {food: 10});
    addResources(db, 'g1', 'FR', {gold: 3, troops: 2});
    expect(getStockpile(db, 'g1', 'FR')).toEqual({
      food: 10,
      gold: 3,
      troops: 2,
    });
  });

  it('keeps countries and guilds apart', () => {
    addResources(db, 'g1', 'FR', {food: 10});
    expect(getStockpile(db, 'g1', 'DE')?.food).toBe(0);
    activate(db, 'FR', 'g2');
    expect(getStockpile(db, 'g2', 'FR')?.food).toBe(0);
  });

  it('spends what a country can afford', () => {
    addResources(db, 'g1', 'FR', {gold: 20, food: 20});
    expect(spendResources(db, 'g1', 'FR', {gold: 10, food: 10})).toBe(true);
    expect(getStockpile(db, 'g1', 'FR')).toEqual({
      food: 10,
      gold: 10,
      troops: 0,
    });
  });

  it('refuses to overdraw, and changes nothing when it does', () => {
    addResources(db, 'g1', 'FR', {gold: 10, food: 4});
    expect(spendResources(db, 'g1', 'FR', {gold: 10, food: 10})).toBe(false);
    expect(getStockpile(db, 'g1', 'FR')).toEqual({
      food: 4,
      gold: 10,
      troops: 0,
    });
  });

  it('lets a country spend down to exactly zero', () => {
    addResources(db, 'g1', 'FR', {gold: 10, food: 10});
    expect(spendResources(db, 'g1', 'FR', {gold: 10, food: 10})).toBe(true);
    expect(getStockpile(db, 'g1', 'FR')).toEqual({
      food: 0,
      gold: 0,
      troops: 0,
    });
  });

  it('cannot be raced into a negative stockpile', () => {
    addResources(db, 'g1', 'FR', {gold: 15, food: 15});
    const first = spendResources(db, 'g1', 'FR', {gold: 10, food: 10});
    const second = spendResources(db, 'g1', 'FR', {gold: 10, food: 10});
    expect([first, second]).toEqual([true, false]);
    expect(getStockpile(db, 'g1', 'FR')).toEqual({
      food: 5,
      gold: 5,
      troops: 0,
    });
  });

  it('loots everything a country had into its conqueror', () => {
    addResources(db, 'g1', 'DE', {food: 7, gold: 8, troops: 9});
    addResources(db, 'g1', 'FR', {food: 1, gold: 1, troops: 1});

    const taken = lootStockpile(db, 'g1', 'DE', 'FR');

    expect(taken).toEqual({food: 7, gold: 8, troops: 9});
    expect(getStockpile(db, 'g1', 'DE')).toEqual({
      food: 0,
      gold: 0,
      troops: 0,
    });
    expect(getStockpile(db, 'g1', 'FR')).toEqual({
      food: 8,
      gold: 9,
      troops: 10,
    });
  });

  it('loots an empty country without complaint', () => {
    expect(lootStockpile(db, 'g1', 'DE', 'FR')).toEqual({
      food: 0,
      gold: 0,
      troops: 0,
    });
  });
});
