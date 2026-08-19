import {describe, expect, it} from 'vitest';
import {MapCache, mapCacheKey} from '../src/map/cache.js';
import type {MapCountry, MapState} from '../src/map/stylesheet.js';

function state(countries: MapCountry[], region?: string): MapState {
  return {countries, region};
}

const FR: MapCountry = {
  code: 'FR',
  ownerCode: null,
  status: 'active',
  atWar: false,
};

describe('mapCacheKey', () => {
  it('is the same for the same world', () => {
    expect(mapCacheKey(state([FR]), 800)).toBe(mapCacheKey(state([FR]), 800));
  });

  it('does not depend on the order countries come out of the database', () => {
    const a = state([FR, {...FR, code: 'DE'}]);
    const b = state([{...FR, code: 'DE'}, FR]);
    expect(mapCacheKey(a, 800)).toBe(mapCacheKey(b, 800));
  });

  it('changes when a country is conquered', () => {
    const before = mapCacheKey(state([FR, {...FR, code: 'DE'}]), 800);
    const after = mapCacheKey(
      state([
        FR,
        {code: 'DE', ownerCode: 'FR', status: 'defeated', atWar: false},
      ]),
      800,
    );
    expect(after).not.toBe(before);
  });

  it('changes when a war starts or ends', () => {
    expect(mapCacheKey(state([{...FR, atWar: true}]), 800)).not.toBe(
      mapCacheKey(state([FR]), 800),
    );
  });

  it('changes when a country joins the world', () => {
    expect(mapCacheKey(state([FR, {...FR, code: 'JP'}]), 800)).not.toBe(
      mapCacheKey(state([FR]), 800),
    );
  });

  it('separates crops from the whole world, and from each other', () => {
    const world = mapCacheKey(state([FR]), 800);
    const europe = mapCacheKey(state([FR], 'Europe'), 800);
    const asia = mapCacheKey(state([FR], 'Asia'), 800);
    expect(new Set([world, europe, asia]).size).toBe(3);
  });

  it('separates renders at different widths', () => {
    expect(mapCacheKey(state([FR]), 800)).not.toBe(
      mapCacheKey(state([FR]), 1400),
    );
  });
});

describe('MapCache', () => {
  const png = (byte: number) => Buffer.from([byte]);

  it('returns what it was given', () => {
    const cache = new MapCache();
    cache.set('a', png(1));
    expect(cache.get('a')).toEqual(png(1));
    expect(cache.get('missing')).toBeUndefined();
  });

  it('replaces rather than duplicating a key', () => {
    const cache = new MapCache();
    cache.set('a', png(1));
    cache.set('a', png(2));
    expect(cache.size).toBe(1);
    expect(cache.get('a')).toEqual(png(2));
  });

  it('evicts what was used longest ago', () => {
    const cache = new MapCache(2);
    cache.set('a', png(1));
    cache.set('b', png(2));
    // Touching 'a' makes 'b' the stale one.
    cache.get('a');
    cache.set('c', png(3));

    expect(cache.size).toBe(2);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toEqual(png(1));
    expect(cache.get('c')).toEqual(png(3));
  });

  it('never grows past its capacity', () => {
    const cache = new MapCache(3);
    for (let i = 0; i < 50; i++) cache.set(`key-${i}`, png(i));
    expect(cache.size).toBe(3);
  });

  it('forgets everything when a round is wiped', () => {
    const cache = new MapCache();
    cache.set('a', png(1));
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get('a')).toBeUndefined();
  });
});
