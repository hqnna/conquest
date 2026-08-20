import {beforeEach, describe, expect, it} from 'vitest';
import type {Database} from 'better-sqlite3';
import {GAME} from '../src/config/constants.js';
import {
  activateCountry,
  getCountry,
  listCountries,
} from '../src/db/countries.js';
import type {CountryState} from '../src/db/countries.js';
import {setCooldown, getCooldown} from '../src/db/cooldowns.js';
import {getGuildConfig, upsertGuildConfig} from '../src/db/guild-config.js';
import {
  forgetSettings,
  setOverride,
  settingsFor,
} from '../src/db/guild-settings.js';
import {openTestDatabase} from '../src/db/index.js';
import {getInvasion} from '../src/db/invasions.js';
import {getPlayer, joinCountry} from '../src/db/players.js';
import {addResources} from '../src/db/resources.js';
import {castVote, tallyVotes} from '../src/db/votes.js';
import {declareInvasion} from '../src/game/invasions.js';
import {
  checkVictory,
  findDominator,
  resetGame,
  summariseVictory,
} from '../src/game/victory.js';

const NOW = 1_700_000_000_000;
const G = 'g1';

function country(
  code: string,
  overrides: Partial<CountryState> = {},
): CountryState {
  return {
    guildId: G,
    code,
    name: code,
    status: 'active',
    ownerCode: null,
    channelId: `chan-${code}`,
    roleId: `role-${code}`,
    food: 0,
    gold: 0,
    troops: 0,
    activatedAt: NOW,
    protectedUntil: null,
    invadeCooldownUntil: null,
    defenseImmunityUntil: null,
    ...overrides,
  };
}

/** Retunes the win condition, the way `/game tune` does. */
function setThreshold(db: Database, guildId: string, value: number) {
  setOverride(db, guildId, 'domination_threshold', value, NOW);
  forgetSettings(guildId);
}

function world(codes = ['FR', 'DE', 'BE']): Database {
  const db = openTestDatabase();
  upsertGuildConfig(db, {
    guildId: G,
    categoryId: 'cat',
    logChannelId: 'log',
    now: NOW,
  });
  for (const code of codes) {
    activateCountry(db, {
      guildId: G,
      code,
      name: code,
      channelId: `chan-${code}`,
      roleId: `role-${code}`,
      now: NOW,
    });
  }
  return db;
}

/** Marks a country conquered by another, as a war's conclusion would. */
function conquer(db: Database, loser: string, winner: string) {
  db.prepare(
    `UPDATE countries SET status = 'defeated', owner_code = ?, role_id = NULL
      WHERE guild_id = ? AND code = ?`,
  ).run(winner, G, loser);
}

describe('findDominator', () => {
  it('finds nobody when nobody has enough', () => {
    expect(
      findDominator([country('FR')], new Map([['FR', 9]]), 10),
    ).toBeUndefined();
  });

  it('finds a country that has reached the threshold exactly', () => {
    expect(findDominator([country('FR')], new Map([['FR', 10]]), 10)).toEqual({
      code: 'FR',
      territories: 10,
    });
  });

  it('picks the largest empire when more than one qualifies', () => {
    expect(
      findDominator(
        [country('FR'), country('DE')],
        new Map([
          ['FR', 11],
          ['DE', 14],
        ]),
        10,
      ),
    ).toEqual({code: 'DE', territories: 14});
  });

  it('ignores countries that are not standing', () => {
    expect(findDominator([], new Map([['DE', 20]]), 10)).toBeUndefined();
  });
});

