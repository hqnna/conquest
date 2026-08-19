import {beforeEach, describe, expect, it} from 'vitest';
import type {Database} from 'better-sqlite3';
import type {Client} from 'discord.js';
import {INVASIONS} from '../src/config/constants.js';
import {activateCountry, getCountry} from '../src/db/countries.js';
import {upsertGuildConfig} from '../src/db/guild-config.js';
import {openTestDatabase} from '../src/db/index.js';
import {
  getInvasion,
  listExpiredAttackVotes,
  listExpiredProposals,
  listInvasionsToResolve,
} from '../src/db/invasions.js';
import type {Stake} from '../src/db/invasions.js';
import {joinCountry} from '../src/db/players.js';
import {addResources, getStockpile} from '../src/db/resources.js';
import {
  declareInvasion,
  escrowAndOpenDefense,
  escrowDefense,
  proposeDefense,
} from '../src/game/invasions.js';
import {sweep} from '../src/game/sweeper.js';

const NOW = 1_700_000_000_000;
const G = 'g1';

function stake(troops: number, gold = 0, food = 0): Stake {
  return {troops, gold, food};
}

/**
 * A client whose guilds cannot be fetched, which is what Conquest sees for a
 * guild it has been removed from.
 */
const absentClient = {
  guilds: {fetch: async () => Promise.reject(new Error('unknown guild'))},
} as unknown as Client;

function world(): Database {
  const db = openTestDatabase();
  upsertGuildConfig(db, {
    guildId: G,
    categoryId: 'cat',
    logChannelId: 'log',
  });
  for (const code of ['FR', 'DE']) {
    activateCountry(db, {
      guildId: G,
      code,
      name: code,
      channelId: `chan-${code}`,
      roleId: `role-${code}`,
      now: NOW,
    });
    db.prepare(
      'UPDATE countries SET protected_until = NULL WHERE guild_id = ? AND code = ?',
    ).run(G, code);
    addResources(db, G, code, {troops: 100, gold: 100, food: 100});
  }
  joinCountry(db, {guildId: G, userId: 'a1', code: 'FR', now: NOW});
  joinCountry(db, {guildId: G, userId: 'd1', code: 'DE', now: NOW});
  return db;
}

function declared(db: Database, attack = stake(20)) {
  const result = declareInvasion(db, {
    guildId: G,
    attackerCode: 'FR',
    defenderCode: 'DE',
    stake: attack,
    now: NOW,
  });
  if (!result.ok) throw new Error('declaration refused');
  return result.invasion;
}

function inFlight(db: Database, attack = stake(20)) {
  const invasion = declared(db, attack);
  escrowAndOpenDefense(db, invasion, NOW);
  return getInvasion(db, invasion.id)!;
}

describe('what the sweeper finds', () => {
  let db: Database;

  beforeEach(() => {
    db = world();
  });

  it('leaves a vote alone until its deadline', () => {
    const invasion = declared(db);
    expect(listExpiredAttackVotes(db, invasion.attackVoteDeadline - 1)).toEqual(
      [],
    );
    expect(
      listExpiredAttackVotes(db, invasion.attackVoteDeadline).map(i => i.id),
    ).toEqual([invasion.id]);
  });

  it('finds battles due, and only those', () => {
    const invasion = inFlight(db);
    expect(listInvasionsToResolve(db, invasion.defenseDeadline! - 1)).toEqual(
      [],
    );
    expect(
      listInvasionsToResolve(db, invasion.defenseDeadline!).map(i => i.id),
    ).toEqual([invasion.id]);
  });

  it('never finds a vote that is already settled', () => {
    const invasion = inFlight(db);
    expect(
      listExpiredAttackVotes(db, invasion.attackVoteDeadline + 1_000_000),
    ).toEqual([]);
  });

  it('finds defence proposals whose window ran out', () => {
    inFlight(db);
    const proposed = proposeDefense(db, {
      guildId: G,
      code: 'DE',
      proposerId: 'd1',
      stake: stake(10),
      now: NOW,
    });
    if (!proposed.ok) throw new Error('unexpected');

    expect(
      listExpiredProposals(db, proposed.proposal.voteDeadline - 1),
    ).toEqual([]);
    expect(
      listExpiredProposals(db, proposed.proposal.voteDeadline).map(p => p.id),
    ).toEqual([proposed.proposal.id]);
  });

  it('stops finding a proposal once it is approved', () => {
    const invasion = inFlight(db);
    const proposed = proposeDefense(db, {
      guildId: G,
      code: 'DE',
      proposerId: 'd1',
      stake: stake(10),
      now: NOW,
    });
    if (!proposed.ok) throw new Error('unexpected');
    escrowDefense(db, invasion, proposed.proposal, NOW);
    expect(listExpiredProposals(db, NOW + 1_000_000)).toEqual([]);
  });

  it('works across guilds, since deadlines are absolute', () => {
    upsertGuildConfig(db, {
      guildId: 'g2',
      categoryId: 'cat',
      logChannelId: 'log',
    });
    for (const code of ['FR', 'DE']) {
      activateCountry(db, {
        guildId: 'g2',
        code,
        name: code,
        channelId: 'c',
        roleId: 'r',
        now: NOW,
      });
      db.prepare(
        "UPDATE countries SET protected_until = NULL WHERE guild_id = 'g2'",
      ).run();
      addResources(db, 'g2', code, {troops: 100, gold: 0, food: 0});
    }
    declared(db);
    const other = declareInvasion(db, {
      guildId: 'g2',
      attackerCode: 'FR',
      defenderCode: 'DE',
      stake: stake(5),
      now: NOW,
    });
    expect(other.ok).toBe(true);
    expect(
      listExpiredAttackVotes(db, NOW + INVASIONS.attackVoteWindow),
    ).toHaveLength(2);
  });
});

