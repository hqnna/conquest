import {beforeEach, describe, expect, it} from 'vitest';
import type {Database} from 'better-sqlite3';
import {
  activateCountry,
  getCountry,
  listCountries,
} from '../src/db/countries.js';
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
  resetGame,
  summariseVictory,
} from '../src/game/victory.js';

const NOW = 1_700_000_000_000;
const G = 'g1';

/** Retunes a setting, the way `/game tune` does. */
function tune(db: Database, guildId: string, key: string, value: number) {
  setOverride(db, guildId, key, value, NOW);
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

describe('checkVictory', () => {
  let db: Database;

  beforeEach(() => {
    db = world();
  });

  it('sees no winner in a contested world', () => {
    expect(checkVictory(db, G, NOW)).toBeUndefined();
  });

  it('declares the country that has taken every other one', () => {
    conquer(db, 'DE', 'FR');
    conquer(db, 'BE', 'FR');

    expect(checkVictory(db, G, NOW + 5_000)).toEqual({
      code: 'FR',
      // Its own homeland, and the two it took.
      territories: 3,
      duration: 5_000,
    });
  });

  it('waits while any rival is still standing', () => {
    conquer(db, 'DE', 'FR');
    expect(checkVictory(db, G, NOW)).toBeUndefined();
  });

  it('does not hand the round to the first country founded', () => {
    db.prepare(
      "UPDATE countries SET status = 'inactive' WHERE code IN ('DE', 'BE')",
    ).run();
    // France stands alone only because nobody else has joined yet.
    expect(checkVictory(db, G, NOW)).toBeUndefined();
  });

  it('does not count a rival that disbanded rather than fell', () => {
    conquer(db, 'DE', 'FR');
    // Belgium's last player leaves, so it deactivates on its own.
    db.prepare(
      "UPDATE countries SET status = 'inactive' WHERE code = 'BE'",
    ).run();

    expect(checkVictory(db, G, NOW)).toMatchObject({code: 'FR'});
  });

  it('waits when the only survivor never conquered anybody', () => {
    db.prepare(
      "UPDATE countries SET status = 'inactive' WHERE code IN ('DE', 'BE')",
    ).run();
    expect(checkVictory(db, G, NOW + 10_000)).toBeUndefined();
  });

  it('sees no winner in an empty world', () => {
    db.prepare("UPDATE countries SET status = 'inactive'").run();
    expect(checkVictory(db, G, NOW)).toBeUndefined();
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
    tune(db, G, 'gather_cooldown', 45);
    resetGame(db, G, NOW + 100);

    expect(getGuildConfig(db, G)).toMatchObject({
      categoryId: 'cat',
      logChannelId: 'log',
      createdAt: NOW,
      roundStartedAt: NOW + 100,
    });
    // A wiped round is still this server's game, tuned the way it chose.
    expect(settingsFor(db, G).cooldowns.farm).toBe(45 * 60_000);
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
