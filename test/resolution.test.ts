import {describe, expect, it} from 'vitest';
import {INVASIONS, WAR} from '../src/config/constants.js';
import {defaultSettings} from '../src/config/settings.js';
import type {Stake} from '../src/db/invasions.js';
import {
  applyLosses,
  fightRound,
  lossRate,
  power,
  rollLuck,
  supplyBonus,
} from '../src/game/resolution.js';

function stake(troops: number, gold = 0, food = 0): Stake {
  return {troops, gold, food};
}

/** A guild that has changed nothing, so the shipped numbers apply. */
const settings = defaultSettings();

/** Luck pinned to the middle of its range, so only weights matter. */
const evenLuck = () => 0.5;

describe('supplyBonus', () => {
  it('is nothing without supplies', () => {
    expect(supplyBonus(stake(10), settings)).toBe(0);
  });

  it('grows with supplies per troop', () => {
    expect(supplyBonus(stake(10, 2, 2), settings)).toBeCloseTo(0.2, 5);
    expect(supplyBonus(stake(10, 5, 0), settings)).toBeCloseTo(0.25, 5);
  });

  it('reaches the cap at one supply per troop', () => {
    expect(supplyBonus(stake(10, 10, 0), settings)).toBe(
      INVASIONS.maxSupplyBonus,
    );
    expect(supplyBonus(stake(10, 9, 0), settings)).toBeLessThan(
      INVASIONS.maxSupplyBonus,
    );
  });

  it('caps however much is packed', () => {
    expect(supplyBonus(stake(10, 500, 500), settings)).toBe(
      INVASIONS.maxSupplyBonus,
    );
  });

  it('is nothing without troops to supply', () => {
    expect(supplyBonus(stake(0, 100, 100), settings)).toBe(0);
  });
});

describe('power', () => {
  it('is troops when nothing else applies', () => {
    expect(power(stake(10), settings)).toBe(10);
  });

  it('is zero without troops, however many supplies', () => {
    expect(power(stake(0, 999, 999), settings)).toBe(0);
    expect(power(stake(0, 999, 999), settings, INVASIONS.homeAdvantage)).toBe(
      0,
    );
  });

  it('applies the supply bonus and home advantage', () => {
    expect(power(stake(10, 10, 10), settings)).toBeCloseTo(15, 5);
    expect(power(stake(10), settings, INVASIONS.homeAdvantage)).toBeCloseTo(
      12,
      5,
    );
  });
});

describe('lossRate', () => {
  it('costs both sides the base rate in an even war', () => {
    expect(lossRate(10, 10, settings)).toBeCloseTo(WAR.baseLossRate, 5);
  });

  it('bleeds the outmatched side faster and the stronger one slower', () => {
    expect(lossRate(10, 20, settings)).toBeGreaterThan(
      lossRate(10, 10, settings),
    );
    expect(lossRate(20, 10, settings)).toBeLessThan(lossRate(10, 10, settings));
  });

  it('never exceeds the clamp, however lopsided', () => {
    expect(lossRate(1, 10_000, settings)).toBe(WAR.lossRateRange.max);
    expect(lossRate(10_000, 1, settings)).toBe(WAR.lossRateRange.min);
  });

  it('costs nothing when nobody is left to fight you', () => {
    expect(lossRate(10, 0, settings)).toBe(0);
  });

  it('is maximal for a side with no power left', () => {
    expect(lossRate(0, 10, settings)).toBe(WAR.lossRateRange.max);
  });
});

describe('applyLosses', () => {
  const luck = {troops: 1, gold: 1, food: 1};

  it('takes a share of every committed resource', () => {
    const {remaining, lost} = applyLosses(stake(100, 50, 20), 0.1, luck);
    expect(lost).toEqual({troops: 10, gold: 5, food: 2});
    expect(remaining).toEqual({troops: 90, gold: 45, food: 18});
  });

  it('rounds up, so a blow always costs something', () => {
    const {lost} = applyLosses(stake(1, 1, 1), 0.01, luck);
    expect(lost).toEqual({troops: 1, gold: 1, food: 1});
  });

  it('never takes more than is there', () => {
    const {remaining, lost} = applyLosses(stake(3), 0.9, {
      troops: 1.1,
      gold: 1,
      food: 1,
    });
    expect(lost.troops).toBe(3);
    expect(remaining.troops).toBe(0);
  });

  it('leaves an empty resource alone', () => {
    const {lost} = applyLosses(stake(10, 0, 0), 0.5, luck);
    expect(lost.gold).toBe(0);
    expect(lost.food).toBe(0);
  });

  it('rolls each resource separately', () => {
    const {lost} = applyLosses(stake(100, 100, 100), 0.1, {
      troops: 0.9,
      gold: 1,
      food: 1.1,
    });
    expect(lost.troops).toBeLessThan(lost.gold);
    expect(lost.gold).toBeLessThan(lost.food);
  });
});

