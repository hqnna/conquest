import {beforeEach, describe, expect, it} from 'vitest';
import type {Database} from 'better-sqlite3';
import {COOLDOWNS, INVASIONS, WAR} from '../src/config/constants.js';
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
  canAfford,
  cancelInvasion,
  concludeWar,
  declareInvasion,
  escrowAndOpenDefense,
  escrowDefense,
  escrowReinforcement,
  fightWarRound,
  proposeDefense,
  proposeReinforcement,
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

  it('allows only one war against the same target at a time', () => {
    const first = declare(db);
    expect(first.ok).toBe(true);

    expect(declare(db)).toEqual({
      ok: false,
      refusal: {
        kind: 'already_invading',
        invasionId: first.ok ? first.invasion.id : 0,
      },
    });
  });

  it('lets a second country pile on the same target', () => {
    declare(db);
    expect(
      declareInvasion(db, {
        guildId: G,
        attackerCode: 'BE',
        defenderCode: 'DE',
        stake: stake(5),
        now: NOW,
      }).ok,
    ).toBe(true);
  });

  it('lets a third country strike an invader mid-war, which is the point', () => {
    // France marches on Germany; Belgium comes to Germany's aid by opening a
    // second front against France.
    declare(db);
    expect(
      declareInvasion(db, {
        guildId: G,
        attackerCode: 'BE',
        defenderCode: 'FR',
        stake: stake(5),
        now: NOW,
      }).ok,
    ).toBe(true);
  });

  it('lets the invaded country march back on its invader', () => {
    declare(db);
    expect(
      declareInvasion(db, {
        guildId: G,
        attackerCode: 'DE',
        defenderCode: 'FR',
        stake: stake(5),
        now: NOW,
      }).ok,
    ).toBe(true);
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
      invasionId: invasion.id,
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
      invasionId: invasion.id,
      proposerId: 'u1',
      stake: stake(5),
      now: late,
    });
    expect(result.ok && result.proposal.voteDeadline).toBe(
      invasion.defenseDeadline,
    );
  });

  it('refuses a country that is not the defender in that war', () => {
    const invasion = inFlight(db);
    expect(
      proposeDefense(db, {
        guildId: G,
        code: 'BE',
        invasionId: invasion.id,
        proposerId: 'u1',
        stake: stake(5),
        now: NOW,
      }),
    ).toEqual({ok: false, refusal: {kind: 'not_under_attack'}});
  });

  it('refuses the attacker proposing a defence of the country it is invading', () => {
    const invasion = inFlight(db);
    expect(
      proposeDefense(db, {
        guildId: G,
        code: 'FR',
        invasionId: invasion.id,
        proposerId: 'u1',
        stake: stake(5),
        now: NOW,
      }),
    ).toEqual({ok: false, refusal: {kind: 'not_under_attack'}});
  });

  it('allows only one pending proposal per war', () => {
    const invasion = inFlight(db);
    proposeDefense(db, {
      guildId: G,
      code: 'DE',
      invasionId: invasion.id,
      proposerId: 'u1',
      stake: stake(5),
      now: NOW,
    });
    const second = proposeDefense(db, {
      guildId: G,
      code: 'DE',
      invasionId: invasion.id,
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
      invasionId: invasion.id,
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
        "UPDATE stake_proposals SET status = 'rejected' WHERE id = ?",
      ).run(first.proposal.id);
    }

    const second = proposeDefense(db, {
      guildId: G,
      code: 'DE',
      invasionId: invasion.id,
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
    const invasion = inFlight(db);
    const result = proposeDefense(db, {
      guildId: G,
      code: 'DE',
      invasionId: invasion.id,
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
      invasionId: invasion.id,
      proposerId: 'u1',
      stake: stake(5),
      now: NOW,
    });
    if (!proposed.ok) throw new Error('unexpected');
    escrowDefense(db, invasion, proposed.proposal, NOW);

    const again = proposeDefense(db, {
      guildId: G,
      code: 'DE',
      invasionId: invasion.id,
      proposerId: 'u2',
      stake: stake(5),
      now: NOW + 1,
    });
    expect(again).toEqual({ok: false, refusal: {kind: 'already_defended'}});
  });
});

