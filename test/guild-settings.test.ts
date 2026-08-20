import {beforeEach, describe, expect, it} from 'vitest';
import type {Database} from 'better-sqlite3';
import {
  COOLDOWNS,
  GAME,
  INVASIONS,
  RESOURCES,
  WAR,
} from '../src/config/constants.js';
import {
  TUNABLES,
  applyOverrides,
  defaultSettings,
  isInRange,
} from '../src/config/settings.js';
import {activateCountry, getCountry} from '../src/db/countries.js';
import {upsertGuildConfig} from '../src/db/guild-config.js';
import {
  clearOverride,
  clearOverrides,
  forgetSettings,
  listOverrides,
  setOverride,
  settingsFor,
  summariseSettings,
} from '../src/db/guild-settings.js';
import {openTestDatabase} from '../src/db/index.js';
import {getPlayer, joinCountry, leaveCountry} from '../src/db/players.js';
import {addResources} from '../src/db/resources.js';
import {gather, gatherRules} from '../src/game/gathering.js';
import {fightRound} from '../src/game/resolution.js';

const NOW = 1_700_000_000_000;
const G = 'g1';

function world(): Database {
  forgetSettings();
  const db = openTestDatabase();
  upsertGuildConfig(db, {
    guildId: G,
    categoryId: 'cat',
    logChannelId: 'log',
    now: NOW,
  });
  return db;
}

/** Retunes a setting the way `/game tune` does. */
function tune(db: Database, key: string, value: number, guildId = G) {
  setOverride(db, guildId, key, value, NOW);
  forgetSettings(guildId);
}

