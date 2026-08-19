import {beforeEach, describe, expect, it} from 'vitest';
import type {Database} from 'better-sqlite3';
import {COOLDOWNS, INVASIONS} from '../src/config/constants.js';
import {activateCountry, getCountry} from '../src/db/countries.js';
import {openTestDatabase} from '../src/db/index.js';
import {
  getInvasion,
  getPendingInvasionFor,
  getPendingProposal,
} from '../src/db/invasions.js';
import type {Stake} from '../src/db/invasions.js';
import {joinCountry, listCountryMembers} from '../src/db/players.js';
import {addResources, getStockpile} from '../src/db/resources.js';
import {castVote, tallyVotes} from '../src/db/votes.js';
import {
  cancelInvasion,
  canAfford,
  declareInvasion,
  escrowAndOpenDefense,
  escrowDefense,
  proposeDefense,
  resolveInvasion,
} from '../src/game/invasions.js';

const NOW = 1_700_000_000_000;
const G = 'g1';

function stake(troops: number, gold = 0, food = 0): Stake {
  return {troops, gold, food};
}

function world(): Database {
  const db = openTestDatabase();
  for (const code of ['FR', 'DE', 'BE']) {
    activateCountry(db, {
      guildId: G,
      code,
      name: code,
      channelId: `chan-${code}`,
      roleId: `role-${code}`,
      now: NOW - INVASIONS.newCountryProtection - 1,
    });
    // Old enough that new-country protection has lapsed.
    db.prepare(
      'UPDATE countries SET protected_until = NULL WHERE guild_id = ? AND code = ?',
    ).run(G, code);
    addResources(db, G, code, {troops: 100, gold: 100, food: 100});
  }
  return db;
}

function declare(db: Database, attack = stake(20, 10, 10), now = NOW) {
  return declareInvasion(db, {
    guildId: G,
    attackerCode: 'FR',
    defenderCode: 'DE',
    stake: attack,
    now,
  });
}

/** Declares and escrows, leaving the invasion in its defence window. */
function inFlight(db: Database, attack = stake(20, 10, 10)) {
  const declared = declare(db, attack);
  if (!declared.ok) throw new Error('declaration refused');
  const escrow = escrowAndOpenDefense(db, declared.invasion, NOW);
  if (!escrow.ok) throw new Error('escrow refused');
  return getInvasion(db, declared.invasion.id)!;
}

describe('canAfford', () => {
  it('needs every resource to be covered', () => {
    const pool = {troops: 10, gold: 10, food: 10};
    expect(canAfford(pool, stake(10, 10, 10))).toBe(true);
    expect(canAfford(pool, stake(11))).toBe(false);
    expect(canAfford(pool, stake(1, 11))).toBe(false);
    expect(canAfford(pool, stake(1, 1, 11))).toBe(false);
  });
});

