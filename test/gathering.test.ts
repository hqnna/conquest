import {beforeEach, describe, expect, it} from 'vitest';
import type {Database} from 'better-sqlite3';
import {COOLDOWNS, RESOURCES} from '../src/config/constants.js';
import {defaultSettings} from '../src/config/settings.js';
import {activateCountry} from '../src/db/countries.js';
import {getCooldown, setCooldown} from '../src/db/cooldowns.js';
import {openTestDatabase} from '../src/db/index.js';
import {addResources, getStockpile} from '../src/db/resources.js';
import type {Stockpile} from '../src/db/resources.js';
import {
  decideGather,
  gather,
  gatherRules,
  rollYield,
  shortfall,
} from '../src/game/gathering.js';

const NOW = 1_700_000_000_000;
const EMPTY: Stockpile = {food: 0, gold: 0, troops: 0};

/** A guild that has changed nothing, so the shipped numbers apply. */
const settings = defaultSettings();
const GATHER_RULES = gatherRules(settings);

function setup(): Database {
  const db = openTestDatabase();
  activateCountry(db, {
    guildId: 'g1',
    code: 'FR',
    name: 'France',
    channelId: 'chan',
    roleId: 'role',
    now: NOW,
  });
  return db;
}

describe('rollYield', () => {
  it('hits the bottom of the range', () => {
    expect(rollYield({min: 8, max: 15}, () => 0)).toBe(8);
  });

  it('hits the top of the range', () => {
    expect(rollYield({min: 8, max: 15}, () => 0.999999)).toBe(15);
  });

  it('never leaves the range', () => {
    for (let i = 0; i < 500; i++) {
      const rolled = rollYield(RESOURCES.farmYield);
      expect(rolled).toBeGreaterThanOrEqual(RESOURCES.farmYield.min);
      expect(rolled).toBeLessThanOrEqual(RESOURCES.farmYield.max);
      expect(Number.isInteger(rolled)).toBe(true);
    }
  });

  it('covers the whole range over many rolls', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) seen.add(rollYield(RESOURCES.recruitYield));
    expect(seen.size).toBe(
      RESOURCES.recruitYield.max - RESOURCES.recruitYield.min + 1,
    );
  });
});

describe('shortfall', () => {
  it('is empty when everything is covered', () => {
    expect(
      shortfall({food: 10, gold: 10, troops: 0}, {gold: 10, food: 10}),
    ).toEqual({});
  });

  it('reports only what is missing, and by how much', () => {
    expect(
      shortfall({food: 4, gold: 10, troops: 0}, {gold: 10, food: 10}),
    ).toEqual({food: 6});
  });
});

describe('decideGather', () => {
  const base = {
    configured: true,
    countryCode: 'FR',
    stockpile: EMPTY,
    command: 'farm' as const,
    cooldownUntil: null,
    settings,
    now: NOW,
  };

  it('allows a free gather with an empty stockpile', () => {
    expect(decideGather(base)).toEqual({ok: true});
  });

  it('refuses before setup', () => {
    expect(decideGather({...base, configured: false})).toEqual({
      ok: false,
      refusal: {kind: 'not_configured'},
    });
  });

  it('refuses a player with no country', () => {
    expect(decideGather({...base, countryCode: null})).toEqual({
      ok: false,
      refusal: {kind: 'not_in_country'},
    });
  });

  it('refuses while the cooldown runs, and allows it the moment it ends', () => {
    expect(decideGather({...base, cooldownUntil: NOW + 1})).toEqual({
      ok: false,
      refusal: {kind: 'cooldown', until: NOW + 1},
    });
    expect(decideGather({...base, cooldownUntil: NOW})).toEqual({ok: true});
  });

  it('refuses recruiting a country cannot pay for', () => {
    expect(
      decideGather({
        ...base,
        command: 'recruit',
        stockpile: {food: 10, gold: 4, troops: 0},
      }),
    ).toEqual({ok: false, refusal: {kind: 'insufficient', short: {gold: 6}}});
  });

  it('allows recruiting on exactly enough', () => {
    expect(
      decideGather({
        ...base,
        command: 'recruit',
        stockpile: {
          food: RESOURCES.recruitCost.food,
          gold: RESOURCES.recruitCost.gold,
          troops: 0,
        },
      }),
    ).toEqual({ok: true});
  });

  it('names the cooldown first when a player is both broke and waiting', () => {
    expect(
      decideGather({
        ...base,
        command: 'recruit',
        cooldownUntil: NOW + 1,
        stockpile: EMPTY,
      }),
    ).toEqual({ok: false, refusal: {kind: 'cooldown', until: NOW + 1}});
  });
});

