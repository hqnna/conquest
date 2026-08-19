import {describe, expect, it} from 'vitest';
import {
  COOLDOWNS,
  DISCORD_LIMITS,
  GAME,
  INVASIONS,
  RESOURCES,
  WAR,
  formatDuration,
} from '../src/config/constants.js';

describe('constants', () => {
  it('matches the documented gameplay defaults', () => {
    expect(RESOURCES.farmYield).toEqual({min: 8, max: 15});
    expect(RESOURCES.recruitCost).toEqual({gold: 10, food: 10});
    expect(COOLDOWNS.farm).toBe(30 * 60 * 1000);
    expect(COOLDOWNS.recruit).toBe(60 * 60 * 1000);
    expect(COOLDOWNS.rejoin).toBe(24 * 60 * 60 * 1000);
    expect(INVASIONS.defenseWindow).toBe(24 * 60 * 60 * 1000);
    expect(INVASIONS.newCountryProtection).toBe(48 * 60 * 60 * 1000);
    expect(GAME.defaultDominationThreshold).toBe(10);
    expect(DISCORD_LIMITS.channelsPerCategory).toBe(50);
  });

  it('keeps yield ranges and cooldowns sane', () => {
    for (const range of [
      RESOURCES.farmYield,
      RESOURCES.mineYield,
      RESOURCES.recruitYield,
      INVASIONS.luckRange,
    ]) {
      expect(range.min).toBeLessThanOrEqual(range.max);
      expect(range.min).toBeGreaterThan(0);
    }
    for (const cooldown of Object.values(COOLDOWNS)) {
      expect(cooldown).toBeGreaterThan(0);
    }
  });

  it('keeps loss rates and the supply cap as fractions', () => {
    for (const rate of [
      WAR.baseLossRate,
      WAR.lossRateRange.min,
      WAR.lossRateRange.max,
      INVASIONS.maxSupplyBonus,
    ]) {
      expect(rate).toBeGreaterThan(0);
      expect(rate).toBeLessThanOrEqual(1);
    }
  });

  it('keeps every war tick survivable and every war finite', () => {
    expect(WAR.lossRateRange.min).toBeLessThan(WAR.lossRateRange.max);
    expect(WAR.baseLossRate).toBeGreaterThanOrEqual(WAR.lossRateRange.min);
    expect(WAR.baseLossRate).toBeLessThanOrEqual(WAR.lossRateRange.max);
    expect(WAR.tickInterval).toBeGreaterThan(0);
    expect(WAR.reinforcementWindow).toBeGreaterThan(0);
  });
});

describe('formatDuration', () => {
  it('picks the largest fitting unit', () => {
    expect(formatDuration(24 * 60 * 60 * 1000)).toBe('1 day');
    expect(formatDuration(12 * 60 * 60 * 1000)).toBe('12 hours');
    expect(formatDuration(30 * 60 * 1000)).toBe('30 minutes');
    expect(formatDuration(30 * 1000)).toBe('30 seconds');
  });

  it('singularises a lone unit', () => {
    expect(formatDuration(60 * 60 * 1000)).toBe('1 hour');
    expect(formatDuration(60 * 1000)).toBe('1 minute');
  });
});
