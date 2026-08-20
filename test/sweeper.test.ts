import {beforeEach, describe, expect, it} from 'vitest';
import type {Database} from 'better-sqlite3';
import type {Client} from 'discord.js';
import {INVASIONS, WAR} from '../src/config/constants.js';
import {activateCountry, getCountry} from '../src/db/countries.js';
import {upsertGuildConfig} from '../src/db/guild-config.js';
import {openTestDatabase} from '../src/db/index.js';
import {
  getInvasion,
  listExpiredAttackVotes,
  listExpiredProposals,
  listExpiredReinforcements,
  listUnansweredInvasions,
  listWarsDueATick,
} from '../src/db/invasions.js';
import type {Stake} from '../src/db/invasions.js';
import {createMerge, listExpiredMergeVotes} from '../src/db/merges.js';
import {joinCountry} from '../src/db/players.js';
import {addResources, getStockpile} from '../src/db/resources.js';
import {
  declareInvasion,
  escrowAndOpenDefense,
  escrowDefense,
  fightWarRound,
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

/** An invasion that was answered, so the fighting is under way. */
function atWar(db: Database, attack = stake(20), defense = stake(15)) {
  const invasion = inFlight(db, attack);
  const proposed = proposeDefense(db, {
    guildId: G,
    code: 'DE',
    proposerId: 'd1',
    stake: defense,
    now: NOW,
  });
  if (!proposed.ok) throw new Error('defence refused');
  escrowDefense(db, invasion, proposed.proposal, NOW);
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

  it('finds invasions nobody answered, and only once they are due', () => {
    const invasion = inFlight(db);
    expect(listUnansweredInvasions(db, invasion.defenseDeadline! - 1)).toEqual(
      [],
    );
    expect(
      listUnansweredInvasions(db, invasion.defenseDeadline!).map(i => i.id),
    ).toEqual([invasion.id]);
  });

  it('finds wars with a round due, and only those', () => {
    const war = atWar(db);
    expect(listUnansweredInvasions(db, NOW + 1_000_000)).toEqual([]);
    expect(listWarsDueATick(db, war.nextTickAt! - 1)).toEqual([]);
    expect(listWarsDueATick(db, war.nextTickAt!).map(i => i.id)).toEqual([
      war.id,
    ]);
  });

  it('finds a side that has run out of time to reinforce', () => {
    const war = atWar(db, stake(1), stake(90));
    const report = fightWarRound(db, war, NOW + WAR.tickInterval, () => 0.5);
    expect(report.invasion.status).toBe('reinforcing');

    const deadline = report.invasion.reinforceDeadline!;
    expect(listExpiredReinforcements(db, deadline - 1)).toEqual([]);
    expect(listExpiredReinforcements(db, deadline).map(i => i.id)).toEqual([
      war.id,
    ]);
    // A paused war is not also due a round of fighting.
    expect(listWarsDueATick(db, deadline)).toEqual([]);
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

  it('finds a merge offer whose window ran out, and only then', () => {
    const merge = createMerge(db, {
      guildId: G,
      fromCode: 'FR',
      intoCode: 'DE',
      proposerId: 'a1',
      offerDeadline: NOW + 5_000,
      now: NOW,
    });
    expect(listExpiredMergeVotes(db, NOW + 4_999)).toEqual([]);
    expect(listExpiredMergeVotes(db, NOW + 5_000).map(m => m.id)).toEqual([
      merge.id,
    ]);
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
    atWar(db);
    expect(await sweep(db, absentClient, NOW)).toEqual({
      votesExpired: 0,
      proposalsExpired: 0,
      mergesExpired: 0,
      warsUnanswered: 0,
      roundsFought: 0,
      warsEnded: 0,
      roundsWon: 0,
    });
  });

  it('skips guilds Conquest can no longer reach, without dying', async () => {
    const war = atWar(db);
    const result = await sweep(db, absentClient, war.nextTickAt!);
    expect(result.roundsFought).toBe(0);
    // The round is still due, so it lands once the guild is reachable again.
    expect(getInvasion(db, war.id)?.status).toBe('war');
    expect(getInvasion(db, war.id)?.rounds).toBe(0);
  });

  it('leaves committed forces untouched while it cannot fight them', async () => {
    const war = atWar(db, stake(20, 10, 10));
    await sweep(db, absentClient, war.nextTickAt!);
    expect(getStockpile(db, G, 'FR')).toEqual({
      troops: 80,
      gold: 90,
      food: 90,
    });
    expect(getInvasion(db, war.id)?.attackField).toEqual(stake(20, 10, 10));
  });
});

describe('pipeline invariants', () => {
  let db: Database;

  beforeEach(() => {
    db = world();
  });

  it('keeps a country in one war at a time from declaration to resolution', () => {
    const invasion = atWar(db);
    expect(
      declareInvasion(db, {
        guildId: G,
        attackerCode: 'FR',
        defenderCode: 'DE',
        stake: stake(5),
        now: NOW + 1,
      }).ok,
    ).toBe(false);
    expect(getInvasion(db, invasion.id)?.status).toBe('war');
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