describe('gather', () => {
  let db: Database;

  beforeEach(() => {
    db = setup();
  });

  function run(
    command: 'farm' | 'mine' | 'recruit',
    now = NOW,
    random = () => 0,
  ) {
    return gather(db, {
      guildId: 'g1',
      userId: 'u1',
      code: 'FR',
      command,
      now,
      random,
    });
  }

  it('banks food and starts the farm cooldown', () => {
    const outcome = run('farm');
    expect(outcome).toMatchObject({
      ok: true,
      result: {
        resource: 'food',
        amount: RESOURCES.farmYield.min,
        nextAvailableAt: NOW + COOLDOWNS.farm,
      },
    });
    expect(getStockpile(db, 'g1', 'FR')?.food).toBe(RESOURCES.farmYield.min);
    expect(getCooldown(db, 'g1', 'u1', 'farm')).toBe(NOW + COOLDOWNS.farm);
  });

  it('banks gold on its own cooldown, untouched by farming', () => {
    run('farm');
    const outcome = run('mine');
    expect(outcome.ok).toBe(true);
    expect(getStockpile(db, 'g1', 'FR')).toMatchObject({
      food: RESOURCES.farmYield.min,
      gold: RESOURCES.mineYield.min,
    });
  });

  it('refuses a second gather inside the cooldown and changes nothing', () => {
    run('farm');
    const before = getStockpile(db, 'g1', 'FR');
    const outcome = run('farm', NOW + 1);
    expect(outcome).toEqual({
      ok: false,
      refusal: {kind: 'cooldown', until: NOW + COOLDOWNS.farm},
    });
    expect(getStockpile(db, 'g1', 'FR')).toEqual(before);
  });

  it('allows the next gather once the cooldown expires', () => {
    run('farm');
    expect(run('farm', NOW + COOLDOWNS.farm).ok).toBe(true);
    expect(getStockpile(db, 'g1', 'FR')?.food).toBe(
      RESOURCES.farmYield.min * 2,
    );
  });

  it('cooldowns are per player, not per country', () => {
    run('farm');
    const other = gather(db, {
      guildId: 'g1',
      userId: 'u2',
      code: 'FR',
      command: 'farm',
      now: NOW,
      random: () => 0,
    });
    expect(other.ok).toBe(true);
  });

  it('converts gold and food into troops', () => {
    addResources(db, 'g1', 'FR', {gold: 30, food: 30});
    const outcome = run('recruit');

    expect(outcome).toMatchObject({
      ok: true,
      result: {resource: 'troops', amount: RESOURCES.recruitYield.min},
    });
    expect(getStockpile(db, 'g1', 'FR')).toEqual({
      gold: 30 - RESOURCES.recruitCost.gold,
      food: 30 - RESOURCES.recruitCost.food,
      troops: RESOURCES.recruitYield.min,
    });
  });

  it('refuses to recruit on an empty stockpile, and starts no cooldown', () => {
    const outcome = run('recruit');
    expect(outcome).toEqual({
      ok: false,
      refusal: {
        kind: 'insufficient',
        short: {
          food: RESOURCES.recruitCost.food,
          gold: RESOURCES.recruitCost.gold,
        },
      },
    });
    expect(getStockpile(db, 'g1', 'FR')).toEqual(EMPTY);
    expect(getCooldown(db, 'g1', 'u1', 'recruit')).toBeNull();
  });

  it('spends nothing when recruiting fails halfway through the cost', () => {
    addResources(db, 'g1', 'FR', {gold: 30, food: 1});
    expect(run('recruit').ok).toBe(false);
    expect(getStockpile(db, 'g1', 'FR')).toEqual({
      gold: 30,
      food: 1,
      troops: 0,
    });
  });

  it('rechecks the cooldown inside the transaction', () => {
    setCooldown(db, 'g1', 'u1', 'farm', NOW + 5_000);
    expect(run('farm')).toEqual({
      ok: false,
      refusal: {kind: 'cooldown', until: NOW + 5_000},
    });
    expect(getStockpile(db, 'g1', 'FR')).toEqual(EMPTY);
  });

  it('reports the stockpile as it stands after the gather', () => {
    addResources(db, 'g1', 'FR', {food: 5});
    const outcome = run('farm');
    expect(outcome.ok && outcome.result.stockpile.food).toBe(
      5 + RESOURCES.farmYield.min,
    );
  });

  it('pools everything gathered into the country, whoever gathered it', () => {
    run('farm');
    gather(db, {
      guildId: 'g1',
      userId: 'u2',
      code: 'FR',
      command: 'farm',
      now: NOW,
      random: () => 0,
    });
    expect(getStockpile(db, 'g1', 'FR')?.food).toBe(
      RESOURCES.farmYield.min * 2,
    );
  });
});

describe('gather rules', () => {
  it('read their numbers from the settings', () => {
    expect(GATHER_RULES.farm.cooldown).toBe(COOLDOWNS.farm);
    expect(GATHER_RULES.mine.cooldown).toBe(COOLDOWNS.mine);
    expect(GATHER_RULES.recruit.cooldown).toBe(COOLDOWNS.recruit);
    expect(GATHER_RULES.recruit.cost).toEqual({
      gold: RESOURCES.recruitCost.gold,
      food: RESOURCES.recruitCost.food,
    });
    expect(GATHER_RULES.farm.cost).toEqual({});
  });
});