/** Declares, escrows, and gets the defence approved: a war under way. */
function atWar(db: Database, attack = stake(40), defense = stake(30)) {
  const invasion = inFlight(db, attack);
  const proposed = proposeDefense(db, {
    guildId: G,
    code: 'DE',
    invasionId: invasion.id,
    proposerId: 'd1',
    stake: defense,
    now: NOW,
  });
  if (!proposed.ok) throw new Error('defence refused');
  const escrow = escrowDefense(db, invasion, proposed.proposal, NOW);
  if (!escrow.ok) throw new Error('defence escrow refused');
  return getInvasion(db, invasion.id)!;
}

describe('escrowDefense', () => {
  let db: Database;

  beforeEach(() => {
    db = world();
  });

  it('escrows the defence and puts it in the field', () => {
    const invasion = atWar(db, stake(40), stake(30, 5, 5));
    expect(getStockpile(db, G, 'DE')).toEqual({
      troops: 70,
      gold: 95,
      food: 95,
    });
    expect(invasion.defense).toEqual(stake(30, 5, 5));
    expect(invasion.defenseField).toEqual(stake(30, 5, 5));
  });

  it('starts the fighting', () => {
    const invasion = atWar(db);
    expect(invasion.status).toBe('war');
    expect(invasion.nextTickAt).toBe(NOW + WAR.tickInterval);
    expect(invasion.rounds).toBe(0);
  });
});

describe('fightWarRound', () => {
  let db: Database;

  beforeEach(() => {
    db = world();
  });

  const evenLuck = () => 0.5;

  it('wears both sides down and schedules the next round', () => {
    const invasion = atWar(db, stake(40), stake(30));
    const report = fightWarRound(
      db,
      invasion,
      NOW + WAR.tickInterval,
      evenLuck,
    );

    expect(report.invasion.attackField.troops).toBeLessThan(40);
    expect(report.invasion.defenseField.troops).toBeLessThan(30);
    expect(report.invasion.rounds).toBe(1);
    expect(report.invasion.nextTickAt).toBe(NOW + WAR.tickInterval * 2);
  });

  it('never touches the home stockpiles', () => {
    const invasion = atWar(db, stake(40), stake(30));
    fightWarRound(db, invasion, NOW + WAR.tickInterval, evenLuck);
    expect(getStockpile(db, G, 'FR')?.troops).toBe(60);
    expect(getStockpile(db, G, 'DE')?.troops).toBe(70);
  });

  it('calls on the side whose force is spent', () => {
    const invasion = atWar(db, stake(1), stake(90));
    const report = fightWarRound(
      db,
      invasion,
      NOW + WAR.tickInterval,
      evenLuck,
    );

    expect(report.spentSide).toBe('attacker');
    expect(report.invasion.status).toBe('reinforcing');
    expect(report.invasion.reinforcingSide).toBe('attacker');
    expect(report.invasion.reinforceDeadline).toBe(
      NOW + WAR.tickInterval + WAR.reinforcementWindow,
    );
    expect(report.invasion.nextTickAt).toBeNull();
  });

  it('asks the attacker first when both are spent at once', () => {
    const invasion = atWar(db, stake(1), stake(1));
    const report = fightWarRound(
      db,
      invasion,
      NOW + WAR.tickInterval,
      evenLuck,
    );
    expect(report.tick.attackerSpent && report.tick.defenderSpent).toBe(true);
    expect(report.spentSide).toBe('attacker');
  });

  it('reports a country that has been fought completely dry', () => {
    const invasion = atWar(db, stake(1), stake(90));
    db.prepare(
      "UPDATE countries SET troops = 0, gold = 0, food = 0 WHERE code = 'FR'",
    ).run();

    const report = fightWarRound(
      db,
      invasion,
      NOW + WAR.tickInterval,
      evenLuck,
    );
    expect(report.spentSide).toBe('attacker');
    expect(report.exhausted).toBe(true);
  });

  it('does not call a country exhausted while it has anything left', () => {
    const invasion = atWar(db, stake(1), stake(90));
    db.prepare(
      "UPDATE countries SET troops = 0, gold = 1, food = 0 WHERE code = 'FR'",
    ).run();

    const report = fightWarRound(
      db,
      invasion,
      NOW + WAR.tickInterval,
      evenLuck,
    );
    expect(report.exhausted).toBe(false);
  });
});

