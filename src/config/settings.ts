/**
 * Per-guild tuning.
 *
 * The constants module holds what Conquest ships with; this holds what one
 * guild has decided instead. Everything the game reads goes through a
 * resolved {@link Settings}, which is the shipped defaults with that guild's
 * overrides applied — so a guild that has changed nothing behaves exactly as
 * before, and follows the defaults if they ever change.
 *
 * The tunables are declared once, in {@link TUNABLES}. That one registry
 * drives the admin command's choices, its validation, what `/game settings`
 * prints, and how a stored value is applied — so a new tunable cannot be
 * half-added.
 */
import {COOLDOWNS, GAME, INVASIONS, RESOURCES, WAR} from './constants.js';

/** An inclusive range of whole numbers. */
export interface Range {
  min: number;
  max: number;
}

/** Every number the game reads, resolved for one guild. */
export interface Settings {
  resources: {
    farmYield: Range;
    mineYield: Range;
    recruitCost: {gold: number; food: number};
    recruitYield: Range;
  };
  cooldowns: {
    farm: number;
    mine: number;
    recruit: number;
    rejoin: number;
    invade: number;
  };
  invasions: {
    attackVoteWindow: number;
    defenseWindow: number;
    successfulDefenseImmunity: number;
    newCountryProtection: number;
    homeAdvantage: number;
    luckRange: Range;
    maxSupplyBonus: number;
    supplyRatioDivisor: number;
  };
  war: {
    tickInterval: number;
    baseLossRate: number;
    lossRateRange: Range;
    reinforcementWindow: number;
  };
  game: {
    dominationThreshold: number;
    lastCountryStandingDuration: number;
  };
}

/** The settings Conquest ships with, as a fresh mutable copy. */
export function defaultSettings(): Settings {
  return {
    resources: {
      farmYield: {...RESOURCES.farmYield},
      mineYield: {...RESOURCES.mineYield},
      recruitCost: {...RESOURCES.recruitCost},
      recruitYield: {...RESOURCES.recruitYield},
    },
    cooldowns: {
      farm: COOLDOWNS.farm,
      mine: COOLDOWNS.mine,
      recruit: COOLDOWNS.recruit,
      rejoin: COOLDOWNS.rejoin,
      invade: COOLDOWNS.invade,
    },
    invasions: {
      attackVoteWindow: INVASIONS.attackVoteWindow,
      defenseWindow: INVASIONS.defenseWindow,
      successfulDefenseImmunity: INVASIONS.successfulDefenseImmunity,
      newCountryProtection: INVASIONS.newCountryProtection,
      homeAdvantage: INVASIONS.homeAdvantage,
      luckRange: {...INVASIONS.luckRange},
      maxSupplyBonus: INVASIONS.maxSupplyBonus,
      supplyRatioDivisor: INVASIONS.supplyRatioDivisor,
    },
    war: {
      tickInterval: WAR.tickInterval,
      baseLossRate: WAR.baseLossRate,
      lossRateRange: {...WAR.lossRateRange},
      reinforcementWindow: WAR.reinforcementWindow,
    },
    game: {
      dominationThreshold: GAME.defaultDominationThreshold,
      lastCountryStandingDuration: GAME.lastCountryStandingDuration,
    },
  };
}

/** How a tunable's stored number is presented to, and taken from, an admin. */
export type TunableUnit = 'minutes' | 'count' | 'percent';

/** One thing an admin may retune. */
export interface Tunable {
  /** Stable id, stored in the database and used as the command choice. */
  key: string;
  /** How it reads in the command's choice list. */
  label: string;
  /** What changing it does, shown by `/game settings`. */
  description: string;
  unit: TunableUnit;
  /** Bounds in the admin-facing unit, inclusive. */
  min: number;
  max: number;
  /** Reads the current value out of resolved settings, in the admin unit. */
  read(settings: Settings): number;
  /** Applies an admin-supplied value to resolved settings. */
  apply(settings: Settings, value: number): void;
}

const MINUTE = 60_000;

