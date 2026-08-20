import {describe, expect, it} from 'vitest';
import type {ContainerBuilder} from 'discord.js';
import {countryCard, warLine} from '../src/commands/country.js';
import {findCountry} from '../src/data/countries.js';
import type {CountryState} from '../src/db/countries.js';
import type {Invasion} from '../src/db/invasions.js';

const NOW = 1_700_000_000_000;
const FRANCE = findCountry('FR')!;

function state(overrides: Partial<CountryState> = {}): CountryState {
  return {
    guildId: 'g1',
    code: 'FR',
    name: 'France',
    status: 'active',
    ownerCode: null,
    channelId: 'chan',
    roleId: 'role',
    food: 12,
    gold: 34,
    troops: 56,
    activatedAt: NOW,
    protectedUntil: null,
    invadeCooldownUntil: null,
    defenseImmunityUntil: null,
    ...overrides,
  };
}

function textOf(container: ContainerBuilder): string {
  const json = container.toJSON() as {
    components: Array<{type: number; content?: string}>;
  };
  return json.components.map(component => component.content ?? '').join('\n');
}

function card(overrides: Partial<Parameters<typeof countryCard>[0]> = {}) {
  return textOf(
    countryCard({
      country: FRANCE,
      state: state(),
      members: ['u1', 'u2'],
      territories: [],
      viewerIsMember: false,
      now: NOW,
      ...overrides,
    }),
  );
}

describe('countryCard', () => {
  it('invites a player to found an unclaimed country', () => {
    expect(card({state: undefined})).toContain('Unclaimed');
    expect(card({state: state({status: 'inactive'})})).toContain('Unclaimed');
  });

  it('hides the stockpile from outsiders', () => {
    const text = card({viewerIsMember: false});
    expect(text).not.toContain('56 troops');
    expect(text).toContain('own players can see its stockpile');
  });

  it('shows the stockpile to the country own members', () => {
    const text = card({viewerIsMember: true});
    expect(text).toContain('12 food');
    expect(text).toContain('34 gold');
    expect(text).toContain('56 troops');
  });

  it('lists the roster and territories', () => {
    const text = card({
      territories: [state({code: 'DE', status: 'defeated', ownerCode: 'FR'})],
    });
    expect(text).toContain('<@u1>');
    expect(text).toContain('Players (2)');
    // Its own homeland, and the one it took.
    expect(text).toContain('Territories (2)');
    expect(text).toContain('🇫🇷 France, 🇩🇪 Germany');
  });

  it('counts a country that has taken nobody as holding its homeland', () => {
    const text = card({territories: []});
    expect(text).toContain('Territories (1)');
    expect(text).toContain('🇫🇷 France');
  });

  it('names the conqueror of a fallen country', () => {
    const text = card({
      state: state({status: 'defeated', ownerCode: 'DE', roleId: null}),
    });
    expect(text).toContain('Conquered');
    expect(text).toContain('🇩🇪 Germany');
    expect(text).toContain('read-only archive');
  });

  it('shows only the protections that are still running', () => {
    const text = card({
      state: state({
        protectedUntil: NOW + 1_000,
        defenseImmunityUntil: NOW - 1_000,
        invadeCooldownUntil: NOW + 2_000,
      }),
    });
    expect(text).toContain('New-country protection');
    expect(text).toContain('Cannot declare an invasion');
    expect(text).not.toContain('Immune after a successful defence');
  });

  it('renders deadlines as live Discord timestamps', () => {
    const text = card({state: state({protectedUntil: NOW + 1_000})});
    expect(text).toMatch(/<t:\d+:R>/);
  });

  it('warns when a country has lost its last player', () => {
    expect(card({members: []})).toContain('about to be disbanded');
  });
});

describe('warLine', () => {
  function invasion(overrides: Partial<Invasion> = {}): Invasion {
    return {
      id: 1,
      guildId: 'g1',
      attackerCode: 'FR',
      defenderCode: 'DE',
      attack: {troops: 20, gold: 0, food: 0},
      defense: null,
      attackField: {troops: 20, gold: 0, food: 0},
      defenseField: {troops: 0, gold: 0, food: 0},
      status: 'war',
      attackVoteDeadline: NOW,
      defenseDeadline: NOW + 1_000,
      nextTickAt: NOW + 100,
      reinforcingSide: null,
      reinforceDeadline: null,
      rounds: 3,
      attackMessageId: null,
      createdAt: NOW,
      resolvedAt: null,
      ...overrides,
    };
  }

  it('tells the two sides of a vote apart', () => {
    const vote = invasion({status: 'attack_vote'});
    expect(warLine('FR', vote)).toContain('whether to invade');
    expect(warLine('DE', vote)).toContain('as a target');
  });

  it('tells the two sides of an unanswered invasion apart', () => {
    const marching = invasion({status: 'defense_window'});
    expect(warLine('FR', marching)).toContain('Marching on');
    expect(warLine('DE', marching)).toContain('a defence must be raised');
    expect(warLine('DE', marching)).toMatch(/<t:\d+:R>/);
  });

  it('counts the rounds of an ongoing war', () => {
    expect(warLine('FR', invasion())).toContain('3 rounds in');
    expect(warLine('FR', invasion({rounds: 1}))).toContain('1 round in');
  });

  it('says which side has been fought to nothing', () => {
    const spent = invasion({
      status: 'reinforcing',
      reinforcingSide: 'defender',
    });
    expect(warLine('DE', spent)).toContain('Fought to nothing');
    expect(warLine('FR', spent)).toContain('nothing left in the field');
  });

  it('names the enemy, whichever side is asking', () => {
    expect(warLine('FR', invasion())).toContain('🇩🇪 Germany');
    expect(warLine('DE', invasion())).toContain('🇫🇷 France');
  });
});

describe('countryCard at war', () => {
  it('leads with the war a country is fighting', () => {
    const text = card({
      invasion: {
        id: 1,
        guildId: 'g1',
        attackerCode: 'FR',
        defenderCode: 'DE',
        attack: {troops: 20, gold: 0, food: 0},
        defense: null,
        attackField: {troops: 20, gold: 0, food: 0},
        defenseField: {troops: 0, gold: 0, food: 0},
        status: 'war',
        attackVoteDeadline: NOW,
        defenseDeadline: NOW + 1_000,
        nextTickAt: NOW + 100,
        reinforcingSide: null,
        reinforceDeadline: null,
        rounds: 2,
        attackMessageId: null,
        createdAt: NOW,
        resolvedAt: null,
      },
    });
    expect(text).toContain('At war with 🇩🇪 Germany');
  });

  it('says nothing about a war when there is none', () => {
    expect(card()).not.toContain('At war');
  });
});
