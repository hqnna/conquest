import {beforeEach, describe, expect, it} from 'vitest';
import type {Database} from 'better-sqlite3';
import {INVASIONS, MERGES} from '../src/config/constants.js';
import {
  activateCountry,
  getCountry,
  listTerritories,
  territoryCounts,
} from '../src/db/countries.js';
import type {CountryState} from '../src/db/countries.js';
import {upsertGuildConfig} from '../src/db/guild-config.js';
import {openTestDatabase} from '../src/db/index.js';
import {getMerge, getPendingMergeFor} from '../src/db/merges.js';
import type {Merge} from '../src/db/merges.js';
import {getPlayer, joinCountry} from '../src/db/players.js';
import {addResources, getStockpile} from '../src/db/resources.js';
import {declareInvasion, escrowAndOpenDefense} from '../src/game/invasions.js';
import {
  beginAcceptVote,
  completeMerge,
  decideMerge,
  proposeMerge,
} from '../src/game/merges.js';
import {checkVictory} from '../src/game/victory.js';

const NOW = 1_700_000_000_000;
const G = 'g1';

/** Three grown countries with stockpiles, none of them protected. */
function world(): Database {
  const db = openTestDatabase();
  upsertGuildConfig(db, {guildId: G, categoryId: 'cat', logChannelId: 'log'});
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
    addResources(db, G, code, {troops: 30, gold: 20, food: 10});
  }
  joinCountry(db, {guildId: G, userId: 'f1', code: 'FR', now: NOW});
  joinCountry(db, {guildId: G, userId: 'f2', code: 'FR', now: NOW});
  joinCountry(db, {guildId: G, userId: 'd1', code: 'DE', now: NOW});
  return db;
}

function country(db: Database, code: string): CountryState {
  return getCountry(db, G, code)!;
}

function propose(db: Database, fromCode = 'FR', intoCode = 'DE') {
  return proposeMerge(db, {
    guildId: G,
    fromCode,
    intoCode,
    proposerId: 'f1',
    now: NOW,
  });
}

/** An offer both countries have approved, ready to be made. */
function agreed(db: Database, fromCode = 'FR', intoCode = 'DE'): Merge {
  const proposed = propose(db, fromCode, intoCode);
  if (!proposed.ok) throw new Error('offer refused');
  beginAcceptVote(db, proposed.merge, NOW);
  return getMerge(db, proposed.merge.id)!;
}

describe('decideMerge', () => {
  const base = {
    configured: true,
    intoKnown: true,
    fromPendingInvasion: false,
    intoPendingInvasion: false,
    fromPendingMerge: undefined,
    intoPendingMerge: undefined,
  };
  const active = (code: string) =>
    ({code, status: 'active', ownerCode: null}) as CountryState;

  it('allows a merge between two active countries', () => {
    expect(
      decideMerge({...base, from: active('FR'), into: active('DE')}),
    ).toEqual({ok: true});
  });

  it('refuses when the guild was never set up', () => {
    const decision = decideMerge({
      ...base,
      configured: false,
      from: active('FR'),
      into: active('DE'),
    });
    expect(decision).toEqual({ok: false, refusal: {kind: 'not_configured'}});
  });

  it('refuses a player with no country of their own', () => {
    expect(
      decideMerge({...base, from: undefined, into: active('DE')}),
    ).toMatchObject({refusal: {kind: 'not_in_country'}});
  });

  it('refuses a country that is not in the world data', () => {
    expect(
      decideMerge({
        ...base,
        from: active('FR'),
        into: undefined,
        intoKnown: false,
      }),
    ).toMatchObject({refusal: {kind: 'unknown_country'}});
  });

  it('refuses merging with yourself', () => {
    expect(
      decideMerge({...base, from: active('FR'), into: active('FR')}),
    ).toMatchObject({refusal: {kind: 'self'}});
  });

  it('refuses a target nobody holds, and one that has already fallen', () => {
    expect(
      decideMerge({...base, from: active('FR'), into: undefined}),
    ).toMatchObject({refusal: {kind: 'target_inactive'}});
    expect(
      decideMerge({
        ...base,
        from: active('FR'),
        into: {
          code: 'DE',
          status: 'defeated',
          ownerCode: 'BE',
        } as CountryState,
      }),
    ).toMatchObject({refusal: {kind: 'target_defeated', ownerCode: 'BE'}});
  });

  it('refuses while either country is at war', () => {
    expect(
      decideMerge({
        ...base,
        from: active('FR'),
        into: active('DE'),
        fromPendingInvasion: true,
      }),
    ).toMatchObject({refusal: {kind: 'at_war'}});
    expect(
      decideMerge({
        ...base,
        from: active('FR'),
        into: active('DE'),
        intoPendingInvasion: true,
      }),
    ).toMatchObject({refusal: {kind: 'target_at_war'}});
  });

  it('refuses a second offer while one is still on the table', () => {
    const pending = {id: 7} as Merge;
    expect(
      decideMerge({
        ...base,
        from: active('FR'),
        into: active('DE'),
        fromPendingMerge: pending,
      }),
    ).toMatchObject({refusal: {kind: 'merge_pending', mergeId: 7}});
    expect(
      decideMerge({
        ...base,
        from: active('FR'),
        into: active('DE'),
        intoPendingMerge: pending,
      }),
    ).toMatchObject({refusal: {kind: 'target_merge_pending', mergeId: 7}});
  });
});