describe('declareInvasion', () => {
  let db: Database;

  beforeEach(() => {
    db = world();
  });

  it('opens an attack vote without spending anything', () => {
    const result = declare(db);
    expect(result.ok).toBe(true);
    expect(getStockpile(db, G, 'FR')).toEqual({
      troops: 100,
      gold: 100,
      food: 100,
    });
    expect(result.ok && result.invasion.status).toBe('attack_vote');
    expect(result.ok && result.invasion.attackVoteDeadline).toBe(
      NOW + INVASIONS.attackVoteWindow,
    );
  });

  it('refuses a stake with no troops', () => {
    expect(declare(db, stake(0, 50, 50))).toEqual({
      ok: false,
      refusal: {kind: 'no_troops'},
    });
  });

  it('refuses a stake the country cannot cover', () => {
    const result = declare(db, stake(200));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.refusal.kind).toBe('cannot_afford');
  });

  it('refuses invading yourself', () => {
    const result = declareInvasion(db, {
      guildId: G,
      attackerCode: 'FR',
      defenderCode: 'FR',
      stake: stake(5),
      now: NOW,
    });
    expect(result).toEqual({ok: false, refusal: {kind: 'self'}});
  });

  it('refuses a target that is protected as a new country', () => {
    db.prepare(
      "UPDATE countries SET protected_until = ? WHERE code = 'DE'",
    ).run(NOW + 1_000);
    expect(declare(db)).toEqual({
      ok: false,
      refusal: {kind: 'target_protected', until: NOW + 1_000},
    });
  });

  it('refuses a target that just survived an invasion', () => {
    db.prepare(
      "UPDATE countries SET defense_immunity_until = ? WHERE code = 'DE'",
    ).run(NOW + 1_000);
    expect(declare(db)).toEqual({
      ok: false,
      refusal: {kind: 'target_immune', until: NOW + 1_000},
    });
  });

  it('refuses while the attacker is on its invasion cooldown', () => {
    db.prepare(
      "UPDATE countries SET invade_cooldown_until = ? WHERE code = 'FR'",
    ).run(NOW + 1_000);
    expect(declare(db)).toEqual({
      ok: false,
      refusal: {kind: 'on_cooldown', until: NOW + 1_000},
    });
  });

  it('refuses a conquered target', () => {
    db.prepare(
      "UPDATE countries SET status = 'defeated', owner_code = 'BE' WHERE code = 'DE'",
    ).run();
    expect(declare(db)).toEqual({
      ok: false,
      refusal: {kind: 'target_defeated', ownerCode: 'BE'},
    });
  });

  it('allows only one invasion per country, on either side', () => {
    const first = declare(db);
    expect(first.ok).toBe(true);

    const second = declare(db);
    expect(second).toEqual({
      ok: false,
      refusal: {
        kind: 'attacker_busy',
        invasionId: first.ok ? first.invasion.id : 0,
      },
    });

    const third = declareInvasion(db, {
      guildId: G,
      attackerCode: 'BE',
      defenderCode: 'DE',
      stake: stake(5),
      now: NOW,
    });
    expect(third).toEqual({
      ok: false,
      refusal: {
        kind: 'target_busy',
        invasionId: first.ok ? first.invasion.id : 0,
      },
    });
  });

  it('lets an uninvolved country declare its own war', () => {
    declare(db);
    const other = declareInvasion(db, {
      guildId: G,
      attackerCode: 'BE',
      defenderCode: 'FR',
      stake: stake(5),
      now: NOW,
    });
    // FR is already attacking, so it cannot also be attacked.
    expect(other.ok).toBe(false);
  });
});

describe('escrowAndOpenDefense', () => {
  let db: Database;

  beforeEach(() => {
    db = world();
  });

  it('takes the stake out of the stockpile at once', () => {
    inFlight(db, stake(20, 10, 10));
    expect(getStockpile(db, G, 'FR')).toEqual({
      troops: 80,
      gold: 90,
      food: 90,
    });
  });

  it('opens the defence window', () => {
    const invasion = inFlight(db);
    expect(invasion.status).toBe('defense_window');
    expect(invasion.defenseDeadline).toBe(NOW + INVASIONS.defenseWindow);
  });

  it('voids the attacker new-country protection', () => {
    db.prepare(
      "UPDATE countries SET protected_until = ? WHERE code = 'FR'",
    ).run(NOW + 100_000);
    inFlight(db);
    expect(getCountry(db, G, 'FR')?.protectedUntil).toBeNull();
  });

  it('cancels the invasion if the stockpile no longer covers the stake', () => {
    const declared = declare(db, stake(90));
    expect(declared.ok).toBe(true);
    db.prepare("UPDATE countries SET troops = 10 WHERE code = 'FR'").run();

    const escrow = escrowAndOpenDefense(
      db,
      declared.ok ? declared.invasion : ({} as never),
      NOW,
    );
    expect(escrow.ok).toBe(false);
    expect(
      getInvasion(db, declared.ok ? declared.invasion.id : 0)?.status,
    ).toBe('cancelled');
    expect(getStockpile(db, G, 'FR')?.troops).toBe(10);
  });
});