describe('reinforcements', () => {
  let db: Database;

  beforeEach(() => {
    db = world();
  });

  const evenLuck = () => 0.5;

  /** Fights until one side is asked to reinforce. */
  function untilSpent(
    db2: Database,
    invasion = atWar(db2, stake(1), stake(90)),
  ) {
    return fightWarRound(db2, invasion, NOW + WAR.tickInterval, evenLuck)
      .invasion;
  }

  it('only the side being asked may propose', () => {
    const spent = untilSpent(db);
    expect(
      proposeReinforcement(db, {
        guildId: G,
        code: 'DE',
        invasionId: spent.id,
        proposerId: 'd1',
        stake: stake(5),
        now: NOW,
      }),
    ).toEqual({ok: false, refusal: {kind: 'not_under_attack'}});

    expect(
      proposeReinforcement(db, {
        guildId: G,
        code: 'FR',
        invasionId: spent.id,
        proposerId: 'a1',
        stake: stake(5),
        now: NOW,
      }).ok,
    ).toBe(true);
    expect(spent.reinforcingSide).toBe('attacker');
  });

  it('cannot be proposed while the fighting is going normally', () => {
    const fighting = atWar(db, stake(40), stake(30));
    expect(
      proposeReinforcement(db, {
        guildId: G,
        code: 'FR',
        invasionId: fighting.id,
        proposerId: 'a1',
        stake: stake(5),
        now: NOW,
      }),
    ).toEqual({ok: false, refusal: {kind: 'not_under_attack'}});
  });

  it('adds to the field and to the running total, and resumes the war', () => {
    const spent = untilSpent(db);
    const proposed = proposeReinforcement(db, {
      guildId: G,
      code: 'FR',
      invasionId: spent.id,
      proposerId: 'a1',
      stake: stake(25, 5, 5),
      now: NOW,
    });
    if (!proposed.ok) throw new Error('unexpected');

    const escrow = escrowReinforcement(db, spent, proposed.proposal, NOW + 10);
    expect(escrow.ok).toBe(true);

    const after = getInvasion(db, spent.id)!;
    expect(after.status).toBe('war');
    expect(after.reinforcingSide).toBeNull();
    expect(after.attackField.troops).toBe(25);
    // The original one troop plus the twenty-five sent after it.
    expect(after.attack.troops).toBe(26);
    expect(after.nextTickAt).toBe(NOW + 10 + WAR.tickInterval);
  });

  it('pulls the reinforcement out of the home stockpile', () => {
    const spent = untilSpent(db);
    const proposed = proposeReinforcement(db, {
      guildId: G,
      code: 'FR',
      invasionId: spent.id,
      proposerId: 'a1',
      stake: stake(25, 5, 5),
      now: NOW,
    });
    if (!proposed.ok) throw new Error('unexpected');
    escrowReinforcement(db, spent, proposed.proposal, NOW + 10);

    // 100 less the single troop staked, less the twenty-five sent.
    expect(getStockpile(db, G, 'FR')).toEqual({
      troops: 74,
      gold: 95,
      food: 95,
    });
  });

  it('refuses a reinforcement the country cannot afford', () => {
    const spent = untilSpent(db);
    expect(spent.status).toBe('reinforcing');
    const result = proposeReinforcement(db, {
      guildId: G,
      code: 'FR',
      invasionId: spent.id,
      proposerId: 'a1',
      stake: stake(9_000),
      now: NOW,
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.refusal.kind).toBe('cannot_afford');
  });
});

describe('concludeWar', () => {
  let db: Database;

  beforeEach(() => {
    db = world();
    joinCountry(db, {guildId: G, userId: 'a1', code: 'FR', now: NOW});
    joinCountry(db, {guildId: G, userId: 'd1', code: 'DE', now: NOW});
    joinCountry(db, {guildId: G, userId: 'd2', code: 'DE', now: NOW});
  });

  describe('when the attacker gives up', () => {
    it('marches what is left of its army home', () => {
      const invasion = atWar(db, stake(40, 10, 10), stake(30));
      concludeWar(db, invasion, 'defender', 'surrender', NOW + 1);

      // Nothing was fought yet, so the whole field force comes back.
      expect(getStockpile(db, G, 'FR')).toEqual({
        troops: 100,
        gold: 100,
        food: 100,
      });
    });

    it('gives the defender its own survivors back, and nothing more', () => {
      const invasion = atWar(db, stake(40, 10, 10), stake(30, 5, 5));
      concludeWar(db, invasion, 'defender', 'surrender', NOW + 1);

      expect(getStockpile(db, G, 'DE')).toEqual({
        troops: 100,
        gold: 100,
        food: 100,
      });
    });

    it('leaves the defending country standing, with its people', () => {
      const invasion = atWar(db);
      concludeWar(db, invasion, 'defender', 'surrender', NOW + 1);

      expect(getCountry(db, G, 'DE')?.status).toBe('active');
      expect(listCountryMembers(db, G, 'DE').sort()).toEqual(['d1', 'd2']);
    });

    it('grants immunity to the defender and a cooldown to the attacker', () => {
      const invasion = atWar(db);
      concludeWar(db, invasion, 'defender', 'surrender', NOW + 1);

      expect(getCountry(db, G, 'DE')?.defenseImmunityUntil).toBe(
        NOW + 1 + INVASIONS.successfulDefenseImmunity,
      );
      expect(getCountry(db, G, 'FR')?.invadeCooldownUntil).toBe(
        NOW + 1 + COOLDOWNS.invade,
      );
    });
  });

  describe('when the defender gives up', () => {
    it('absorbs whatever the defender still had in the field', () => {
      const invasion = atWar(db, stake(40), stake(30, 5, 5));
      const report = concludeWar(
        db,
        invasion,
        'attacker',
        'surrender',
        NOW + 1,
      );

      expect(report.captured).toEqual(stake(30, 5, 5));
      // 60 left at home, 40 marching home, 30 captured from the field, and
      // the 70 the defender had not committed.
      expect(getStockpile(db, G, 'FR')?.troops).toBe(60 + 40 + 30 + 70);
    });

    it('loots everything the defeated country had at home', () => {
      const invasion = atWar(db, stake(40), stake(30));
      const report = concludeWar(
        db,
        invasion,
        'attacker',
        'surrender',
        NOW + 1,
      );

      expect(report.loot).toEqual({troops: 70, gold: 100, food: 100});
      expect(getStockpile(db, G, 'DE')).toEqual({
        troops: 0,
        gold: 0,
        food: 0,
      });
    });

    it('absorbs its players and its territory', () => {
      db.prepare(
        "UPDATE countries SET status = 'defeated', owner_code = 'DE' WHERE code = 'BE'",
      ).run();
      const invasion = atWar(db);
      const report = concludeWar(
        db,
        invasion,
        'attacker',
        'surrender',
        NOW + 1,
      );

      expect(report.transferredPlayers.sort()).toEqual(['d1', 'd2']);
      expect(listCountryMembers(db, G, 'FR').sort()).toEqual([
        'a1',
        'd1',
        'd2',
      ]);
      expect(report.capturedTerritories.map(t => t.code).sort()).toEqual([
        'BE',
        'DE',
      ]);
      expect(getCountry(db, G, 'BE')?.ownerCode).toBe('FR');
      expect(getCountry(db, G, 'DE')).toMatchObject({
        status: 'defeated',
        ownerCode: 'FR',
        roleId: null,
      });
    });

    it('hands back what the conquest has to tidy up in Discord', () => {
      const invasion = atWar(db);
      const report = concludeWar(
        db,
        invasion,
        'attacker',
        'surrender',
        NOW + 1,
      );
      expect(report.defeatedChannelId).toBe('chan-DE');
      expect(report.defeatedRoleId).toBe('role-DE');
      expect(report.winnerRoleId).toBe('role-FR');
    });
  });

  it('absorbs a country that never answered, with the army untouched', () => {
    const invasion = inFlight(db, stake(40, 10, 10));
    const report = concludeWar(db, invasion, 'attacker', 'unanswered', NOW + 1);

    expect(report.attackerReturns).toEqual(stake(40, 10, 10));
    // The whole stake comes home: nothing was ever fought.
    expect(getStockpile(db, G, 'FR')).toEqual({
      troops: 100 + 100,
      gold: 100 + 100,
      food: 100 + 100,
    });
    expect(getCountry(db, G, 'DE')?.status).toBe('defeated');
  });

  it('frees both countries to fight again', () => {
    const invasion = atWar(db);
    concludeWar(db, invasion, 'attacker', 'surrender', NOW + 1);
    expect(getPendingInvasionFor(db, G, 'FR')).toBeUndefined();
    expect(getPendingInvasionFor(db, G, 'DE')).toBeUndefined();
  });
});

describe('cancelInvasion', () => {
  let db: Database;

  beforeEach(() => {
    db = world();
  });

  it('sends both field forces home when the war is called off', () => {
    const invasion = atWar(db, stake(20, 10, 10), stake(30, 5, 5));
    cancelInvasion(db, invasion, NOW + 5);

    expect(getStockpile(db, G, 'FR')).toEqual({
      troops: 100,
      gold: 100,
      food: 100,
    });
    expect(getStockpile(db, G, 'DE')).toEqual({
      troops: 100,
      gold: 100,
      food: 100,
    });
    expect(getInvasion(db, invasion.id)?.status).toBe('cancelled');
  });

  it('refunds nothing for a vote that never escrowed', () => {
    const result = declare(db, stake(20));
    if (!result.ok) throw new Error('unexpected');
    cancelInvasion(db, result.invasion, NOW + 5);
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
      invasionId: invasion.id,
      proposerId: 'd1',
      stake: stake(5),
      now: NOW,
    });
    cancelInvasion(db, invasion, NOW + 5);
    expect(getPendingProposal(db, invasion.id)).toBeUndefined();
  });
});