describe('rollLuck', () => {
  it('stays inside the configured range', () => {
    expect(rollLuck(settings, () => 0)).toBeCloseTo(INVASIONS.luckRange.min, 5);
    expect(rollLuck(settings, () => 1)).toBeCloseTo(INVASIONS.luckRange.max, 5);
  });
});

describe('fightRound', () => {
  it('costs both sides something', () => {
    const tick = fightRound(stake(50), stake(50), settings, evenLuck);
    expect(tick.attackerLost.troops).toBeGreaterThan(0);
    expect(tick.defenderLost.troops).toBeGreaterThan(0);
  });

  it('makes the defender the harder side to grind down', () => {
    const tick = fightRound(stake(50), stake(50), settings, evenLuck);
    expect(tick.defensePower).toBeGreaterThan(tick.attackPower);
    expect(tick.attackerLost.troops).toBeGreaterThan(tick.defenderLost.troops);
  });

  it('lets a much larger force grind a small one down faster', () => {
    const tick = fightRound(stake(200), stake(10), settings, evenLuck);
    expect(tick.defenderLost.troops / 10).toBeGreaterThan(
      tick.attackerLost.troops / 200,
    );
  });

  it('lets supplies swing the exchange', () => {
    const plain = fightRound(stake(50), stake(50), settings, evenLuck);
    const supplied = fightRound(
      stake(50, 25, 25),
      stake(50),
      settings,
      evenLuck,
    );
    expect(supplied.defenderLost.troops).toBeGreaterThan(
      plain.defenderLost.troops,
    );
  });

  it('marks a side spent when its troops are gone', () => {
    const tick = fightRound(stake(1), stake(500), settings, evenLuck);
    expect(tick.attackerSpent).toBe(true);
    expect(tick.attackerRemaining.troops).toBe(0);
  });

  it('does not mark a side spent while it still has troops', () => {
    const tick = fightRound(stake(500), stake(500), settings, evenLuck);
    expect(tick.attackerSpent).toBe(false);
    expect(tick.defenderSpent).toBe(false);
  });

  it('computes both sides from the same pre-tick state', () => {
    // The attacker's losses must not depend on the defender's already being
    // applied, so a mutual wipe-out is possible.
    const tick = fightRound(stake(1), stake(1), settings, evenLuck);
    expect(tick.attackerSpent).toBe(true);
    expect(tick.defenderSpent).toBe(true);
  });

  it('takes nothing from a side nobody is fighting', () => {
    const tick = fightRound(stake(50), stake(0), settings, evenLuck);
    expect(tick.attackerLost).toEqual({troops: 0, gold: 0, food: 0});
    expect(tick.defenderSpent).toBe(true);
  });

  it('always terminates: every war grinds someone down', () => {
    let attack = stake(80, 40, 40);
    let defense = stake(60, 30, 30);
    let rounds = 0;
    while (attack.troops > 0 && defense.troops > 0 && rounds < 1_000) {
      const tick = fightRound(attack, defense, settings, evenLuck);
      attack = tick.attackerRemaining;
      defense = tick.defenderRemaining;
      rounds++;
    }
    expect(rounds).toBeLessThan(1_000);
    expect(Math.min(attack.troops, defense.troops)).toBe(0);
  });

  it('never returns more than was committed', () => {
    for (let troops = 0; troops <= 40; troops++) {
      const tick = fightRound(
        stake(troops, 5, 5),
        stake(40 - troops, 5, 5),
        settings,
      );
      expect(tick.attackerRemaining.troops).toBeLessThanOrEqual(troops);
      expect(tick.defenderRemaining.troops).toBeLessThanOrEqual(40 - troops);
      expect(tick.attackerRemaining.troops).toBeGreaterThanOrEqual(0);
      expect(tick.defenderRemaining.troops).toBeGreaterThanOrEqual(0);
    }
  });
});