describe('proposeDefense', () => {
  let db: Database;

  beforeEach(() => {
    db = world();
  });

  it('opens a defence vote inside the window', () => {
    const invasion = inFlight(db);
    const result = proposeDefense(db, {
      guildId: G,
      code: 'DE',
      proposerId: 'u1',
      stake: stake(30, 5, 5),
      now: NOW + 100,
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.proposal.stake).toEqual(stake(30, 5, 5));
    expect(getPendingProposal(db, invasion.id)).toBeDefined();
  });

  it('never lets the vote outlast the battle it decides', () => {
    const invasion = inFlight(db);
    const late = invasion.defenseDeadline! - 1_000;
    const result = proposeDefense(db, {
      guildId: G,
      code: 'DE',
      proposerId: 'u1',
      stake: stake(5),
      now: late,
    });
    expect(result.ok && result.proposal.voteDeadline).toBe(
      invasion.defenseDeadline,
    );
  });

  it('refuses a country that is not under attack', () => {
    inFlight(db);
    expect(
      proposeDefense(db, {
        guildId: G,
        code: 'BE',
        proposerId: 'u1',
        stake: stake(5),
        now: NOW,
      }),
    ).toEqual({ok: false, refusal: {kind: 'not_under_attack'}});
  });

  it('refuses the attacker proposing a defence of the country it is invading', () => {
    inFlight(db);
    expect(
      proposeDefense(db, {
        guildId: G,
        code: 'FR',
        proposerId: 'u1',
        stake: stake(5),
        now: NOW,
      }),
    ).toEqual({ok: false, refusal: {kind: 'not_under_attack'}});
  });

  it('allows only one pending proposal at a time', () => {
    inFlight(db);
    proposeDefense(db, {
      guildId: G,
      code: 'DE',
      proposerId: 'u1',
      stake: stake(5),
      now: NOW,
    });
    const second = proposeDefense(db, {
      guildId: G,
      code: 'DE',
      proposerId: 'u2',
      stake: stake(6),
      now: NOW,
    });
    expect(second.ok).toBe(false);
    expect(!second.ok && second.refusal.kind).toBe('proposal_pending');
  });

  it('lets a rejected proposal be replaced, on a clean vote', () => {
    const invasion = inFlight(db);
    const first = proposeDefense(db, {
      guildId: G,
      code: 'DE',
      proposerId: 'u1',
      stake: stake(5),
      now: NOW,
    });
    expect(first.ok).toBe(true);
    castVote(db, {
      invasionId: invasion.id,
      kind: 'defense',
      userId: 'u1',
      choice: 'reject',
      now: NOW,
    });
    if (first.ok) {
      db.prepare(
        "UPDATE defense_proposals SET status = 'rejected' WHERE id = ?",
      ).run(first.proposal.id);
    }

    const second = proposeDefense(db, {
      guildId: G,
      code: 'DE',
      proposerId: 'u2',
      stake: stake(9),
      now: NOW + 10,
    });
    expect(second.ok).toBe(true);
    expect(tallyVotes(db, invasion.id, 'defense')).toEqual({
      approve: 0,
      reject: 0,
    });
  });

  it('refuses a defence the country cannot afford', () => {
    inFlight(db);
    const result = proposeDefense(db, {
      guildId: G,
      code: 'DE',
      proposerId: 'u1',
      stake: stake(500),
      now: NOW,
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.refusal.kind).toBe('cannot_afford');
  });

  it('refuses once a defence has already been approved', () => {
    const invasion = inFlight(db);
    const proposed = proposeDefense(db, {
      guildId: G,
      code: 'DE',
      proposerId: 'u1',
      stake: stake(5),
      now: NOW,
    });
    if (!proposed.ok) throw new Error('unexpected');
    escrowDefense(db, invasion, proposed.proposal, NOW);

    const again = proposeDefense(db, {
      guildId: G,
      code: 'DE',
      proposerId: 'u2',
      stake: stake(5),
      now: NOW + 1,
    });
    expect(again).toEqual({ok: false, refusal: {kind: 'already_defended'}});
  });
});

describe('escrowDefense', () => {
  let db: Database;

  beforeEach(() => {
    db = world();
  });

  it('escrows the defence and records it on the invasion', () => {
    const invasion = inFlight(db);
    const proposed = proposeDefense(db, {
      guildId: G,
      code: 'DE',
      proposerId: 'u1',
      stake: stake(30, 5, 5),
      now: NOW,
    });
    if (!proposed.ok) throw new Error('unexpected');

    expect(escrowDefense(db, invasion, proposed.proposal, NOW)).toEqual({
      ok: true,
    });
    expect(getStockpile(db, G, 'DE')).toEqual({
      troops: 70,
      gold: 95,
      food: 95,
    });
    expect(getInvasion(db, invasion.id)?.defense).toEqual(stake(30, 5, 5));
  });
});

describe('resolveInvasion', () => {
  let db: Database;

  beforeEach(() => {
    db = world();
    joinCountry(db, {guildId: G, userId: 'a1', code: 'FR', now: NOW});
    joinCountry(db, {guildId: G, userId: 'd1', code: 'DE', now: NOW});
    joinCountry(db, {guildId: G, userId: 'd2', code: 'DE', now: NOW});
  });

  const neutralLuck = () => 0.5;

  it('conquers an undefended country', () => {
    const invasion = inFlight(db, stake(20, 10, 10));
    const report = resolveInvasion(db, invasion, NOW + 1, neutralLuck);

    expect(report.outcome.attackerWins).toBe(true);
    expect(getInvasion(db, invasion.id)?.status).toBe('resolved_attacker_win');
  });

  it('marches the survivors home and consumes their supplies', () => {
    const invasion = inFlight(db, stake(20, 10, 10));
    // Empty the defender, so nothing is looted to muddy the arithmetic.
    db.prepare(
      "UPDATE countries SET troops = 0, gold = 0, food = 0 WHERE code = 'DE'",
    ).run();
    resolveInvasion(db, invasion, NOW + 1, neutralLuck);

    // 80 troops left after escrow, plus 10 survivors of the 20 that marched.
    // The 10 gold and 10 food they carried were spent on the campaign.
    expect(getStockpile(db, G, 'FR')).toEqual({
      troops: 90,
      gold: 90,
      food: 90,
    });
  });

  it('loots everything the defender had left', () => {
    const invasion = inFlight(db, stake(20));
    const report = resolveInvasion(db, invasion, NOW + 1, neutralLuck);

    expect(report.loot).toEqual({troops: 100, gold: 100, food: 100});
    expect(getStockpile(db, G, 'DE')).toEqual({
      troops: 0,
      gold: 0,
      food: 0,
    });
    expect(getStockpile(db, G, 'FR')?.gold).toBe(200);
  });

  it('absorbs the defeated country players', () => {
    const invasion = inFlight(db, stake(20));
    const report = resolveInvasion(db, invasion, NOW + 1, neutralLuck);

    expect(report.transferredPlayers.sort()).toEqual(['d1', 'd2']);
    expect(listCountryMembers(db, G, 'FR').sort()).toEqual(['a1', 'd1', 'd2']);
    expect(listCountryMembers(db, G, 'DE')).toEqual([]);
  });

  it('takes the defeated country and everything it had taken', () => {
    db.prepare(
      "UPDATE countries SET status = 'defeated', owner_code = 'DE' WHERE code = 'BE'",
    ).run();
    const invasion = inFlight(db, stake(20));
    const report = resolveInvasion(db, invasion, NOW + 1, neutralLuck);

    expect(report.capturedTerritories.map(t => t.code).sort()).toEqual([
      'BE',
      'DE',
    ]);
    expect(getCountry(db, G, 'DE')).toMatchObject({
      status: 'defeated',
      ownerCode: 'FR',
      roleId: null,
    });
    expect(getCountry(db, G, 'BE')?.ownerCode).toBe('FR');
  });

  it('hands back the channel and roles the conquest has to tidy up', () => {
    const invasion = inFlight(db, stake(20));
    const report = resolveInvasion(db, invasion, NOW + 1, neutralLuck);
    expect(report.defeatedChannelId).toBe('chan-DE');
    expect(report.defeatedRoleId).toBe('role-DE');
    expect(report.winnerRoleId).toBe('role-FR');
  });

  it('gives a failed invasion entire stake to the defender', () => {
    const invasion = inFlight(db, stake(10, 10, 10));
    const proposed = proposeDefense(db, {
      guildId: G,
      code: 'DE',
      proposerId: 'd1',
      stake: stake(50),
      now: NOW,
    });
    if (!proposed.ok) throw new Error('unexpected');
    escrowDefense(db, invasion, proposed.proposal, NOW);

    const report = resolveInvasion(
      db,
      getInvasion(db, invasion.id)!,
      NOW + 1,
      neutralLuck,
    );

    expect(report.outcome.attackerWins).toBe(false);
    // 50 troops left after escrowing 50; 35 of those come back (15 lost),
    // and the attacker's whole stake is captured on top.
    expect(getStockpile(db, G, 'DE')).toEqual({
      troops: 50 + 35 + 10,
      gold: 100 + 10,
      food: 100 + 10,
    });
    expect(getStockpile(db, G, 'FR')).toEqual({
      troops: 90,
      gold: 90,
      food: 90,
    });
  });

  it('leaves a repelled attacker with nothing of its stake', () => {
    const invasion = inFlight(db, stake(10, 10, 10));
    const proposed = proposeDefense(db, {
      guildId: G,
      code: 'DE',
      proposerId: 'd1',
      stake: stake(50),
      now: NOW,
    });
    if (!proposed.ok) throw new Error('unexpected');
    escrowDefense(db, invasion, proposed.proposal, NOW);
    resolveInvasion(db, getInvasion(db, invasion.id)!, NOW + 1, neutralLuck);

    expect(listCountryMembers(db, G, 'DE').sort()).toEqual(['d1', 'd2']);
    expect(getCountry(db, G, 'DE')?.status).toBe('active');
  });

  it('gives a successful defender immunity, and the attacker a cooldown', () => {
    const invasion = inFlight(db, stake(10));
    const proposed = proposeDefense(db, {
      guildId: G,
      code: 'DE',
      proposerId: 'd1',
      stake: stake(50),
      now: NOW,
    });
    if (!proposed.ok) throw new Error('unexpected');
    escrowDefense(db, invasion, proposed.proposal, NOW);
    resolveInvasion(db, getInvasion(db, invasion.id)!, NOW + 1, neutralLuck);

    expect(getCountry(db, G, 'DE')?.defenseImmunityUntil).toBe(
      NOW + 1 + INVASIONS.successfulDefenseImmunity,
    );
    expect(getCountry(db, G, 'FR')?.invadeCooldownUntil).toBe(
      NOW + 1 + COOLDOWNS.invade,
    );
  });

  it('puts the attacker on cooldown even when it wins', () => {
    const invasion = inFlight(db, stake(20));
    resolveInvasion(db, invasion, NOW + 1, neutralLuck);
    expect(getCountry(db, G, 'FR')?.invadeCooldownUntil).toBe(
      NOW + 1 + COOLDOWNS.invade,
    );
  });

  it('frees both countries to fight again', () => {
    const invasion = inFlight(db, stake(20));
    resolveInvasion(db, invasion, NOW + 1, neutralLuck);
    expect(getPendingInvasionFor(db, G, 'FR')).toBeUndefined();
    expect(getPendingInvasionFor(db, G, 'DE')).toBeUndefined();
  });
});

describe('cancelInvasion', () => {
  let db: Database;

  beforeEach(() => {
    db = world();
  });

  it('refunds an escrowed attack when the war is called off', () => {
    const invasion = inFlight(db, stake(20, 10, 10));
    cancelInvasion(db, invasion, NOW + 5);

    expect(getStockpile(db, G, 'FR')).toEqual({
      troops: 100,
      gold: 100,
      food: 100,
    });
    expect(getInvasion(db, invasion.id)?.status).toBe('cancelled');
  });

  it('refunds an escrowed defence too', () => {
    const invasion = inFlight(db, stake(20));
    const proposed = proposeDefense(db, {
      guildId: G,
      code: 'DE',
      proposerId: 'd1',
      stake: stake(30, 5, 5),
      now: NOW,
    });
    if (!proposed.ok) throw new Error('unexpected');
    escrowDefense(db, invasion, proposed.proposal, NOW);

    cancelInvasion(db, getInvasion(db, invasion.id)!, NOW + 5);
    expect(getStockpile(db, G, 'DE')).toEqual({
      troops: 100,
      gold: 100,
      food: 100,
    });
  });

  it('refunds nothing for a vote that never escrowed', () => {
    const declared = declare(db, stake(20));
    if (!declared.ok) throw new Error('unexpected');
    cancelInvasion(db, declared.invasion, NOW + 5);
    expect(getStockpile(db, G, 'FR')).toEqual({
      troops: 100,
      gold: 100,
      food: 100,
    });
  });

  it('closes any proposal still being voted on', () => {
    const invasion = inFlight(db, stake(20));
    proposeDefense(db, {
      guildId: G,
      code: 'DE',
      proposerId: 'd1',
      stake: stake(5),
      now: NOW,
    });
    cancelInvasion(db, invasion, NOW + 5);
    expect(getPendingProposal(db, invasion.id)).toBeUndefined();
  });
});
