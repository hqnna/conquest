import {describe, expect, it} from 'vitest';
import type {CountryState} from '../src/db/countries.js';
import type {PlayerState} from '../src/db/players.js';
import {decideJoin, decideLeave, joinableCodes} from '../src/game/policy.js';

const NOW = 1_700_000_000_000;

function country(overrides: Partial<CountryState> = {}): CountryState {
  return {
    guildId: 'g1',
    code: 'FR',
    name: 'France',
    status: 'active',
    ownerCode: null,
    channelId: 'chan',
    roleId: 'role',
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

function player(overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    guildId: 'g1',
    userId: 'u1',
    countryCode: null,
    joinedAt: null,
    rejoinCooldownUntil: null,
    ...overrides,
  };
}

const base = {
  configured: true,
  known: true,
  country: undefined,
  player: undefined,
  slotsRemaining: 10,
  now: NOW,
};

describe('decideJoin', () => {
  it('activates a country nobody has founded', () => {
    expect(decideJoin(base)).toEqual({ok: true, activates: true});
  });

  it('joins an active country without activating anything', () => {
    expect(decideJoin({...base, country: country()})).toEqual({
      ok: true,
      activates: false,
    });
  });

  it('activates a country that was disbanded', () => {
    expect(
      decideJoin({...base, country: country({status: 'inactive'})}),
    ).toEqual({ok: true, activates: true});
  });

  it('refuses before setup', () => {
    expect(decideJoin({...base, configured: false})).toEqual({
      ok: false,
      refusal: {kind: 'not_configured'},
    });
  });

  it('refuses a country that does not exist', () => {
    expect(decideJoin({...base, known: false})).toEqual({
      ok: false,
      refusal: {kind: 'unknown_country'},
    });
  });

  it('refuses a player who already has a country', () => {
    expect(decideJoin({...base, player: player({countryCode: 'DE'})})).toEqual({
      ok: false,
      refusal: {kind: 'already_joined', code: 'DE'},
    });
  });

  it('refuses while the rejoin cooldown is running', () => {
    expect(
      decideJoin({
        ...base,
        player: player({rejoinCooldownUntil: NOW + 1_000}),
      }),
    ).toEqual({
      ok: false,
      refusal: {kind: 'rejoin_cooldown', until: NOW + 1_000},
    });
  });

  it('allows a join the moment the cooldown expires', () => {
    expect(
      decideJoin({...base, player: player({rejoinCooldownUntil: NOW})}),
    ).toEqual({ok: true, activates: true});
  });

  it('refuses a conquered country and names its owner', () => {
    expect(
      decideJoin({
        ...base,
        country: country({status: 'defeated', ownerCode: 'DE'}),
      }),
    ).toEqual({ok: false, refusal: {kind: 'defeated', ownerCode: 'DE'}});
  });

  it('refuses to found a country when the category is full', () => {
    expect(decideJoin({...base, slotsRemaining: 0})).toEqual({
      ok: false,
      refusal: {kind: 'at_capacity'},
    });
  });

  it('still lets players join existing countries at capacity', () => {
    expect(
      decideJoin({...base, country: country(), slotsRemaining: 0}),
    ).toEqual({ok: true, activates: false});
  });

  it('checks membership before the cooldown, so the advice fits', () => {
    const decision = decideJoin({
      ...base,
      player: player({countryCode: 'DE', rejoinCooldownUntil: NOW + 1_000}),
    });
    expect(decision).toEqual({
      ok: false,
      refusal: {kind: 'already_joined', code: 'DE'},
    });
  });
});

describe('decideLeave', () => {
  it('refuses a player who is in no country', () => {
    expect(decideLeave({player: undefined, memberCount: 0})).toEqual({
      ok: false,
      refusal: {kind: 'not_in_country'},
    });
    expect(decideLeave({player: player(), memberCount: 0})).toEqual({
      ok: false,
      refusal: {kind: 'not_in_country'},
    });
  });

  it('disbands the country when the last player leaves', () => {
    expect(
      decideLeave({player: player({countryCode: 'FR'}), memberCount: 1}),
    ).toEqual({ok: true, code: 'FR', deactivates: true});
  });

  it('leaves the country standing when others remain', () => {
    expect(
      decideLeave({player: player({countryCode: 'FR'}), memberCount: 3}),
    ).toEqual({ok: true, code: 'FR', deactivates: false});
  });
});

describe('joinableCodes', () => {
  const all = ['FR', 'DE', 'BE', 'NL'];

  it('offers untouched and active countries', () => {
    const joinable = joinableCodes([country({code: 'FR'})], all, 10);
    expect([...joinable].sort()).toEqual(['BE', 'DE', 'FR', 'NL']);
  });

  it('never offers a conquered country', () => {
    const joinable = joinableCodes(
      [country({code: 'DE', status: 'defeated', ownerCode: 'FR'})],
      all,
      10,
    );
    expect(joinable.has('DE')).toBe(false);
  });

  it('stops offering unfounded countries at capacity', () => {
    const joinable = joinableCodes([country({code: 'FR'})], all, 0);
    expect([...joinable]).toEqual(['FR']);
  });

  it('offers them again once a slot frees up', () => {
    const joinable = joinableCodes([country({code: 'FR'})], all, 1);
    expect(joinable.has('BE')).toBe(true);
  });

  it('treats a disbanded country as joinable again', () => {
    const joinable = joinableCodes(
      [country({code: 'FR', status: 'inactive'})],
      all,
      10,
    );
    expect(joinable.has('FR')).toBe(true);
  });
});
