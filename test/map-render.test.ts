import {beforeEach, describe, expect, it} from 'vitest';
import type {Database} from 'better-sqlite3';
import {activateCountry} from '../src/db/countries.js';
import {upsertGuildConfig} from '../src/db/guild-config.js';
import {openTestDatabase} from '../src/db/index.js';
import {addResources} from '../src/db/resources.js';
import {declareInvasion} from '../src/game/invasions.js';
import {MapRenderer, createMapRenderer, mapState} from '../src/map/index.js';
import {cliRasterizer, selectRasterizer} from '../src/map/rasterizer.js';
import type {Rasterizer} from '../src/map/rasterizer.js';

const NOW = 1_700_000_000_000;
const G = 'g1';

function world(): Database {
  const db = openTestDatabase();
  upsertGuildConfig(db, {
    guildId: G,
    categoryId: 'cat',
    logChannelId: 'log',
    now: NOW,
  });
  for (const code of ['FR', 'DE', 'JP']) {
    activateCountry(db, {
      guildId: G,
      code,
      name: code,
      channelId: `chan-${code}`,
      roleId: `role-${code}`,
      now: NOW,
    });
    db.prepare('UPDATE countries SET protected_until = NULL').run();
    addResources(db, G, code, {troops: 50, gold: 0, food: 0});
  }
  return db;
}

describe('mapState', () => {
  let db: Database;

  beforeEach(() => {
    db = world();
  });

  it('draws only the countries in play', () => {
    const state = mapState(db, G);
    expect(state.countries.map(c => c.code).sort()).toEqual(['DE', 'FR', 'JP']);
    expect(state.countries.every(c => c.status === 'active')).toBe(true);
  });

  it('draws a conquered country as its owner territory', () => {
    db.prepare(
      "UPDATE countries SET status = 'defeated', owner_code = 'FR' WHERE code = 'DE'",
    ).run();
    const de = mapState(db, G).countries.find(c => c.code === 'DE');
    expect(de).toEqual({
      code: 'DE',
      ownerCode: 'FR',
      status: 'defeated',
      atWar: false,
    });
  });

  it('marks both sides of a war', () => {
    const declared = declareInvasion(db, {
      guildId: G,
      attackerCode: 'FR',
      defenderCode: 'DE',
      stake: {troops: 5, gold: 0, food: 0},
      now: NOW,
    });
    expect(declared.ok).toBe(true);

    const state = mapState(db, G);
    expect(
      state.countries
        .filter(c => c.atWar)
        .map(c => c.code)
        .sort(),
    ).toEqual(['DE', 'FR']);
  });

  it('forgets a country that was disbanded', () => {
    db.prepare(
      "UPDATE countries SET status = 'inactive' WHERE code = 'JP'",
    ).run();
    expect(mapState(db, G).countries.map(c => c.code)).not.toContain('JP');
  });

  it('keeps guilds apart', () => {
    expect(mapState(db, 'other-guild').countries).toEqual([]);
  });

  it('carries the requested crop', () => {
    expect(mapState(db, G, 'Europe').region).toBe('Europe');
    expect(mapState(db, G).region).toBeUndefined();
  });
});

describe('MapRenderer', () => {
  const state = {
    countries: [
      {code: 'FR', ownerCode: null, status: 'active' as const, atWar: true},
      {
        code: 'DE',
        ownerCode: 'FR',
        status: 'defeated' as const,
        atWar: false,
      },
    ],
  };

  /** Counts renders, so caching can be observed rather than assumed. */
  function countingRasterizer(): Rasterizer & {calls: string[]} {
    const calls: string[] = [];
    return {
      name: 'counting',
      calls,
      async render(svg: string): Promise<Buffer> {
        calls.push(svg);
        return Buffer.from(`png-${calls.length}`);
      },
    };
  }

  it('renders once and serves the same world from cache', async () => {
    const rasterizer = countingRasterizer();
    const renderer = new MapRenderer(rasterizer);

    const first = await renderer.render(state);
    const second = await renderer.render(state);

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.png).toEqual(first.png);
    expect(rasterizer.calls).toHaveLength(1);
  });

  it('renders again once the world changes', async () => {
    const rasterizer = countingRasterizer();
    const renderer = new MapRenderer(rasterizer);

    await renderer.render(state);
    await renderer.render({
      countries: [{...state.countries[0], atWar: false}],
    });

    expect(rasterizer.calls).toHaveLength(2);
  });

  it('renders again for a different crop', async () => {
    const rasterizer = countingRasterizer();
    const renderer = new MapRenderer(rasterizer);

    await renderer.render(state);
    await renderer.render({...state, region: 'Europe'});

    expect(rasterizer.calls).toHaveLength(2);
  });

  it('renders again after a round is wiped', async () => {
    const rasterizer = countingRasterizer();
    const renderer = new MapRenderer(rasterizer);

    await renderer.render(state);
    renderer.clear();
    await renderer.render(state);

    expect(rasterizer.calls).toHaveLength(2);
  });

  it('hands the rasterizer painted SVG, not the bare asset', async () => {
    const rasterizer = countingRasterizer();
    await new MapRenderer(rasterizer).render(state);

    const [svg] = rasterizer.calls;
    expect(svg).toContain('#FR{fill:');
    expect(svg).toContain('#DE{fill:');
    expect(svg).toContain('stroke:#ff3b30');
    expect(svg).toContain('<path id="FR"');
  });
});

describe('rasterizing for real', () => {
  it('has a working backend in the development shell', async () => {
    const rasterizer = await selectRasterizer();
    expect(rasterizer).toBeDefined();
  });

  it('draws the world as a PNG', async () => {
    const renderer = await createMapRenderer();
    expect(renderer).toBeDefined();

    const {png} = await renderer!.render(
      {
        countries: [
          {code: 'FR', ownerCode: null, status: 'active', atWar: true},
          {code: 'DE', ownerCode: 'FR', status: 'defeated', atWar: false},
        ],
      },
      400,
    );

    // A PNG, and a substantial one: the world is not a blank square.
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(png.length).toBeGreaterThan(5_000);
  });

  it('draws a crop differently from the whole world', async () => {
    const renderer = await createMapRenderer();
    const countries = [
      {code: 'FR', ownerCode: null, status: 'active' as const, atWar: false},
    ];
    const whole = await renderer!.render({countries}, 400);
    const cropped = await renderer!.render({countries, region: 'Europe'}, 400);

    expect(cropped.png).not.toEqual(whole.png);
  });
});

describe('the CLI fallback', () => {
  it('renders through the resvg command when it is available', async () => {
    const cli = await cliRasterizer();
    // The development shell ships resvg; a bare environment may not.
    if (!cli) return;

    const png = await cli.render(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="10" height="10"><rect width="10" height="10" fill="#ff0000"/></svg>',
      40,
    );
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it('reports itself missing rather than throwing', async () => {
    expect(await cliRasterizer('definitely-not-a-real-binary')).toBeUndefined();
  });
});
