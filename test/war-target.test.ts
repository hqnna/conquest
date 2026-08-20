import {beforeEach, describe, expect, it} from 'vitest';
import type {Database} from 'better-sqlite3';
import {INVASIONS} from '../src/config/constants.js';
import {activateCountry} from '../src/db/countries.js';
import {openTestDatabase} from '../src/db/index.js';
import {getInvasion} from '../src/db/invasions.js';
import type {Invasion} from '../src/db/invasions.js';
import {joinCountry} from '../src/db/players.js';
import {addResources} from '../src/db/resources.js';
import {
  chooseWar,
  enemyOf,
  warsAwaitingAnswer,
  warsToDefend,
} from '../src/commands/war-target.js';
import {
  declareInvasion,
  escrowAndOpenDefense,
  escrowDefense,
  fightWarRound,
  proposeDefense,
} from '../src/game/invasions.js';

const NOW = 1_700_000_000_000;
const G = 'g1';

function war(overrides: Partial<Invasion> = {}): Invasion {
  return {
    id: 1,
    guildId: G,
    attackerCode: 'FR',
    defenderCode: 'DE',
    attack: {troops: 10, gold: 0, food: 0},
    defense: null,
    attackField: {troops: 10, gold: 0, food: 0},
    defenseField: {troops: 0, gold: 0, food: 0},
    status: 'defense_window',
    attackVoteDeadline: NOW,
    defenseDeadline: NOW + 1000,
    nextTickAt: null,
    reinforcingSide: null,
    reinforceDeadline: null,
    rounds: 0,
    attackMessageId: null,
    createdAt: NOW,
    resolvedAt: null,
    ...overrides,
  };
}

describe('enemyOf', () => {
  it('names the other side, whichever one is asking', () => {
    expect(enemyOf('FR', war())).toBe('DE');
    expect(enemyOf('DE', war())).toBe('FR');
  });
});

describe('chooseWar', () => {
  it('refuses when the country is in no war the command applies to', () => {
    expect(chooseWar({code: 'DE', candidates: [], requested: null})).toEqual({
      ok: false,
      refusal: {kind: 'none'},
    });
  });

  it('needs no enemy named when only one war applies', () => {
    const only = war();
    expect(
      chooseWar({code: 'DE', candidates: [only], requested: null}),
    ).toEqual({ok: true, invasion: only});
  });

  it('refuses to guess between several, and lists them', () => {
    const wars = [war(), war({id: 2, attackerCode: 'BE'})];
    const choice = chooseWar({code: 'DE', candidates: wars, requested: null});
    expect(choice.ok).toBe(false);
    if (choice.ok) return;
    expect(choice.refusal.kind).toBe('ambiguous');
    expect(
      choice.refusal.kind === 'ambiguous' && choice.refusal.candidates,
    ).toHaveLength(2);
  });

  it('picks the war with the named enemy', () => {
    const belgium = war({id: 2, attackerCode: 'BE'});
    expect(
      chooseWar({
        code: 'DE',
        candidates: [war(), belgium],
        requested: 'BE',
      }),
    ).toEqual({ok: true, invasion: belgium});
  });

  it('refuses an enemy it is not fighting, naming the ones it is', () => {
    const choice = chooseWar({
      code: 'DE',
      candidates: [war()],
      requested: 'ES',
    });
    expect(choice.ok).toBe(false);
    if (choice.ok) return;
    expect(choice.refusal).toMatchObject({kind: 'unknown', requested: 'ES'});
  });
});

/** Three countries with armies, none of them protected. */
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
    db.prepare(
      'UPDATE countries SET protected_until = NULL WHERE guild_id = ? AND code = ?',
    ).run(G, code);
    addResources(db, G, code, {troops: 100, gold: 50, food: 50});
    joinCountry(db, {guildId: G, userId: `p-${code}`, code, now: NOW});
  }
  return db;
}

/** Marches `attacker` on `defender`, leaving the defence window open. */
function march(db: Database, attacker: string, defender: string): Invasion {
  const declared = declareInvasion(db, {
    guildId: G,
    attackerCode: attacker,
    defenderCode: defender,
    stake: {troops: 20, gold: 0, food: 0},
    now: NOW,
  });
  if (!declared.ok) throw new Error('declaration refused');
  const escrow = escrowAndOpenDefense(db, declared.invasion, NOW);
  if (!escrow.ok) throw new Error('escrow refused');
  return declared.invasion;
}

describe('the wars a command applies to', () => {
  let db: Database;
  beforeEach(() => {
    db = world();
  });

  it('offers every invasion still waiting for a defence', () => {
    march(db, 'FR', 'DE');
    march(db, 'BE', 'DE');
    expect(
      warsToDefend(db, G, 'DE').map(invasion => enemyOf('DE', invasion)),
    ).toEqual(['FR', 'BE']);
  });

  it('never offers a war to the country doing the invading', () => {
    march(db, 'FR', 'DE');
    expect(warsToDefend(db, G, 'FR')).toEqual([]);
  });

  it('prefers the war that can still be answered', () => {
    const first = march(db, 'FR', 'DE');
    const proposed = proposeDefense(db, {
      guildId: G,
      code: 'DE',
      invasionId: first.id,
      proposerId: 'p-DE',
      stake: {troops: 10, gold: 0, food: 0},
      now: NOW,
    });
    if (!proposed.ok) throw new Error('defence refused');
    escrowDefense(db, first, proposed.proposal, NOW);
    march(db, 'BE', 'DE');

    // The war with France is already being fought, so `/defend` with no enemy
    // named means the one Belgium just opened.
    expect(
      warsToDefend(db, G, 'DE').map(invasion => enemyOf('DE', invasion)),
    ).toEqual(['BE']);
  });

  it('offers only the war that is asking to be reinforced', () => {
    const attacked = march(db, 'FR', 'DE');
    const proposed = proposeDefense(db, {
      guildId: G,
      code: 'DE',
      invasionId: attacked.id,
      proposerId: 'p-DE',
      stake: {troops: 1, gold: 0, food: 0},
      now: NOW,
    });
    if (!proposed.ok) throw new Error('defence refused');
    escrowDefense(db, attacked, proposed.proposal, NOW);
    march(db, 'BE', 'DE');

    // One defending troop against twenty cannot survive a round, so Germany
    // is the side asked to reinforce — in that war only.
    const spent = fightWarRound(
      db,
      getInvasion(db, attacked.id)!,
      NOW + 1000,
      () => 0.5,
    ).invasion;
    expect(spent).toMatchObject({
      status: 'reinforcing',
      reinforcingSide: 'defender',
    });

    expect(
      warsAwaitingAnswer(db, G, 'DE').map(invasion => enemyOf('DE', invasion)),
    ).toEqual(['FR']);
    // The attacker is not the side being asked, so it is offered nothing.
    expect(warsAwaitingAnswer(db, G, 'FR')).toEqual([]);
  });
});