describe('checkVictory', () => {
  let db: Database;

  beforeEach(() => {
    db = world();
  });

  it('sees no winner in a contested world', () => {
    expect(checkVictory(db, G, NOW)).toBeUndefined();
  });

  it('declares a winner that reaches the territory threshold', () => {
    setThreshold(db, G, 2);
    conquer(db, 'DE', 'FR');
    conquer(db, 'BE', 'FR');

    expect(checkVictory(db, G, NOW + 5_000)).toEqual({
      code: 'FR',
      reason: 'domination',
      territories: 2,
      duration: 5_000,
    });
  });

  it('does not declare one a territory short', () => {
    setThreshold(db, G, 3);
    conquer(db, 'DE', 'FR');
    conquer(db, 'BE', 'FR');
    expect(checkVictory(db, G, NOW)).toBeUndefined();
  });

  it('starts the clock when a country is left alone', () => {
    conquer(db, 'DE', 'FR');
    conquer(db, 'BE', 'FR');
    setThreshold(db, G, 99);

    expect(checkVictory(db, G, NOW + 1_000)).toBeUndefined();
    expect(getGuildConfig(db, G)).toMatchObject({
      soleActiveCode: 'FR',
      soleActiveSince: NOW + 1_000,
    });
  });

  it('declares a walkover once it has stood alone long enough', () => {
    conquer(db, 'DE', 'FR');
    conquer(db, 'BE', 'FR');
    setThreshold(db, G, 99);
    checkVictory(db, G, NOW);

    expect(
      checkVictory(db, G, NOW + GAME.lastCountryStandingDuration - 1),
    ).toBeUndefined();
    expect(checkVictory(db, G, NOW + GAME.lastCountryStandingDuration)).toEqual(
      {
        code: 'FR',
        reason: 'last_standing',
        territories: 2,
        duration: GAME.lastCountryStandingDuration,
      },
    );
  });

  it('restarts the clock from scratch when somebody else joins the world', () => {
    conquer(db, 'DE', 'FR');
    conquer(db, 'BE', 'FR');
    setThreshold(db, G, 99);
    checkVictory(db, G, NOW);

    // Somebody founds a country, so France is no longer alone.
    activateCountry(db, {
      guildId: G,
      code: 'NL',
      name: 'NL',
      channelId: 'c',
      roleId: 'r',
      now: NOW + 10,
    });
    expect(checkVictory(db, G, NOW + 20)).toBeUndefined();
    expect(getGuildConfig(db, G)?.soleActiveCode).toBeNull();

    // They leave again: the clock starts over rather than resuming.
    db.prepare(
      "UPDATE countries SET status = 'inactive' WHERE guild_id = ? AND code = 'NL'",
    ).run(G);
    checkVictory(db, G, NOW + 30);
    expect(getGuildConfig(db, G)?.soleActiveSince).toBe(NOW + 30);
    expect(
      checkVictory(db, G, NOW + GAME.lastCountryStandingDuration),
    ).toBeUndefined();
  });

  it('restarts the clock when the survivor is a different country', () => {
    setThreshold(db, G, 99);
    db.prepare(
      "UPDATE countries SET status = 'inactive' WHERE code IN ('DE', 'BE')",
    ).run();
    checkVictory(db, G, NOW);

    db.prepare(
      "UPDATE countries SET status = 'inactive' WHERE code = 'FR'",
    ).run();
    db.prepare(
      "UPDATE countries SET status = 'active' WHERE code = 'DE'",
    ).run();
    checkVictory(db, G, NOW + 50);

    expect(getGuildConfig(db, G)).toMatchObject({
      soleActiveCode: 'DE',
      soleActiveSince: NOW + 50,
    });
  });

  it('sees no winner in an empty world', () => {
    db.prepare("UPDATE countries SET status = 'inactive'").run();
    expect(checkVictory(db, G, NOW)).toBeUndefined();
  });

  it('prefers domination when both could apply', () => {
    setThreshold(db, G, 2);
    conquer(db, 'DE', 'FR');
    conquer(db, 'BE', 'FR');
    checkVictory(db, G, NOW);
    expect(
      checkVictory(db, G, NOW + GAME.lastCountryStandingDuration)?.reason,
    ).toBe('domination');
  });

  it('says nothing for a guild that never ran setup', () => {
    expect(checkVictory(db, 'unconfigured', NOW)).toBeUndefined();
  });
});