describe('proposeMerge', () => {
  let db: Database;
  beforeEach(() => {
    db = world();
  });

  it('opens an offer vote in the offering country', () => {
    const proposed = propose(db);
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    expect(proposed.merge).toMatchObject({
      fromCode: 'FR',
      intoCode: 'DE',
      proposerId: 'f1',
      status: 'offer_vote',
      offerDeadline: NOW + MERGES.voteWindow,
    });
    expect(getPendingMergeFor(db, G, 'DE')?.id).toBe(proposed.merge.id);
  });

  it('moves nothing until both countries have voted', () => {
    propose(db);
    expect(getStockpile(db, G, 'FR')).toEqual({troops: 30, gold: 20, food: 10});
    expect(getPlayer(db, G, 'f1')?.countryCode).toBe('FR');
    expect(country(db, 'FR').status).toBe('active');
  });

  it('refuses a second offer from the same country', () => {
    propose(db);
    expect(propose(db, 'FR', 'BE')).toMatchObject({
      ok: false,
      refusal: {kind: 'merge_pending'},
    });
  });

  it('refuses an offer from a country at war', () => {
    const declared = declareInvasion(db, {
      guildId: G,
      attackerCode: 'FR',
      defenderCode: 'BE',
      stake: {troops: 5, gold: 0, food: 0},
      now: NOW,
    });
    expect(declared.ok).toBe(true);
    expect(propose(db)).toMatchObject({ok: false, refusal: {kind: 'at_war'}});
  });
});

