/**
 * Battle resolution: how a stake becomes power, who wins, and what it costs
 * them.
 *
 * Every number here comes from the tunables module, and every function is
 * pure — randomness is injected — so a battle can be replayed exactly in a
 * test.
 */
import {INVASIONS} from '../config/constants.js';
import type {Stake} from '../db/invasions.js';

/** An empty stake, used for a country that mounted no defence at all. */
export const NO_STAKE: Stake = {troops: 0, gold: 0, food: 0};

/**
 * How much supplies add to a side's power, with diminishing returns.
 *
 * Gold and food are war supplies, worth up to +50% power. The cap is reached
 * at one supply per troop; past that they add nothing while still being lost
 * with the rest of the stake, so overpacking is pure risk.
 */
export function supplyBonus(stake: Stake): number {
  if (stake.troops <= 0) return 0;
  const supplies = stake.gold + stake.food;
  const ratio = supplies / (INVASIONS.supplyRatioDivisor * stake.troops);
  return Math.min(ratio, INVASIONS.maxSupplyBonus);
}

/**
 * Rolls the luck multiplier applied to both sides.
 *
 * @param random injected so tests can pin a battle.
 */
export function rollLuck(random: () => number = Math.random): number {
  const {min, max} = INVASIONS.luckRange;
  return min + random() * (max - min);
}

/**
 * Power a stake brings to the field.
 *
 * A side with no troops has no power, whatever it packed: supplies do not
 * fight.
 */
export function power(stake: Stake, luck: number, homeAdvantage = 1): number {
  if (stake.troops <= 0) return 0;
  return stake.troops * (1 + supplyBonus(stake)) * homeAdvantage * luck;
}

/** What the fighting cost and produced. */
export interface BattleOutcome {
  attackerWins: boolean;
  attackPower: number;
  defensePower: number;
  /** Troops the attacker lost. */
  attackerCasualties: number;
  /** Troops the defender lost. */
  defenderCasualties: number;
  /** Returned to the attacker's stockpile. */
  attackerReturns: Stake;
  /** Returned to the defender's stockpile. */
  defenderReturns: Stake;
  /** Taken from the attacker's stake by a victorious defender. */
  captured: Stake;
}

/** Losses, rounded up: a fight always costs somebody. */
function casualties(troops: number, rate: number): number {
  return Math.ceil(troops * rate);
}

/**
 * Resolves a battle.
 *
 * Ties go to the defender — holding ground is the easier job.
 *
 * On an attacker's win the surviving attackers march home while their
 * supplies are consumed by the campaign, and the defender's committed stake
 * is destroyed in the fighting. On a defender's win the attacker's entire
 * stake changes hands, troops included: they are captured, not killed, which
 * is what makes an overreaching invasion so dangerous.
 */
export function resolveBattle(
  attack: Stake,
  defense: Stake,
  luck: {attacker: number; defender: number},
): BattleOutcome {
  const attackPower = power(attack, luck.attacker);
  const defensePower = power(defense, luck.defender, INVASIONS.homeAdvantage);
  const attackerWins = attackPower > defensePower;

  if (attackerWins) {
    const lost = casualties(attack.troops, INVASIONS.attackerCasualtyRate);
    return {
      attackerWins,
      attackPower,
      defensePower,
      attackerCasualties: lost,
      defenderCasualties: defense.troops,
      // Supplies are consumed by the campaign; the survivors come home.
      attackerReturns: {troops: attack.troops - lost, gold: 0, food: 0},
      defenderReturns: NO_STAKE,
      captured: NO_STAKE,
    };
  }

  const lost = casualties(defense.troops, INVASIONS.defenderCasualtyRate);
  return {
    attackerWins,
    attackPower,
    defensePower,
    attackerCasualties: attack.troops,
    defenderCasualties: lost,
    attackerReturns: NO_STAKE,
    defenderReturns: {
      troops: defense.troops - lost,
      gold: defense.gold,
      food: defense.food,
    },
    captured: {troops: attack.troops, gold: attack.gold, food: attack.food},
  };
}
