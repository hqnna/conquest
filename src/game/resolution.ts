/**
 * War attrition: how a committed force becomes power, and what each round of
 * fighting costs both sides.
 *
 * A war is not settled in one roll. Both sides bleed every tick, weighted by
 * what the enemy brought to the field, until one of them has nothing left
 * standing and must reinforce or give up.
 *
 * Everything here is pure, with randomness injected, so a whole war can be
 * replayed exactly in a test.
 */
import {INVASIONS, WAR} from '../config/constants.js';
import type {Stake} from '../db/invasions.js';

/** Nothing committed at all. */
export const NO_STAKE: Stake = {troops: 0, gold: 0, food: 0};

/**
 * How much supplies add to a side's power, with diminishing returns.
 *
 * Gold and food are war supplies, worth up to +50% power. The cap is reached
 * at one supply per troop; past that they add nothing while still being lost
 * to the fighting, so overpacking is pure risk.
 */
export function supplyBonus(stake: Stake): number {
  if (stake.troops <= 0) return 0;
  const supplies = stake.gold + stake.food;
  const ratio = supplies / (INVASIONS.supplyRatioDivisor * stake.troops);
  return Math.min(ratio, INVASIONS.maxSupplyBonus);
}

/**
 * Rolls the luck multiplier applied to a single blow.
 *
 * @param random injected so tests can pin a war.
 */
export function rollLuck(random: () => number = Math.random): number {
  const {min, max} = INVASIONS.luckRange;
  return min + random() * (max - min);
}

/**
 * Power a force brings to the field.
 *
 * A side with no troops has no power, whatever it packed: supplies do not
 * fight, they only make troops fight harder.
 */
export function power(stake: Stake, homeAdvantage = 1): number {
  if (stake.troops <= 0) return 0;
  return stake.troops * (1 + supplyBonus(stake)) * homeAdvantage;
}

/**
 * The share of its force a side loses this tick.
 *
 * Losses scale with how badly it is outgunned: an even war costs both sides
 * the base rate, and being outmatched two to one costs twice that while the
 * stronger side pays half. The range is clamped at both ends, so no tick is
 * instantly fatal and no war grinds on forever.
 */
export function lossRate(ownPower: number, enemyPower: number): number {
  if (enemyPower <= 0) return 0;
  if (ownPower <= 0) return WAR.lossRateRange.max;
  const rate = WAR.baseLossRate * (enemyPower / ownPower);
  return Math.min(WAR.lossRateRange.max, Math.max(WAR.lossRateRange.min, rate));
}

/**
 * Takes a share of each resource, rounding up so a blow always costs
 * something, and never taking more than is there.
 *
 * @param luck three rolls, one per resource, so the losses read as separate
 *   events rather than one uniform tax.
 */
export function applyLosses(
  force: Stake,
  rate: number,
  luck: {troops: number; gold: number; food: number},
): {remaining: Stake; lost: Stake} {
  const take = (amount: number, roll: number): number =>
    amount <= 0 ? 0 : Math.min(amount, Math.ceil(amount * rate * roll));

  const lost: Stake = {
    troops: take(force.troops, luck.troops),
    gold: take(force.gold, luck.gold),
    food: take(force.food, luck.food),
  };
  return {
    remaining: {
      troops: force.troops - lost.troops,
      gold: force.gold - lost.gold,
      food: force.food - lost.food,
    },
    lost,
  };
}

/** What one round of fighting did to both sides. */
export interface WarTick {
  attackPower: number;
  defensePower: number;
  attackerLost: Stake;
  defenderLost: Stake;
  attackerRemaining: Stake;
  defenderRemaining: Stake;
  /** True once a side has no troops left standing. */
  attackerSpent: boolean;
  defenderSpent: boolean;
}

/**
 * Fights one round.
 *
 * Both sides' losses are computed from the same pre-tick state and applied
 * together, so neither gets to swing first. The defender fights with home
 * advantage, which is what makes attacking the harder job.
 *
 * A side is spent when its troops are gone: supplies left on the field cannot
 * hold ground, so that is the moment its country must reinforce or give up.
 */
export function fightRound(
  attack: Stake,
  defense: Stake,
  random: () => number = Math.random,
): WarTick {
  const attackPower = power(attack);
  const defensePower = power(defense, INVASIONS.homeAdvantage);

  const attackerRate = lossRate(attackPower, defensePower);
  const defenderRate = lossRate(defensePower, attackPower);

  const attacker = applyLosses(attack, attackerRate, {
    troops: rollLuck(random),
    gold: rollLuck(random),
    food: rollLuck(random),
  });
  const defender = applyLosses(defense, defenderRate, {
    troops: rollLuck(random),
    gold: rollLuck(random),
    food: rollLuck(random),
  });

  return {
    attackPower,
    defensePower,
    attackerLost: attacker.lost,
    defenderLost: defender.lost,
    attackerRemaining: attacker.remaining,
    defenderRemaining: defender.remaining,
    attackerSpent: attacker.remaining.troops <= 0,
    defenderSpent: defender.remaining.troops <= 0,
  };
}
