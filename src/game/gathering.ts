/**
 * Gathering: what `/farm`, `/mine`, and `/recruit` yield, when a player may
 * run them, and applying the result.
 */
import type {Settings} from '../config/settings.js';
import type {GatherCommand} from '../db/cooldowns.js';
import {getCooldown, setCooldown} from '../db/cooldowns.js';
import type {Database} from '../db/index.js';
import {settingsFor} from '../db/guild-settings.js';
import {addResources, getStockpile, spendResources} from '../db/resources.js';
import type {ResourceDelta, Stockpile} from '../db/resources.js';

/** An inclusive range of whole numbers. */
export interface Range {
  min: number;
  max: number;
}

/**
 * Rolls a yield.
 *
 * @param random source of randomness, injected so tests can pin the roll.
 */
export function rollYield(
  range: Range,
  random: () => number = Math.random,
): number {
  return range.min + Math.floor(random() * (range.max - range.min + 1));
}

/** What one gather command costs and produces. */
export interface GatherRules {
  /** Per-player cooldown started on success. */
  cooldown: number;
  /** Taken from the country's pool; empty for the free gather commands. */
  cost: ResourceDelta;
  /** Which resource the roll produces. */
  produces: keyof Stockpile;
  /** Range the produced amount is rolled from. */
  yield: Range;
}

/** The rules for each gather command, as this guild has tuned them. */
export function gatherRules(
  settings: Settings,
): Readonly<Record<GatherCommand, GatherRules>> {
  return {
    farm: {
      cooldown: settings.cooldowns.farm,
      cost: {},
      produces: 'food',
      yield: settings.resources.farmYield,
    },
    mine: {
      cooldown: settings.cooldowns.mine,
      cost: {},
      produces: 'gold',
      yield: settings.resources.mineYield,
    },
    recruit: {
      cooldown: settings.cooldowns.recruit,
      cost: {
        gold: settings.resources.recruitCost.gold,
        food: settings.resources.recruitCost.food,
      },
      produces: 'troops',
      yield: settings.resources.recruitYield,
    },
  };
}

/** Why Conquest turned a gather command down. */
export type GatherRefusal =
  | {kind: 'not_configured'}
  | {kind: 'not_in_country'}
  | {kind: 'cooldown'; until: number}
  | {kind: 'insufficient'; short: ResourceDelta};

/** Whether a gather command may run. */
export type GatherDecision = {ok: true} | {ok: false; refusal: GatherRefusal};

/** How much of a cost a stockpile cannot cover. */
export function shortfall(
  stockpile: Stockpile,
  cost: ResourceDelta,
): ResourceDelta {
  const short: ResourceDelta = {};
  for (const resource of ['food', 'gold', 'troops'] as const) {
    const missing = (cost[resource] ?? 0) - stockpile[resource];
    if (missing > 0) short[resource] = missing;
  }
  return short;
}

/**
 * Decides whether a player may gather right now.
 *
 * The cooldown is checked before the cost, so a player who is on cooldown and
 * broke is told about the cooldown — the thing they have to wait for either
 * way.
 */
export function decideGather(input: {
  configured: boolean;
  countryCode: string | null | undefined;
  stockpile: Stockpile | undefined;
  command: GatherCommand;
  cooldownUntil: number | null;
  settings: Settings;
  now: number;
}): GatherDecision {
  if (!input.configured) return {ok: false, refusal: {kind: 'not_configured'}};
  if (!input.countryCode || !input.stockpile) {
    return {ok: false, refusal: {kind: 'not_in_country'}};
  }
  if (input.cooldownUntil !== null && input.cooldownUntil > input.now) {
    return {ok: false, refusal: {kind: 'cooldown', until: input.cooldownUntil}};
  }

  const short = shortfall(
    input.stockpile,
    gatherRules(input.settings)[input.command].cost,
  );
  if (Object.keys(short).length > 0) {
    return {ok: false, refusal: {kind: 'insufficient', short}};
  }
  return {ok: true};
}

/** What a successful gather produced. */
export interface GatherResult {
  command: GatherCommand;
  /** Resource produced. */
  resource: keyof Stockpile;
  /** How much of it. */
  amount: number;
  /** What it cost the country. */
  cost: ResourceDelta;
  /** The country's pool afterwards. */
  stockpile: Stockpile;
  /** When the player may run this command again. */
  nextAvailableAt: number;
}

/**
 * Runs a gather command: rolls the yield, pays any cost, banks the result, and
 * starts the cooldown — all in one transaction.
 *
 * Everything is re-checked inside that transaction, so a cooldown cannot be
 * dodged and a country cannot spend gold it no longer has, however two
 * commands interleave.
 *
 * @returns the result, or the refusal that stopped it.
 */
export function gather(
  db: Database,
  input: {
    guildId: string;
    userId: string;
    code: string;
    command: GatherCommand;
    now: number;
    random?: () => number;
  },
): {ok: true; result: GatherResult} | {ok: false; refusal: GatherRefusal} {
  const rules = gatherRules(settingsFor(db, input.guildId))[input.command];
  const amount = rollYield(rules.yield, input.random);

  return db.transaction(() => {
    const cooldownUntil = getCooldown(
      db,
      input.guildId,
      input.userId,
      input.command,
    );
    if (cooldownUntil !== null && cooldownUntil > input.now) {
      return {
        ok: false as const,
        refusal: {kind: 'cooldown' as const, until: cooldownUntil},
      };
    }

    if (Object.keys(rules.cost).length > 0) {
      const paid = spendResources(db, input.guildId, input.code, rules.cost);
      if (!paid) {
        const stockpile = getStockpile(db, input.guildId, input.code);
        return {
          ok: false as const,
          refusal: {
            kind: 'insufficient' as const,
            short: stockpile ? shortfall(stockpile, rules.cost) : rules.cost,
          },
        };
      }
    }

    addResources(db, input.guildId, input.code, {[rules.produces]: amount});
    const nextAvailableAt = input.now + rules.cooldown;
    setCooldown(
      db,
      input.guildId,
      input.userId,
      input.command,
      nextAvailableAt,
    );

    return {
      ok: true as const,
      result: {
        command: input.command,
        resource: rules.produces,
        amount,
        cost: rules.cost,
        stockpile: getStockpile(db, input.guildId, input.code)!,
        nextAvailableAt,
      },
    };
  })();
}