describe('a country that falls while fighting elsewhere', () => {
  let db: Database;

  beforeEach(() => {
    db = world();
    joinCountry(db, {guildId: G, userId: 'a1', code: 'FR', now: NOW});
    joinCountry(db, {guildId: G, userId: 'd1', code: 'DE', now: NOW});
    joinCountry(db, {guildId: G, userId: 'b1', code: 'BE', now: NOW});
  });

  /** Marches one country on another and escrows the stake. */
  function march(attacker: string, defender: string, troops: number) {
    const declared = declareInvasion(db, {
      guildId: G,
      attackerCode: attacker,
      defenderCode: defender,
      stake: stake(troops),
      now: NOW,
    });
    if (!declared.ok) throw new Error('declaration refused');
    const escrow = escrowAndOpenDefense(db, declared.invasion, NOW);
    if (!escrow.ok) throw new Error('escrow refused');
    return getInvasion(db, declared.invasion.id)!;
  }

  it('captures the army it had abroad, and gives its other enemy theirs back', () => {
    // France is invading Belgium with 30 when Germany invades France with 40.
    const abroad = march('FR', 'BE', 30);
    const athome = march('DE', 'FR', 40);

    const report = concludeWar(db, athome, 'attacker', 'surrender', NOW + 10);

    // The war France was fighting elsewhere ended with France.
    expect(report.cancelledWars.map(war => war.id)).toEqual([abroad.id]);
    expect(getInvasion(db, abroad.id)?.status).toBe('cancelled');

    // Germany took France's whole stockpile, the expedition included: France
    // had 100 troops, staked 30 abroad and 0 at home, and all of it is now
    // German — along with Germany's own 40 marching home.
    expect(getStockpile(db, G, 'DE')?.troops).toBe(60 + 40 + 100);
    expect(getStockpile(db, G, 'FR')).toEqual({troops: 0, gold: 0, food: 0});

    // Belgium was not beaten by anybody, so it simply has its own back.
    expect(getStockpile(db, G, 'BE')?.troops).toBe(100);
  });

  it('hands a defending third country its committed force back untouched', () => {
    const abroad = march('FR', 'BE', 30);
    const defence = proposeDefense(db, {
      guildId: G,
      code: 'BE',
      invasionId: abroad.id,
      proposerId: 'b1',
      stake: stake(25, 10, 10),
      now: NOW,
    });
    if (!defence.ok) throw new Error('defence refused');
    escrowDefense(db, abroad, defence.proposal, NOW);
    expect(getStockpile(db, G, 'BE')).toEqual({
      troops: 75,
      gold: 90,
      food: 90,
    });

    const athome = march('DE', 'FR', 40);
    concludeWar(db, athome, 'attacker', 'surrender', NOW + 10);

    // Belgium's defence comes home whole: it lost nothing to a war that was
    // called off over its head.
    expect(getStockpile(db, G, 'BE')).toEqual({
      troops: 100,
      gold: 100,
      food: 100,
    });
  });

  it('leaves the victor’s own other wars alone', () => {
    // Germany is invading both France and Belgium; France falls.
    const elsewhere = march('DE', 'BE', 20);
    const athome = march('DE', 'FR', 40);

    const report = concludeWar(db, athome, 'attacker', 'surrender', NOW + 10);

    expect(report.cancelledWars).toEqual([]);
    expect(getInvasion(db, elsewhere.id)?.status).toBe('defense_window');
  });
});
