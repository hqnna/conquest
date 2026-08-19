import {describe, expect, it} from 'vitest';
import {
  COUNTRY_PALETTE,
  INACTIVE_COLOR,
  countryColor,
} from '../src/game/colors.js';
import {
  MAP_REGIONS,
  WORLD_MAP,
  fillFor,
  paint,
  stylesheet,
  viewBoxFor,
} from '../src/map/stylesheet.js';
import type {MapCountry} from '../src/map/stylesheet.js';

function active(code: string, atWar = false): MapCountry {
  return {code, ownerCode: null, status: 'active', atWar};
}

function territory(code: string, ownerCode: string): MapCountry {
  return {code, ownerCode, status: 'defeated', atWar: false};
}

/** The shipped base SVG, as the renderer loads it. */
const BASE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 620" width="1200" height="620">\n' +
  '<style id="conquest-colors"></style>\n<rect id="ocean"/>\n<g id="countries">\n' +
  '<path id="FR" d="M0 0"/>\n<path id="DE" d="M0 0"/>\n</g>\n</svg>';

describe('the shipped map', () => {
  it('covers the great majority of the world', () => {
    expect(WORLD_MAP.codes.length).toBeGreaterThan(200);
    expect(WORLD_MAP.width).toBeGreaterThan(0);
    expect(WORLD_MAP.height).toBeGreaterThan(0);
  });

  it('uses the same ISO codes as the rest of the game', () => {
    for (const code of ['FR', 'DE', 'JP', 'BR', 'ZA']) {
      expect(WORLD_MAP.codes).toContain(code);
    }
    for (const code of WORLD_MAP.codes) {
      expect(code).toMatch(/^[A-Z]{2}$/);
    }
  });

  it('offers a box for every continent it names', () => {
    expect(MAP_REGIONS.length).toBeGreaterThan(3);
    for (const region of MAP_REGIONS) {
      const box = WORLD_MAP.regions[region];
      expect(box).toHaveLength(4);
      expect(box[2]).toBeGreaterThan(0);
      expect(box[3]).toBeGreaterThan(0);
      expect(box[0] + box[2]).toBeLessThanOrEqual(WORLD_MAP.width);
      expect(box[1] + box[3]).toBeLessThanOrEqual(WORLD_MAP.height);
    }
  });

  it('crops a continent to less than the whole world', () => {
    const europe = WORLD_MAP.regions['Europe'];
    expect(europe[2]).toBeLessThan(WORLD_MAP.width);
    expect(europe[3]).toBeLessThan(WORLD_MAP.height);
  });
});

describe('fillFor', () => {
  it('gives an active country its own stable colour', () => {
    expect(fillFor(active('FR'))).toBe(countryColor('FR'));
  });

  it('draws a territory as a darker shade of its owner', () => {
    const owner = countryColor('FR');
    const held = fillFor(territory('DE', 'FR'));
    expect(held).not.toBe(owner);
    expect(COUNTRY_PALETTE).not.toContain(held);
    // Same hue family, simply dimmer: every channel is reduced.
    expect(held >> 16).toBeLessThanOrEqual(owner >> 16);
    expect(held & 0xff).toBeLessThanOrEqual(owner & 0xff);
  });

  it('draws an ownerless conquest as unclaimed', () => {
    expect(
      fillFor({code: 'DE', ownerCode: null, status: 'defeated', atWar: false}),
    ).toBe(INACTIVE_COLOR);
  });

  it('gives two countries of one empire the same shade', () => {
    expect(fillFor(territory('DE', 'FR'))).toBe(fillFor(territory('BE', 'FR')));
  });
});

describe('stylesheet', () => {
  it('defaults the world to unclaimed grey', () => {
    const css = stylesheet({countries: []});
    expect(css).toContain(`fill:#${INACTIVE_COLOR.toString(16)}`);
  });

  it('keeps the default less specific than a country rule', () => {
    // `#countries path` would outrank `#FR` and leave the world grey.
    const css = stylesheet({countries: [active('FR')]});
    expect(css).toContain('path{fill:');
    expect(css).not.toContain('#countries path{');
    expect(css).toContain('#FR{fill:');
  });

  it('writes one rule per country in play, and no more', () => {
    const css = stylesheet({countries: [active('FR'), territory('DE', 'FR')]});
    expect(css).toContain('#FR{');
    expect(css).toContain('#DE{');
    expect(css).not.toContain('#JP{');
  });

  it('strokes the countries at war in red', () => {
    const css = stylesheet({countries: [active('FR', true), active('JP')]});
    expect(css).toMatch(/#FR\{stroke:#ff3b30/);
    expect(css).not.toMatch(/#JP\{stroke:#ff3b30/);
  });

  it('says nothing about war when nobody is fighting', () => {
    expect(stylesheet({countries: [active('FR')]})).not.toContain('#ff3b30');
  });

  it('ignores countries the map cannot draw', () => {
    const css = stylesheet({countries: [active('ZZ')]});
    expect(css).not.toContain('#ZZ');
  });

  it('is deterministic, so an unchanged world renders identically', () => {
    const state = {countries: [active('FR', true), territory('DE', 'FR')]};
    expect(stylesheet(state)).toBe(stylesheet(state));
  });
});

describe('viewBoxFor', () => {
  it('shows the whole world by default', () => {
    expect(viewBoxFor({countries: []})).toBe(
      `0 0 ${WORLD_MAP.width} ${WORLD_MAP.height}`,
    );
  });

  it('crops to a named continent', () => {
    expect(viewBoxFor({countries: [], region: 'Europe'})).toBe(
      WORLD_MAP.regions['Europe'].join(' '),
    );
  });

  it('falls back to the world for a region it does not know', () => {
    expect(viewBoxFor({countries: [], region: 'Atlantis'})).toBe(
      `0 0 ${WORLD_MAP.width} ${WORLD_MAP.height}`,
    );
  });
});

describe('paint', () => {
  it('injects the stylesheet without touching the geometry', () => {
    const painted = paint(BASE, {countries: [active('FR')]});
    expect(painted).toContain('#FR{fill:');
    expect(painted).toContain('<path id="FR" d="M0 0"/>');
    expect(painted).toContain('<path id="DE" d="M0 0"/>');
  });

  it('leaves the canvas alone for the whole world', () => {
    const painted = paint(BASE, {countries: []});
    expect(painted).toContain('viewBox="0 0 1200 620"');
    expect(painted).toContain('width="1200"');
    expect(painted).toContain('height="620"');
  });

  it('matches the canvas to a crop, so it is not letterboxed', () => {
    const painted = paint(BASE, {countries: [], region: 'Europe'});
    const [, , width, height] = WORLD_MAP.regions['Europe'];
    expect(painted).toContain(
      `viewBox="${WORLD_MAP.regions['Europe'].join(' ')}"`,
    );
    expect(painted).toContain(`width="${width}"`);
    expect(painted).toContain(`height="${height}"`);
  });

  it('produces valid, self-contained SVG', () => {
    const painted = paint(BASE, {countries: [active('FR', true)]});
    expect(painted.startsWith('<svg')).toBe(true);
    expect(painted.trim().endsWith('</svg>')).toBe(true);
    expect(painted).not.toContain('conquest-colors"></style>');
  });
});