describe('completeMerge', () => {
  let db: Database;
  beforeEach(() => {
    db = world();
  });

  it('hands over the stockpile, the people, and the land', () => {
    // Belgium is already French territory, so it must change hands too.
    db.prepare(
      "UPDATE countries SET status = 'defeated', owner_code = 'FR' WHERE guild_id = ? AND code = 'BE'",
    ).run(G);

    const merge = agreed(db);
    const result = completeMerge(db, merge, NOW + 10);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(getStockpile(db, G, 'DE')).toEqual({
      troops: 60,
      gold: 40,
      food: 20,
    });
    expect(getStockpile(db, G, 'FR')).toEqual({troops: 0, gold: 0, food: 0});
    expect(result.report.stockpile).toEqual({troops: 30, gold: 20, food: 10});

    expect(result.report.transferredPlayers.sort()).toEqual(['f1', 'f2']);
    expect(getPlayer(db, G, 'f1')?.countryCode).toBe('DE');
    expect(getPlayer(db, G, 'f2')?.countryCode).toBe('DE');

    expect(country(db, 'FR')).toMatchObject({
      status: 'defeated',
      ownerCode: 'DE',
      roleId: null,
    });
    expect(
      listTerritories(db, G, 'DE')
        .map(t => t.code)
        .sort(),
    ).toEqual(['BE', 'FR']);
    expect(result.report.capturedTerritories.map(t => t.code).sort()).toEqual([
      'BE',
      'FR',
    ]);
    expect(territoryCounts(db, G).get('DE')).toBe(3);
    expect(getMerge(db, merge.id)).toMatchObject({
      status: 'completed',
      resolvedAt: NOW + 10,
    });
  });

  it('reports the roles and channels Discord must now move', () => {
    const merge = agreed(db);
    const result = completeMerge(db, merge, NOW + 10);
    if (!result.ok) throw new Error('merge refused');
    expect(result.report).toMatchObject({
      absorbedRoleId: 'role-FR',
      absorbedChannelId: 'chan-FR',
      absorberRoleId: 'role-DE',
    });
    // The archive is kept; only the role is forgotten.
    expect(country(db, 'FR').channelId).toBe('chan-FR');
  });

  it('voids the absorbing country’s new-country protection', () => {
    db.prepare(
      'UPDATE countries SET protected_until = ? WHERE guild_id = ? AND code = ?',
    ).run(NOW + INVASIONS.newCountryProtection, G, 'DE');

    const result = completeMerge(db, agreed(db), NOW + 10);
    expect(result.ok).toBe(true);
    expect(country(db, 'DE').protectedUntil).toBeNull();
  });

  it('is called off the moment a war starts, and says so', () => {
    const merge = agreed(db);
    const declared = declareInvasion(db, {
      guildId: G,
      attackerCode: 'BE',
      defenderCode: 'FR',
      stake: {troops: 5, gold: 0, food: 0},
      now: NOW,
    });
    if (!declared.ok) throw new Error('declaration refused');

    const escrow = escrowAndOpenDefense(db, declared.invasion, NOW + 1);
    expect(escrow.ok).toBe(true);
    if (!escrow.ok) return;
    expect(escrow.cancelledMerges.map(m => m.id)).toEqual([merge.id]);
    expect(getMerge(db, merge.id)?.status).toBe('cancelled');
  });

  it('calls the merge off if either country went to war meanwhile', () => {
    const merge = agreed(db);
    const declared = declareInvasion(db, {
      guildId: G,
      attackerCode: 'BE',
      defenderCode: 'DE',
      stake: {troops: 5, gold: 0, food: 0},
      now: NOW,
    });
    if (!declared.ok) throw new Error('declaration refused');
    escrowAndOpenDefense(db, declared.invasion, NOW);

    const result = completeMerge(db, merge, NOW + 10);
    expect(result).toMatchObject({
      ok: false,
      failure: {kind: 'at_war', code: 'DE'},
    });
    expect(getMerge(db, merge.id)?.status).toBe('cancelled');
    expect(country(db, 'FR').status).toBe('active');
    expect(getPlayer(db, G, 'f1')?.countryCode).toBe('FR');
  });

  it('calls the merge off if a country stopped standing meanwhile', () => {
    const merge = agreed(db);
    db.prepare(
      "UPDATE countries SET status = 'inactive' WHERE guild_id = ? AND code = 'FR'",
    ).run(G);

    expect(completeMerge(db, merge, NOW + 10)).toMatchObject({
      ok: false,
      failure: {kind: 'gone', code: 'FR'},
    });
    expect(getMerge(db, merge.id)?.status).toBe('cancelled');
  });

  it('can win the round, because a country given away is still taken', () => {
    db.prepare("DELETE FROM countries WHERE guild_id = ? AND code = 'BE'").run(
      G,
    );
    expect(checkVictory(db, G, NOW)).toBeUndefined();

    completeMerge(db, agreed(db), NOW + 10);

    expect(checkVictory(db, G, NOW + 10)).toMatchObject({
      code: 'DE',
      territories: 2,
    });
  });
});
