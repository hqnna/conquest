import {describe, expect, it} from 'vitest';
import {INVASIONS} from '../src/config/constants.js';
import type {Stake} from '../src/db/invasions.js';
import {
  NO_STAKE,
  power,
  resolveBattle,
  rollLuck,
  supplyBonus,
} from '../src/game/resolution.js';

const NEUTRAL = {attacker: 1, defender: 1};

function stake(troops: number, gold = 0, food = 0): Stake {
  return {troops, gold, food};
}

describe('supplyBonus', () => {
  it('is nothing without supplies', () => {
    expect(supplyBonus(stake(10))).toBe(0);
  });

  it('grows with supplies per troop', () => {
    expect(supplyBonus(stake(10, 2, 2))).toBeCloseTo(0.2, 5);
    expect(supplyBonus(stake(10, 5, 0))).toBeCloseTo(0.25, 5);
  });

  it('caps at the maximum, however much is packed', () => {
    expect(supplyBonus(stake(10, 10, 10))).toBe(INVASIONS.maxSupplyBonus);
    expect(supplyBonus(stake(10, 500, 500))).toBe(INVASIONS.maxSupplyBonus);
  });

  it('reaches the cap at one supply per troop', () => {
    expect(supplyBonus(stake(10, 10, 0))).toBe(INVASIONS.maxSupplyBonus);
    expect(supplyBonus(stake(10, 9, 0))).toBeLessThan(INVASIONS.maxSupplyBonus);
  });

  it('is nothing without troops to supply', () => {
    expect(supplyBonus(stake(0, 100, 100))).toBe(0);
  });
});

describe('power', () => {
  it('is troops when nothing else applies', () => {
    expect(power(stake(10), 1)).toBe(10);
  });

  it('is zero without troops, however many supplies', () => {
    expect(power(stake(0, 999, 999), 1)).toBe(0);
    expect(power(stake(0, 999, 999), 1, INVASIONS.homeAdvantage)).toBe(0);
  });

  it('applies the supply bonus, home advantage, and luck', () => {
    expect(power(stake(10, 10, 10), 1)).toBeCloseTo(15, 5);
    expect(power(stake(10), 1, INVASIONS.homeAdvantage)).toBeCloseTo(12, 5);
    expect(power(stake(10), 1.1)).toBeCloseTo(11, 5);
  });
});

describe('rollLuck', () => {
  it('stays inside the configured range', () => {
    expect(rollLuck(() => 0)).toBeCloseTo(INVASIONS.luckRange.min, 5);
    expect(rollLuck(() => 1)).toBeCloseTo(INVASIONS.luckRange.max, 5);
    for (let i = 0; i < 200; i++) {
      const luck = rollLuck();
      expect(luck).toBeGreaterThanOrEqual(INVASIONS.luckRange.min);
      expect(luck).toBeLessThanOrEqual(INVASIONS.luckRange.max);
    }
  });
});

describe('resolveBattle', () => {
  it('gives an undefended country to the attacker', () => {
    const outcome = resolveBattle(stake(1), NO_STAKE, NEUTRAL);
    expect(outcome.attackerWins).toBe(true);
    expect(outcome.defensePower).toBe(0);
  });

  it('cannot be won by supplies alone', () => {
    const outcome = resolveBattle(stake(0, 100, 100), stake(1), NEUTRAL);
    expect(outcome.attackerWins).toBe(false);
  });

  it('gives ties to the defender', () => {
    // Ten attacking troops against ten defending: home advantage breaks it.
    expect(resolveBattle(stake(10), stake(10), NEUTRAL).attackerWins).toBe(
      false,
    );
    // And an exact power tie resolves the same way.
    expect(resolveBattle(stake(12), stake(10), NEUTRAL).attackerWins).toBe(
      false,
    );
  });

  it('needs the attacker to out-power the home advantage', () => {
    expect(resolveBattle(stake(13), stake(10), NEUTRAL).attackerWins).toBe(
      true,
    );
  });

  it('lets supplies decide an otherwise even fight', () => {
    expect(resolveBattle(stake(12), stake(10), NEUTRAL).attackerWins).toBe(
      false,
    );
    expect(
      resolveBattle(stake(12, 12, 12), stake(10), NEUTRAL).attackerWins,
    ).toBe(true);
  });

  it('lets luck swing a close fight', () => {
    const stakes = [stake(12), stake(10)] as const;
    expect(
      resolveBattle(stakes[0], stakes[1], {attacker: 1.1, defender: 0.9})
        .attackerWins,
    ).toBe(true);
    expect(
      resolveBattle(stakes[0], stakes[1], {attacker: 0.9, defender: 1.1})
        .attackerWins,
    ).toBe(false);
  });

  describe('when the attacker wins', () => {
    const outcome = resolveBattle(stake(20, 5, 5), stake(4, 2, 2), NEUTRAL);

    it('sends home the survivors of half its army', () => {
      expect(outcome.attackerCasualties).toBe(10);
      expect(outcome.attackerReturns.troops).toBe(10);
    });

    it('consumes the supplies it marched with', () => {
      expect(outcome.attackerReturns.gold).toBe(0);
      expect(outcome.attackerReturns.food).toBe(0);
    });

    it('destroys the defence entirely', () => {
      expect(outcome.defenderCasualties).toBe(4);
      expect(outcome.defenderReturns).toEqual(NO_STAKE);
      expect(outcome.captured).toEqual(NO_STAKE);
    });

    it('rounds casualties up, so a fight always costs something', () => {
      expect(
        resolveBattle(stake(1), NO_STAKE, NEUTRAL).attackerCasualties,
      ).toBe(1);
      expect(
        resolveBattle(stake(3), NO_STAKE, NEUTRAL).attackerCasualties,
      ).toBe(2);
    });
  });

  describe('when the defender wins', () => {
    const outcome = resolveBattle(stake(10, 7, 3), stake(20, 4, 4), NEUTRAL);

    it('captures the attacker entire stake, troops included', () => {
      expect(outcome.captured).toEqual({troops: 10, gold: 7, food: 3});
      expect(outcome.attackerCasualties).toBe(10);
      expect(outcome.attackerReturns).toEqual(NO_STAKE);
    });

    it('loses less of its own army than an attacker would', () => {
      expect(outcome.defenderCasualties).toBe(6);
      expect(outcome.defenderReturns.troops).toBe(14);
    });

    it('keeps the supplies it never had to spend', () => {
      expect(outcome.defenderReturns.gold).toBe(4);
      expect(outcome.defenderReturns.food).toBe(4);
    });

    it('rounds its casualties up too', () => {
      expect(
        resolveBattle(stake(1), stake(10), NEUTRAL).defenderCasualties,
      ).toBe(3);
    });
  });

  it('never returns or captures more than was staked', () => {
    for (let troops = 0; troops <= 30; troops++) {
      const attack = stake(troops, troops, troops);
      const defense = stake(30 - troops, 5, 5);
      const outcome = resolveBattle(attack, defense, NEUTRAL);
      expect(outcome.attackerReturns.troops).toBeLessThanOrEqual(attack.troops);
      expect(outcome.defenderReturns.troops).toBeLessThanOrEqual(
        defense.troops,
      );
      expect(outcome.captured.troops).toBeLessThanOrEqual(attack.troops);
      expect(outcome.attackerCasualties).toBeGreaterThanOrEqual(0);
      expect(outcome.defenderCasualties).toBeGreaterThanOrEqual(0);
    }
  });
});