describe('summariseVictory', () => {
  it('reads the winner roster and holdings', () => {
    const db = world();
    joinCountry(db, {guildId: G, userId: 'u1', code: 'FR', now: NOW});
    joinCountry(db, {guildId: G, userId: 'u2', code: 'FR', now: NOW + 1});
    conquer(db, 'DE', 'FR');

    const summary = summariseVictory(db, G, 'FR');
    expect(summary.members).toEqual(['u1', 'u2']);
    expect(summary.territories.map(t => t.code)).toEqual(['DE']);
  });
});

describe('resetGame', () => {
  let db: Database;

  beforeEach(() => {
    db = world();
    joinCountry(db, {guildId: G, userId: 'u1', code: 'FR', now: NOW});
    joinCountry(db, {guildId: G, userId: 'u2', code: 'DE', now: NOW});
    addResources(db, G, 'FR', {troops: 50, gold: 50, food: 50});
    setCooldown(db, G, 'u1', 'farm', NOW + 1_000);
  });

  it('hands back every channel and role to delete', () => {
    conquer(db, 'BE', 'FR');
    const teardown = resetGame(db, G, NOW + 100);

    expect(teardown.channelIds.sort()).toEqual([
      'chan-BE',
      'chan-DE',
      'chan-FR',
    ]);
    // The conquered country's role was already deleted when it fell.
    expect(teardown.roleIds.sort()).toEqual(['role-DE', 'role-FR']);
  });

  it('wipes the countries, players, and cooldowns', () => {
    resetGame(db, G, NOW + 100);

    expect(listCountries(db, G)).toEqual([]);
    expect(getCountry(db, G, 'FR')).toBeUndefined();
    expect(getPlayer(db, G, 'u1')).toBeUndefined();
    expect(getCooldown(db, G, 'u1', 'farm')).toBeNull();
  });

  it('wipes invasions, and the votes hanging off them', () => {
    addResources(db, G, 'FR', {troops: 100});
    db.prepare('UPDATE countries SET protected_until = NULL').run();
    const declared = declareInvasion(db, {
      guildId: G,
      attackerCode: 'FR',
      defenderCode: 'DE',
      stake: {troops: 5, gold: 0, food: 0},
      now: NOW,
    });
    if (!declared.ok) throw new Error('unexpected');
    castVote(db, {
      invasionId: declared.invasion.id,
      kind: 'attack',
      userId: 'u1',
      choice: 'approve',
      now: NOW,
    });

    resetGame(db, G, NOW + 100);

    expect(getInvasion(db, declared.invasion.id)).toBeUndefined();
    expect(tallyVotes(db, declared.invasion.id, 'attack')).toEqual({
      approve: 0,
      reject: 0,
    });
  });

  it('keeps the guild setup and its tuning, and starts a new round', () => {
    setThreshold(db, G, 4);
    resetGame(db, G, NOW + 100);

    expect(getGuildConfig(db, G)).toMatchObject({
      categoryId: 'cat',
      logChannelId: 'log',
      createdAt: NOW,
      roundStartedAt: NOW + 100,
      soleActiveCode: null,
      soleActiveSince: null,
    });
    // A wiped round is still this server's game, tuned the way it chose.
    expect(settingsFor(db, G).game.dominationThreshold).toBe(4);
  });

  it('leaves other guilds untouched', () => {
    upsertGuildConfig(db, {
      guildId: 'g2',
      categoryId: 'cat2',
      logChannelId: 'log2',
      now: NOW,
    });
    activateCountry(db, {
      guildId: 'g2',
      code: 'FR',
      name: 'FR',
      channelId: 'c',
      roleId: 'r',
      now: NOW,
    });
    joinCountry(db, {guildId: 'g2', userId: 'u1', code: 'FR', now: NOW});

    resetGame(db, G, NOW + 100);

    expect(listCountries(db, 'g2')).toHaveLength(1);
    expect(getPlayer(db, 'g2', 'u1')).toBeDefined();
  });

  it('leaves a world nobody can win, so the next round starts clean', () => {
    resetGame(db, G, NOW + 100);
    expect(checkVictory(db, G, NOW + 200)).toBeUndefined();
  });
});
