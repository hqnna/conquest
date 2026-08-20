/**
 * Every tunable number in Conquest lives here. `/help` renders its numbers from
 * this module, so gameplay and documentation cannot drift apart.
 *
 * Durations are milliseconds; resource amounts are whole units.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/**
 * Dev mode shortens every game timer so a full round can be played by hand in
 * a few minutes. Enable with `CONQUEST_DEV_MODE=1`.
 */
export const DEV_MODE = process.env.CONQUEST_DEV_MODE === '1';

/** Divisor applied to every gameplay duration when dev mode is on. */
const TIME_SCALE = DEV_MODE ? 120 : 1;

/** Scales a duration by the dev-mode factor, never below one second. */
function duration(ms: number): number {
  return Math.max(SECOND, Math.round(ms / TIME_SCALE));
}

export const RESOURCES = {
  /** `/farm` yields a random amount in this inclusive range. */
  farmYield: {min: 8, max: 15},
  /** `/mine` yields a random amount in this inclusive range. */
  mineYield: {min: 8, max: 15},
  /** `/recruit` converts this much of each resource... */
  recruitCost: {gold: 10, food: 10},
  /** ...into a random amount of troops in this inclusive range. */
  recruitYield: {min: 3, max: 6},
} as const;

export const COOLDOWNS = {
  /** Per-player cooldown on `/farm`. */
  farm: duration(30 * MINUTE),
  /** Per-player cooldown on `/mine`. */
  mine: duration(30 * MINUTE),
  /** Per-player cooldown on `/recruit`. */
  recruit: duration(60 * MINUTE),
  /** How long a player must wait before joining a country again after `/leave`. */
  rejoin: duration(24 * HOUR),
  /** How long a country cannot declare an invasion after one of theirs resolves. */
  invade: duration(12 * HOUR),
} as const;

export const INVASIONS = {
  /** How long an attack vote stays open before it lapses. */
  attackVoteWindow: duration(6 * HOUR),
  /** How long defenders have to organise before the battle resolves. */
  defenseWindow: duration(24 * HOUR),
  /** Immunity granted to a country that just survived an invasion. */
  successfulDefenseImmunity: duration(12 * HOUR),
  /** Immunity granted to a freshly activated country. */
  newCountryProtection: duration(48 * HOUR),
  /** Home-ground multiplier applied to defence power. */
  homeAdvantage: 1.2,
  /** Power is multiplied by a random factor in this inclusive range. */
  luckRange: {min: 0.9, max: 1.1},
  /** Supplies stop adding power past this fraction. */
  maxSupplyBonus: 0.5,
  /**
   * Divisor in the supply bonus: `(gold + food) / (divisor x troops)`, capped
   * at {@link maxSupplyBonus}. With the default of 2 the cap is reached at one
   * supply per troop, and anything past that adds no power while still being
   * at stake.
   */
  supplyRatioDivisor: 2,
} as const;

/**
 * A war is fought over many rounds rather than settled in one roll. Both
 * sides bleed every tick, weighted by what the enemy brought, until one of
 * them has nothing left on the field and must reinforce or give up.
 */
export const WAR = {
  /** How often an ongoing war exchanges blows. */
  tickInterval: duration(1 * HOUR),
  /** Share of a side's committed force lost per tick when evenly matched. */
  baseLossRate: 0.15,
  /** However lopsided a war is, a tick never costs less or more than this. */
  lossRateRange: {min: 0.05, max: 0.5},
  /**
   * How long a country has to approve reinforcements once its committed
   * force is spent. Saying nothing is surrender.
   */
  reinforcementWindow: duration(6 * HOUR),
} as const;

export const GAME = {
  /** How often the sweeper resolves expired votes, windows, and protections. */
  sweeperInterval: duration(30 * SECOND),
} as const;

export const DISCORD_LIMITS = {
  /** Discord's hard cap on channels in a category; archives count towards it. */
  channelsPerCategory: 50,
  /** Maximum components in one Components V2 message. */
  componentsPerMessage: 40,
  /** Maximum text characters in one Components V2 message. */
  charactersPerMessage: 4000,
  /** Maximum choices Discord will display for one autocomplete response. */
  autocompleteChoices: 25,
} as const;

export const CHANNELS = {
  /** Name of the public channel Conquest posts global events to. */
  gameLogName: 'war-room',
} as const;

/** Formats a duration for user-facing copy, e.g. `30 minutes` or `12 hours`. */
export function formatDuration(ms: number): string {
  const units: Array<[string, number]> = [
    ['day', 24 * HOUR],
    ['hour', HOUR],
    ['minute', MINUTE],
    ['second', SECOND],
  ];
  for (const [name, size] of units) {
    if (ms >= size) {
      const value = Math.round((ms / size) * 10) / 10;
      return `${value} ${value === 1 ? name : `${name}s`}`;
    }
  }
  return `${ms} ms`;
}
