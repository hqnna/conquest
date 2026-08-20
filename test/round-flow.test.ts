import {beforeEach, describe, expect, it} from 'vitest';
import type {Database} from 'better-sqlite3';
import type {ContainerBuilder, Guild} from 'discord.js';
import {activateCountry, listCountries} from '../src/db/countries.js';
import {getGuildConfig, upsertGuildConfig} from '../src/db/guild-config.js';
import {openTestDatabase} from '../src/db/index.js';
import {joinCountry} from '../src/db/players.js';
import {endRound, territoryRoll, victoryCard} from '../src/game/round-flow.js';
import type {Victory} from '../src/game/victory.js';

const NOW = 1_700_000_000_000;
const G = 'g1';

function textOf(container: ContainerBuilder): string {
  const json = container.toJSON() as {
    components: Array<{type: number; content?: string}>;
  };
  return json.components.map(component => component.content ?? '').join('\n');
}

/** A guild that records what Conquest asked it to delete. */
function fakeGuild(): {
  guild: Guild;
  deleted: {channels: string[]; roles: string[]};
} {
  const deleted = {channels: [] as string[], roles: [] as string[]};
  const guild = {
    id: G,
    channels: {
      delete: async (id: string) => {
        deleted.channels.push(id);
      },
      fetch: async () => null,
    },
    roles: {
      delete: async (id: string) => {
        deleted.roles.push(id);
      },
    },
  } as unknown as Guild;
  return {guild, deleted};
}

/** A guild that refuses every deletion, as one Conquest was kicked from would. */
function hostileGuild(): Guild {
  return {
    id: G,
    channels: {
      delete: async () => Promise.reject(new Error('missing access')),
      fetch: async () => null,
    },
    roles: {
      delete: async () => Promise.reject(new Error('missing access')),
    },
  } as unknown as Guild;
}

function world(): Database {
  const db = openTestDatabase();
  upsertGuildConfig(db, {
    guildId: G,
    categoryId: 'cat',
    logChannelId: 'log',
    now: NOW,
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
  }
  joinCountry(db, {guildId: G, userId: 'u1', code: 'FR', now: NOW});
  return db;
}

const victory: Victory = {
  code: 'FR',
  territories: 10,
  duration: 3 * 24 * 60 * 60 * 1000,
};

describe('territoryRoll', () => {
  it('says plainly when a country took nothing', () => {
    expect(territoryRoll([])).toContain('without taking a single one');
  });

  it('names a handful of conquests', () => {
    expect(territoryRoll(['DE', 'BE'])).toBe('🇩🇪 Germany, 🇧🇪 Belgium');
  });

  it('shows a long roll as flags rather than dropping any', () => {
    const codes = [
      'DE',
      'BE',
      'NL',
      'IT',
      'ES',
      'PT',
      'PL',
      'AT',
      'CH',
      'DK',
      'SE',
    ];
    const roll = territoryRoll(codes);
    expect(roll).toContain('🇩🇪 Germany');
    expect(roll).toContain('🇩🇰');
    expect(roll).toContain('🇸🇪');
  });
});

describe('victoryCard', () => {
  it('crowns the winner and names its victors', () => {
    const text = textOf(
      victoryCard({victory, members: ['u1', 'u2'], territoryCodes: ['DE']}),
    );
    expect(text).toContain('🇫🇷 France has won');
    expect(text).toContain('<@u1>');
    expect(text).toContain('<@u2>');
    expect(text).toContain('10');
  });

  it('reports how long the round ran', () => {
    const text = textOf(
      victoryCard({victory, members: [], territoryCodes: []}),
    );
    expect(text).toContain('3 days');
  });

  it('says the winner holds the whole world', () => {
    const text = textOf(
      victoryCard({victory, members: ['u1'], territoryCodes: ['DE']}),
    );
    expect(text).toContain('**10** territories');
    expect(text).toContain('every country in the world');
  });

  it('warns that the world is about to be wiped', () => {
    const text = textOf(
      victoryCard({victory, members: ['u1'], territoryCodes: ['DE']}),
    );
    expect(text).toContain('/join');
  });
});

describe('endRound', () => {
  let db: Database;

  beforeEach(() => {
    db = world();
  });

  it('deletes every country channel and role', async () => {
    const {guild, deleted} = fakeGuild();
    const result = await endRound(db, guild, victory, NOW + 100);

    expect(deleted.channels.sort()).toEqual(['chan-DE', 'chan-FR']);
    expect(deleted.roles.sort()).toEqual(['role-DE', 'role-FR']);
    expect(result).toEqual({channelsDeleted: 2, rolesDeleted: 2});
  });

  it('wipes the round and starts a new one', async () => {
    const {guild} = fakeGuild();
    await endRound(db, guild, victory, NOW + 100);

    expect(listCountries(db, G)).toEqual([]);
    expect(getGuildConfig(db, G)).toMatchObject({
      categoryId: 'cat',
      logChannelId: 'log',
      roundStartedAt: NOW + 100,
    });
  });

  it('wipes the game even when Discord refuses every deletion', async () => {
    const result = await endRound(db, hostileGuild(), victory, NOW + 100);

    expect(result).toEqual({channelsDeleted: 0, rolesDeleted: 0});
    // The database is the source of truth: stale channels are better than a
    // game that still believes in a round somebody already won.
    expect(listCountries(db, G)).toEqual([]);
  });

  it('resets without a victory, for an admin wiping the world', async () => {
    const {guild, deleted} = fakeGuild();
    await endRound(db, guild, null, NOW + 100);

    expect(deleted.channels).toHaveLength(2);
    expect(listCountries(db, G)).toEqual([]);
  });
});
