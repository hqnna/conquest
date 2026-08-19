import {describe, expect, it} from 'vitest';
import {standings, worldCard} from '../src/commands/map.js';

/** Reads the text out of a Components V2 container, for assertions. */
function textOf(container: ReturnType<typeof worldCard>): string {
  const json = container.toJSON() as {
    components: Array<{type: number; content?: string}>;
  };
  return json.components.map(component => component.content ?? '').join('\n');
}

describe('standings', () => {
  it('ranks by territory, then players, then code', () => {
    const entries = standings(
      ['BE', 'DE', 'FR', 'NL'],
      new Map([
        ['FR', 3],
        ['DE', 1],
        ['BE', 5],
        ['NL', 5],
      ]),
      new Map([
        ['FR', 4],
        ['DE', 4],
      ]),
    );
    expect(entries.map(entry => entry.code)).toEqual(['FR', 'DE', 'BE', 'NL']);
  });

  it('counts a country with no players or territories as zero', () => {
    expect(standings(['FR'], new Map(), new Map())).toEqual([
      {code: 'FR', players: 0, territories: 0},
    ]);
  });

  it('is stable for the same state', () => {
    const players = new Map([
      ['FR', 1],
      ['DE', 1],
    ]);
    const territories = new Map([
      ['FR', 1],
      ['DE', 1],
    ]);
    expect(standings(['DE', 'FR'], players, territories)).toEqual(
      standings(['FR', 'DE'], players, territories),
    );
  });
});

describe('worldCard', () => {
  it('says the world is empty before anyone joins', () => {
    expect(textOf(worldCard([], 10))).toContain('The world is empty');
  });

  it('lists countries with their flags and holdings', () => {
    const text = textOf(
      worldCard([{code: 'FR', players: 2, territories: 3}], 10),
    );
    expect(text).toContain('🇫🇷 France');
    expect(text).toContain('3 territories');
    expect(text).toContain('2 players');
  });

  it('singularises a lone territory and a lone player', () => {
    const text = textOf(
      worldCard([{code: 'FR', players: 1, territories: 1}], 10),
    );
    expect(text).toContain('1 territory,');
    expect(text).toContain('1 player');
  });

  it('shows the leader progress towards the win', () => {
    const text = textOf(
      worldCard(
        [
          {code: 'FR', players: 2, territories: 6},
          {code: 'DE', players: 4, territories: 1},
        ],
        10,
      ),
    );
    expect(text).toContain('France');
    expect(text).toContain('6 of the 10 territories');
  });
});