/** Whole minutes as milliseconds, and back. */
const asMinutes = (ms: number) => Math.round(ms / MINUTE);
const fromMinutes = (minutes: number) => minutes * MINUTE;

/** Whole percent as a fraction, and back. */
const asPercent = (fraction: number) => Math.round(fraction * 100);
const fromPercent = (percent: number) => percent / 100;

/**
 * Everything a guild may retune, with the bounds that keep the game playable.
 *
 * The bounds are not decoration: a zero-length war round would spin, a
 * hundred-percent loss rate would end every war in one blow, and a defence
 * window measured in seconds would make an invasion unanswerable.
 */
export const TUNABLES: readonly Tunable[] = [
  {
    key: 'gather_cooldown',
    label: 'Gather cooldown (farm and mine)',
    description: 'How long a player waits between /farm or /mine.',
    unit: 'minutes',
    min: 1,
    max: 24 * 60,
    read: settings => asMinutes(settings.cooldowns.farm),
    apply: (settings, value) => {
      settings.cooldowns.farm = fromMinutes(value);
      settings.cooldowns.mine = fromMinutes(value);
    },
  },
  {
    key: 'recruit_cooldown',
    label: 'Recruit cooldown',
    description: 'How long a player waits between /recruit.',
    unit: 'minutes',
    min: 1,
    max: 24 * 60,
    read: settings => asMinutes(settings.cooldowns.recruit),
    apply: (settings, value) => {
      settings.cooldowns.recruit = fromMinutes(value);
    },
  },
  {
    key: 'recruit_cost',
    label: 'Recruit cost (gold and food each)',
    description: 'What each /recruit costs the country, of both resources.',
    unit: 'count',
    min: 1,
    max: 500,
    read: settings => settings.resources.recruitCost.gold,
    apply: (settings, value) => {
      settings.resources.recruitCost.gold = value;
      settings.resources.recruitCost.food = value;
    },
  },
  {
    key: 'rejoin_cooldown',
    label: 'Rejoin cooldown',
    description: 'How long after /leave a player must wait to join again.',
    unit: 'minutes',
    min: 0,
    max: 7 * 24 * 60,
    read: settings => asMinutes(settings.cooldowns.rejoin),
    apply: (settings, value) => {
      settings.cooldowns.rejoin = fromMinutes(value);
    },
  },
  {
    key: 'invade_cooldown',
    label: 'Invasion cooldown',
    description: 'How long a country waits after a war before declaring again.',
    unit: 'minutes',
    min: 0,
    max: 7 * 24 * 60,
    read: settings => asMinutes(settings.cooldowns.invade),
    apply: (settings, value) => {
      settings.cooldowns.invade = fromMinutes(value);
    },
  },
  {
    key: 'attack_vote_window',
    label: 'Attack vote window',
    description: 'How long a country has to approve an invasion.',
    unit: 'minutes',
    min: 1,
    max: 7 * 24 * 60,
    read: settings => asMinutes(settings.invasions.attackVoteWindow),
    apply: (settings, value) => {
      settings.invasions.attackVoteWindow = fromMinutes(value);
    },
  },
  {
    key: 'defense_window',
    label: 'Defence window',
    description: 'How long a defender has to answer an invasion.',
    unit: 'minutes',
    min: 1,
    max: 7 * 24 * 60,
    read: settings => asMinutes(settings.invasions.defenseWindow),
    apply: (settings, value) => {
      settings.invasions.defenseWindow = fromMinutes(value);
    },
  },
  {
    key: 'new_country_protection',
    label: 'New-country protection',
    description: 'How long a freshly founded country cannot be invaded.',
    unit: 'minutes',
    min: 0,
    max: 14 * 24 * 60,
    read: settings => asMinutes(settings.invasions.newCountryProtection),
    apply: (settings, value) => {
      settings.invasions.newCountryProtection = fromMinutes(value);
    },
  },
  {
    key: 'defense_immunity',
    label: 'Immunity after a successful defence',
    description: 'How long a country that held cannot be invaded again.',
    unit: 'minutes',
    min: 0,
    max: 7 * 24 * 60,
    read: settings => asMinutes(settings.invasions.successfulDefenseImmunity),
    apply: (settings, value) => {
      settings.invasions.successfulDefenseImmunity = fromMinutes(value);
    },
  },
  {
    key: 'war_tick',
    label: 'War round interval',
    description: 'How often an ongoing war exchanges blows.',
    unit: 'minutes',
    min: 1,
    max: 24 * 60,
    read: settings => asMinutes(settings.war.tickInterval),
    apply: (settings, value) => {
      settings.war.tickInterval = fromMinutes(value);
    },
  },
  {
    key: 'reinforcement_window',
    label: 'Reinforcement window',
    description: 'How long a spent country has to reinforce before it loses.',
    unit: 'minutes',
    min: 1,
    max: 7 * 24 * 60,
    read: settings => asMinutes(settings.war.reinforcementWindow),
    apply: (settings, value) => {
      settings.war.reinforcementWindow = fromMinutes(value);
    },
  },
  {
    key: 'war_loss_rate',
    label: 'Losses per war round',
    description: 'Share of a force lost each round in an even war.',
    unit: 'percent',
    min: 1,
    max: 50,
    read: settings => asPercent(settings.war.baseLossRate),
    apply: (settings, value) => {
      settings.war.baseLossRate = fromPercent(value);
      // The clamps have to keep containing the rate they clamp.
      settings.war.lossRateRange = {
        min: Math.min(settings.war.lossRateRange.min, fromPercent(value)),
        max: Math.max(settings.war.lossRateRange.max, fromPercent(value)),
      };
    },
  },
  {
    key: 'home_advantage',
    label: 'Home advantage',
    description: 'How much stronger a defender fights on its own ground.',
    unit: 'percent',
    min: 0,
    max: 200,
    read: settings => asPercent(settings.invasions.homeAdvantage - 1),
    apply: (settings, value) => {
      settings.invasions.homeAdvantage = 1 + fromPercent(value);
    },
  },
  {
    key: 'supply_bonus_cap',
    label: 'Supply bonus cap',
    description: 'Most that gold and food can add to a force’s power.',
    unit: 'percent',
    min: 0,
    max: 200,
    read: settings => asPercent(settings.invasions.maxSupplyBonus),
    apply: (settings, value) => {
      settings.invasions.maxSupplyBonus = fromPercent(value);
    },
  },
  {
    key: 'domination_threshold',
    label: 'Territories needed to win',
    description: 'How much of the world one country must hold to win.',
    unit: 'count',
    min: 1,
    max: 100,
    read: settings => settings.game.dominationThreshold,
    apply: (settings, value) => {
      settings.game.dominationThreshold = value;
    },
  },
  {
    key: 'last_standing_duration',
    label: 'Last-country-standing duration',
    description: 'How long a lone survivor must stand alone to win.',
    unit: 'minutes',
    min: 1,
    max: 30 * 24 * 60,
    read: settings => asMinutes(settings.game.lastCountryStandingDuration),
    apply: (settings, value) => {
      settings.game.lastCountryStandingDuration = fromMinutes(value);
    },
  },
];

/** Tunables by key, for validating and applying a stored override. */
export const TUNABLES_BY_KEY = new Map(
  TUNABLES.map(tunable => [tunable.key, tunable]),
);

/** Whether a value is one this tunable will accept. */
export function isInRange(tunable: Tunable, value: number): boolean {
  return (
    Number.isInteger(value) && value >= tunable.min && value <= tunable.max
  );
}

/**
 * Applies a guild's overrides to the shipped defaults.
 *
 * Unknown keys and out-of-range values are ignored rather than throwing: they
 * can only come from a tunable that was removed or narrowed since the value
 * was stored, and a guild's game should not stop working because of it.
 */
export function applyOverrides(
  overrides: ReadonlyMap<string, number>,
): Settings {
  const settings = defaultSettings();
  for (const [key, value] of overrides) {
    const tunable = TUNABLES_BY_KEY.get(key);
    if (!tunable || !isInRange(tunable, value)) continue;
    tunable.apply(settings, value);
  }
  return settings;
}
