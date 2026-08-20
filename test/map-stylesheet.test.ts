import {describe, expect, it} from 'vitest';
import {COUNTRIES} from '../src/data/countries.js';
import {
  COUNTRY_PALETTE,
  INACTIVE_COLOR,
  OCEAN_COLOR,
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

/** WCAG relative luminance, for judging how a colour reads against another. */
function luminance(color: number): number {
  const channel = (shift: number) => {
    const value = ((color >> shift) & 0xff) / 255;
    return value <= 0.03928
      ? value / 12.92
      : Math.pow((value + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
}

/** WCAG contrast ratio, for judging whether two colours read apart. */
function contrast(a: number, b: number): number {
  const high = Math.max(luminance(a), luminance(b));
  const low = Math.min(luminance(a), luminance(b));
  return (high + 0.05) / (low + 0.05);
}

/** The channels of a colour, so a shade can be placed between two others. */
function channels(color: number): number[] {
  return [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff];
}

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
    expect(luminance(held)).toBeLessThan(luminance(owner));
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

describe('a conquered country reads as its new owner', () => {
  // The whole palette, not one colour: the shade used to be a slide towards
  // black, which held for the mid-tones and quietly failed everywhere else —
  // a pale owner's territory turned muddy grey and a dark owner's sank into
  // the sea, so a conquest looked like nobody owned the ground.

  /** A country whose colour is the given palette entry, for each entry. */
  const owners = new Map<number, string>();
  for (const country of COUNTRIES) {
    const color = countryColor(country.code);
    if (!owners.has(color)) owners.set(color, country.code);
  }

  /** How a country held by an owner of this colour is drawn. */
  function shadeOf(color: number): number {
    return fillFor(territory('DE', owners.get(color)!));
  }

  /** Every palette colour, named so a failure says which empire broke. */
  const empires = COUNTRY_PALETTE.map(color => ({
    color,
    name: `#${color.toString(16).padStart(6, '0')}`,
  }));

  it('has a real owner for every colour in the palette', () => {
    expect(owners.size).toBe(COUNTRY_PALETTE.length);
  });

  it.each(empires)('keeps most of $name brightness', ({color}) => {
    // A slide towards black left barely a quarter of it, which is what made
    // the darker half of the palette unreadable.
    expect(luminance(shadeOf(color))).toBeGreaterThanOrEqual(
      0.35 * luminance(color),
    );
  });

  it.each(empires)('draws $name dimmer than its capital', ({color}) => {
    expect(luminance(shadeOf(color))).toBeLessThanOrEqual(luminance(color));
  });

  it.each(empires)('mixes $name with the sea, not black', ({color}) => {
    // Every channel sits between the owner's and the water's, which is what
    // stops a colour being drained of the hue that identifies it.
    const held = channels(shadeOf(color));
    const owner = channels(color);
    const sea = channels(OCEAN_COLOR);
    for (const index of [0, 1, 2]) {
      expect(held[index]).toBeGreaterThanOrEqual(
        Math.min(owner[index], sea[index]),
      );
      expect(held[index]).toBeLessThanOrEqual(
        Math.max(owner[index], sea[index]),
      );
    }
  });

  it('never draws a held country as unclaimed grey', () => {
    for (const color of COUNTRY_PALETTE) {
      expect(shadeOf(color)).not.toBe(INACTIVE_COLOR);
    }
  });

  it('gives every empire a shade of its own', () => {
    expect(new Set(COUNTRY_PALETTE.map(shadeOf)).size).toBe(
      COUNTRY_PALETTE.length,
    );
  });
});

describe('every empire is legible against the sea', () => {
  // The map is drawn on near-black water, so a colour dark enough to match it
  // leaves a country looking like it is not there at all. The palette carried
  // a navy and a maroon that did exactly that, and shading only made it worse.

  const empires = COUNTRY_PALETTE.map(color => ({
    color,
    name: `#${color.toString(16).padStart(6, '0')}`,
  }));

  /** A country whose colour is the given palette entry, for each entry. */
  const owners = new Map<number, string>();
  for (const country of COUNTRIES) {
    const color = countryColor(country.code);
    if (!owners.has(color)) owners.set(color, country.code);
  }

  it.each(empires)('shows $name as a country in its own right', ({color}) => {
    expect(contrast(color, OCEAN_COLOR)).toBeGreaterThanOrEqual(3);
  });

  it.each(empires)('still shows $name once conquered', ({color}) => {
    const held = fillFor(territory('DE', owners.get(color)!));
    expect(contrast(held, OCEAN_COLOR)).toBeGreaterThanOrEqual(1.9);
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
