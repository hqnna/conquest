import {beforeEach, describe, expect, it} from 'vitest';
import type {Database} from 'better-sqlite3';
import {INVASIONS} from '../src/config/constants.js';
import {
  activateCountry,
  clearCountryRole,
  deactivateCountry,
  getCountry,
  listCountriesByStatus,
  listTerritories,
  setCountryChannel,
  territoryCounts,
} from '../src/db/countries.js';
import {openTestDatabase} from '../src/db/index.js';

const NOW = 1_700_000_000_000;

function activate(db: Database, code: string, guildId = 'g1') {
  return activateCountry(db, {
    guildId,
    code,
    name: code,
    channelId: `chan-${code}`,
    roleId: `role-${code}`,
    now: NOW,
  });
}

/** Conquest marks a country defeated; that transaction arrives with invasions. */
function conquer(db: Database, loser: string, winner: string, guildId = 'g1') {
  db.prepare(
    `UPDATE countries SET status = 'defeated', owner_code = ?, role_id = NULL
      WHERE guild_id = ? AND code = ?`,
  ).run(winner, guildId, loser);
}

describe('country repository', () => {
  let db: Database;

  beforeEach(() => {
    db = openTestDatabase();
  });

  it('treats a country with no row as never activated', () => {
    expect(getCountry(db, 'g1', 'FR')).toBeUndefined();
  });

  it('activates a country with protection and an empty stockpile', () => {
    const state = activate(db, 'FR');
    expect(state).toMatchObject({
      status: 'active',
      channelId: 'chan-FR',
      roleId: 'role-FR',
      food: 0,
      gold: 0,
      troops: 0,
      activatedAt: NOW,
      protectedUntil: NOW + INVASIONS.newCountryProtection,
      ownerCode: null,
    });
  });

  it('reactivates a disbanded country from a clean slate', () => {
    activate(db, 'FR');
    db.prepare(
      "UPDATE countries SET food = 99, gold = 99, troops = 99 WHERE code = 'FR'",
    ).run();
    deactivateCountry(db, 'g1', 'FR');

    const again = activateCountry(db, {
      guildId: 'g1',
      code: 'FR',
      name: 'France',
      channelId: 'chan-2',
      roleId: 'role-2',
      now: NOW + 5_000,
    });
    expect(again).toMatchObject({
      status: 'active',
      food: 0,
      gold: 0,
      troops: 0,
      channelId: 'chan-2',
      protectedUntil: NOW + 5_000 + INVASIONS.newCountryProtection,
    });
  });

  it('keeps guilds isolated', () => {
    activate(db, 'FR', 'g1');
    expect(getCountry(db, 'g2', 'FR')).toBeUndefined();
    activate(db, 'FR', 'g2');
    expect(listCountriesByStatus(db, 'g1', 'active')).toHaveLength(1);
  });

  it('lists and counts territories per owner', () => {
    activate(db, 'FR');
    activate(db, 'DE');
    activate(db, 'BE');
    conquer(db, 'DE', 'FR');
    conquer(db, 'BE', 'FR');

    expect(listTerritories(db, 'g1', 'FR').map(t => t.code)).toEqual([
      'BE',
      'DE',
    ]);
    // France, plus the two it took.
    expect(territoryCounts(db, 'g1').get('FR')).toBe(3);
    // A fallen country holds nothing, not even itself.
    expect(territoryCounts(db, 'g1').has('DE')).toBe(false);
    expect(listCountriesByStatus(db, 'g1', 'defeated')).toHaveLength(2);
  });

  it('counts a country that has taken nobody as holding its homeland', () => {
    activate(db, 'FR');
    expect(territoryCounts(db, 'g1').get('FR')).toBe(1);
  });

  it('releases every territory when a country is disbanded', () => {
    activate(db, 'FR');
    activate(db, 'DE');
    activate(db, 'BE');
    conquer(db, 'DE', 'FR');
    conquer(db, 'BE', 'FR');

    const released = deactivateCountry(db, 'g1', 'FR');

    expect(released.map(t => t.code)).toEqual(['BE', 'DE']);
    expect(released.map(t => t.channelId)).toEqual(['chan-BE', 'chan-DE']);
    for (const code of ['FR', 'DE', 'BE']) {
      expect(getCountry(db, 'g1', code)).toMatchObject({
        status: 'inactive',
        ownerCode: null,
        channelId: null,
        roleId: null,
        food: 0,
        gold: 0,
        troops: 0,
        activatedAt: null,
        protectedUntil: null,
      });
    }
  });

  it('leaves other countries alone when one is disbanded', () => {
    activate(db, 'FR');
    activate(db, 'DE');
    deactivateCountry(db, 'g1', 'FR');
    expect(getCountry(db, 'g1', 'DE')?.status).toBe('active');
  });

  it('wipes a disbanded country stockpile', () => {
    activate(db, 'FR');
    db.prepare(
      "UPDATE countries SET food = 40, gold = 30, troops = 20 WHERE code = 'FR'",
    ).run();
    deactivateCountry(db, 'g1', 'FR');
    expect(getCountry(db, 'g1', 'FR')).toMatchObject({
      food: 0,
      gold: 0,
      troops: 0,
    });
  });

  it('tracks a defeated country archive and forgets its role', () => {
    activate(db, 'FR');
    setCountryChannel(db, 'g1', 'FR', 'archive-1');
    clearCountryRole(db, 'g1', 'FR');
    expect(getCountry(db, 'g1', 'FR')).toMatchObject({
      channelId: 'archive-1',
      roleId: null,
    });
  });
});