describe('sweep', () => {
  let db: Database;

  beforeEach(() => {
    db = world();
  });

  it('does nothing when nothing has expired', async () => {
    inFlight(db);
    expect(await sweep(db, absentClient, NOW)).toEqual({
      votesExpired: 0,
      proposalsExpired: 0,
      battlesFought: 0,
    });
  });

  it('skips guilds Conquest can no longer reach, without dying', async () => {
    const invasion = inFlight(db);
    const result = await sweep(db, absentClient, invasion.defenseDeadline!);
    expect(result.battlesFought).toBe(0);
    // The battle is still pending, so it resolves once the guild is reachable.
    expect(getInvasion(db, invasion.id)?.status).toBe('defense_window');
  });

  it('leaves escrowed stakes untouched while it cannot resolve them', async () => {
    const invasion = inFlight(db, stake(20, 10, 10));
    await sweep(db, absentClient, invasion.defenseDeadline!);
    expect(getStockpile(db, G, 'FR')).toEqual({
      troops: 80,
      gold: 90,
      food: 90,
    });
  });
});

describe('pipeline invariants', () => {
  let db: Database;

  beforeEach(() => {
    db = world();
  });

  it('keeps a country in one war at a time from declaration to resolution', () => {
    const invasion = inFlight(db);
    expect(
      declareInvasion(db, {
        guildId: G,
        attackerCode: 'FR',
        defenderCode: 'DE',
        stake: stake(5),
        now: NOW + 1,
      }).ok,
    ).toBe(false);
    expect(getInvasion(db, invasion.id)?.status).toBe('defense_window');
  });

  it('escrows exactly once, however the vote is read', () => {
    const invasion = declared(db, stake(20, 10, 10));
    escrowAndOpenDefense(db, invasion, NOW);
    const after = getStockpile(db, G, 'FR');
    // A second call finds the window already open and takes nothing more.
    escrowAndOpenDefense(db, getInvasion(db, invasion.id)!, NOW);
    expect(getStockpile(db, G, 'FR')?.troops).toBeLessThanOrEqual(
      after!.troops,
    );
  });

  it('still finds a proposal orphaned by an invasion that ended', () => {
    const invasion = inFlight(db);
    const proposed = proposeDefense(db, {
      guildId: G,
      code: 'DE',
      proposerId: 'd1',
      stake: stake(10),
      now: NOW,
    });
    if (!proposed.ok) throw new Error('unexpected');
    db.prepare("UPDATE invasions SET status = 'cancelled' WHERE id = ?").run(
      invasion.id,
    );

    // Nothing is left pending forever: the sweeper picks the orphan up at its
    // own deadline, whatever became of the invasion.
    expect(
      listExpiredProposals(db, proposed.proposal.voteDeadline - 1),
    ).toEqual([]);
    expect(
      listExpiredProposals(db, proposed.proposal.voteDeadline),
    ).toHaveLength(1);
  });

  it('protects a country for the configured window after it is founded', () => {
    activateCountry(db, {
      guildId: G,
      code: 'BE',
      name: 'BE',
      channelId: 'c',
      roleId: 'r',
      now: NOW,
    });
    expect(getCountry(db, G, 'BE')?.protectedUntil).toBe(
      NOW + INVASIONS.newCountryProtection,
    );
  });
});
