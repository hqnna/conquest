import {describe, expect, it} from 'vitest';
import type {ContainerBuilder} from 'discord.js';
import {countryCard} from '../src/commands/country.js';
import {findCountry} from '../src/data/countries.js';
import type {CountryState} from '../src/db/countries.js';

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
    expect(text).toContain('Territories (1)');
    expect(text).toContain('🇩🇪 Germany');
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