describe('the tunable registry', () => {
  it('gives every tunable a unique, stable key', () => {
    const keys = TUNABLES.map(tunable => tunable.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it('describes every tunable for the admin who has to choose', () => {
    for (const tunable of TUNABLES) {
      expect(tunable.label.length).toBeGreaterThan(0);
      expect(tunable.description.length).toBeGreaterThan(0);
      expect(tunable.min).toBeLessThan(tunable.max);
    }
  });

  it('ships a default inside every tunable’s own bounds', () => {
    const settings = defaultSettings();
    for (const tunable of TUNABLES) {
      expect(isInRange(tunable, tunable.read(settings))).toBe(true);
    }
  });

  it('round-trips every tunable through its own units', () => {
    for (const tunable of TUNABLES) {
      const settings = defaultSettings();
      const value = Math.min(tunable.max, tunable.min + 1);
      tunable.apply(settings, value);
      expect(tunable.read(settings)).toBe(value);
    }
  });

  it('changes only what it names', () => {
    const before = JSON.stringify(defaultSettings());
    for (const tunable of TUNABLES) {
      const settings = defaultSettings();
      tunable.apply(settings, tunable.read(settings));
      // Applying the current value must be a no-op.
      expect(JSON.stringify(settings)).toBe(before);
    }
  });

  it('fits inside Discord’s choice limit', () => {
    expect(TUNABLES.length).toBeLessThanOrEqual(25);
  });
});

describe('applyOverrides', () => {
  it('is the shipped defaults when nothing is overridden', () => {
    expect(applyOverrides(new Map())).toEqual(defaultSettings());
  });

  it('applies what it is given', () => {
    const settings = applyOverrides(new Map([['domination_threshold', 3]]));
    expect(settings.game.dominationThreshold).toBe(3);
  });

  it('ignores a key it no longer knows, rather than failing', () => {
    expect(applyOverrides(new Map([['from_an_older_build', 5]]))).toEqual(
      defaultSettings(),
    );
  });

  it('ignores a value outside what the tunable now accepts', () => {
    const settings = applyOverrides(
      new Map([['domination_threshold', 100_000]]),
    );
    expect(settings.game.dominationThreshold).toBe(
      GAME.defaultDominationThreshold,
    );
  });

  it('keeps the loss clamps containing the rate they clamp', () => {
    const settings = applyOverrides(new Map([['war_loss_rate', 50]]));
    expect(settings.war.baseLossRate).toBeCloseTo(0.5, 5);
    expect(settings.war.lossRateRange.max).toBeGreaterThanOrEqual(0.5);
    expect(settings.war.lossRateRange.min).toBeLessThanOrEqual(0.5);
  });

  it('never mutates the shipped defaults', () => {
    applyOverrides(new Map([['gather_cooldown', 1]]));
    expect(COOLDOWNS.farm).toBe(defaultSettings().cooldowns.farm);
  });
});

describe('storing overrides', () => {
  let db: Database;

  beforeEach(() => {
    db = world();
  });

  it('resolves to the defaults for a guild that has changed nothing', () => {
    expect(settingsFor(db, G)).toEqual(defaultSettings());
    expect(listOverrides(db, G)).toEqual([]);
  });

  it('remembers what an admin chose', () => {
    tune(db, 'defense_window', 90);
    expect(settingsFor(db, G).invasions.defenseWindow).toBe(90 * 60_000);
    expect(listOverrides(db, G)).toEqual([
      {key: 'defense_window', value: 90, setAt: NOW},
    ]);
  });

  it('stores what the admin typed, not what the game uses', () => {
    tune(db, 'defense_window', 90);
    // Minutes, so what comes back out is what somebody asked for.
    expect(listOverrides(db, G)[0].value).toBe(90);
  });

  it('replaces rather than stacking', () => {
    tune(db, 'defense_window', 90);
    tune(db, 'defense_window', 30);
    expect(listOverrides(db, G)).toHaveLength(1);
    expect(settingsFor(db, G).invasions.defenseWindow).toBe(30 * 60_000);
  });

  it('refuses a value the tunable will not accept', () => {
    expect(() => setOverride(db, G, 'domination_threshold', 0, NOW)).toThrow(
      /between/,
    );
    expect(() => setOverride(db, G, 'war_tick', 1.5, NOW)).toThrow(/whole/);
    expect(() => setOverride(db, G, 'not_a_setting', 1, NOW)).toThrow(
      /Unknown setting/,
    );
    expect(listOverrides(db, G)).toEqual([]);
  });

  it('puts one setting back', () => {
    tune(db, 'defense_window', 90);
    expect(clearOverride(db, G, 'defense_window')).toBe(true);
    forgetSettings(G);
    expect(settingsFor(db, G).invasions.defenseWindow).toBe(
      INVASIONS.defenseWindow,
    );
    expect(clearOverride(db, G, 'defense_window')).toBe(false);
  });

  it('puts every setting back at once', () => {
    tune(db, 'defense_window', 90);
    tune(db, 'war_tick', 5);
    expect(clearOverrides(db, G)).toBe(2);
    forgetSettings(G);
    expect(settingsFor(db, G)).toEqual(defaultSettings());
  });

  it('keeps guilds apart', () => {
    upsertGuildConfig(db, {
      guildId: 'g2',
      categoryId: 'c',
      logChannelId: 'l',
      now: NOW,
    });
    tune(db, 'domination_threshold', 3);

    expect(settingsFor(db, G).game.dominationThreshold).toBe(3);
    expect(settingsFor(db, 'g2').game.dominationThreshold).toBe(
      GAME.defaultDominationThreshold,
    );
  });

  it('takes effect on the next read, not the next restart', () => {
    expect(settingsFor(db, G).war.tickInterval).toBe(WAR.tickInterval);
    tune(db, 'war_tick', 5);
    expect(settingsFor(db, G).war.tickInterval).toBe(5 * 60_000);
  });
});

describe('summariseSettings', () => {
  it('marks what a guild has changed, and what it has not', () => {
    const db = world();
    tune(db, 'domination_threshold', 3);

    const summaries = summariseSettings(db, G);
    expect(summaries).toHaveLength(TUNABLES.length);

    const threshold = summaries.find(
      summary => summary.tunable.key === 'domination_threshold',
    );
    expect(threshold).toMatchObject({value: 3, isDefault: false});

    const untouched = summaries.find(
      summary => summary.tunable.key === 'war_tick',
    );
    expect(untouched).toMatchObject({isDefault: true});
  });
});

describe('overrides change the game, not just the numbers', () => {
  let db: Database;

  beforeEach(() => {
    db = world();
    activateCountry(db, {
      guildId: G,
      code: 'FR',
      name: 'FR',
      channelId: 'c',
      roleId: 'r',
      now: NOW,
    });
  });

  it('a retuned gather cooldown is the one a gather starts', () => {
    tune(db, 'gather_cooldown', 5);
    const outcome = gather(db, {
      guildId: G,
      userId: 'u1',
      code: 'FR',
      command: 'farm',
      now: NOW,
      random: () => 0,
    });
    expect(outcome.ok && outcome.result.nextAvailableAt).toBe(NOW + 5 * 60_000);
  });

  it('a retuned recruit cost is what recruiting actually costs', () => {
    tune(db, 'recruit_cost', 2);
    addResources(db, G, 'FR', {gold: 2, food: 2});

    const outcome = gather(db, {
      guildId: G,
      userId: 'u1',
      code: 'FR',
      command: 'recruit',
      now: NOW,
      random: () => 0,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.result.stockpile).toMatchObject({
      gold: 0,
      food: 0,
    });
    expect(gatherRules(settingsFor(db, G)).recruit.cost).toEqual({
      gold: 2,
      food: 2,
    });
  });

  it('a retuned protection is the one a new country gets', () => {
    tune(db, 'new_country_protection', 10);
    activateCountry(db, {
      guildId: G,
      code: 'DE',
      name: 'DE',
      channelId: 'c',
      roleId: 'r',
      now: NOW,
    });
    expect(getCountry(db, G, 'DE')?.protectedUntil).toBe(NOW + 10 * 60_000);
  });

  it('a retuned rejoin cooldown is the one leaving applies', () => {
    tune(db, 'rejoin_cooldown', 7);
    joinCountry(db, {guildId: G, userId: 'u1', code: 'FR', now: NOW});
    leaveCountry(db, {guildId: G, userId: 'u1', now: NOW, withCooldown: true});
    expect(getPlayer(db, G, 'u1')?.rejoinCooldownUntil).toBe(NOW + 7 * 60_000);
  });

  it('a retuned home advantage changes who wins a round of war', () => {
    const attack = {troops: 30, gold: 0, food: 0};
    const defense = {troops: 25, gold: 0, food: 0};

    const fair = fightRound(attack, defense, defaultSettings(), () => 0.5);
    const fortified = fightRound(
      attack,
      defense,
      applyOverrides(new Map([['home_advantage', 100]])),
      () => 0.5,
    );

    expect(fortified.defensePower).toBeGreaterThan(fair.defensePower);
    expect(fortified.attackerLost.troops).toBeGreaterThan(
      fair.attackerLost.troops,
    );
  });

  it('a guild that changed nothing still plays the shipped game', () => {
    const settings = settingsFor(db, G);
    expect(settings.cooldowns.farm).toBe(COOLDOWNS.farm);
    expect(settings.resources.recruitCost.gold).toBe(
      RESOURCES.recruitCost.gold,
    );
    expect(settings.invasions.homeAdvantage).toBe(INVASIONS.homeAdvantage);
    expect(settings.war.baseLossRate).toBe(WAR.baseLossRate);
  });
});

describe('the settings cache', () => {
  it('is dropped per guild, leaving others alone', () => {
    const db = world();
    upsertGuildConfig(db, {
      guildId: 'g2',
      categoryId: 'c',
      logChannelId: 'l',
      now: NOW,
    });
    settingsFor(db, G);
    settingsFor(db, 'g2');

    setOverride(db, G, 'war_tick', 5, NOW);
    setOverride(db, 'g2', 'war_tick', 9, NOW);
    forgetSettings(G);

    expect(settingsFor(db, G).war.tickInterval).toBe(5 * 60_000);
    // g2 was not forgotten, so it still serves what it had resolved.
    expect(settingsFor(db, 'g2').war.tickInterval).toBe(WAR.tickInterval);

    forgetSettings();
    expect(settingsFor(db, 'g2').war.tickInterval).toBe(9 * 60_000);
  });
});
