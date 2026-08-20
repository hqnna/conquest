import {describe, expect, it} from 'vitest';
import type {ContainerBuilder} from 'discord.js';
import {
  deltaLine,
  gatherRefusalCard,
  stockpileLine,
} from '../src/commands/gather.js';
import {cooldownLines, resourcesCard} from '../src/commands/resources.js';
import {RESOURCES} from '../src/config/constants.js';
import {defaultSettings} from '../src/config/settings.js';
import type {GatherCommand} from '../src/db/cooldowns.js';

const NOW = 1_700_000_000_000;

function textOf(container: ContainerBuilder): string {
  const json = container.toJSON() as {
    components: Array<{type: number; content?: string}>;
  };
  return json.components.map(component => component.content ?? '').join('\n');
}

describe('stockpileLine', () => {
  it('shows all three resources', () => {
    const line = stockpileLine({food: 1, gold: 2, troops: 3});
    expect(line).toContain('**1** food');
    expect(line).toContain('**2** gold');
    expect(line).toContain('**3** troops');
  });
});

describe('deltaLine', () => {
  it('is empty when nothing is owed', () => {
    expect(deltaLine({})).toBe('');
  });

  it('names a single resource on its own', () => {
    expect(deltaLine({gold: 6})).toBe('6 🪙 gold');
  });

  it('joins two resources with “and”', () => {
    expect(deltaLine({food: 10, gold: 10})).toBe('10 🌾 food and 10 🪙 gold');
  });

  it('ignores resources that are not owed', () => {
    expect(deltaLine({food: 0, gold: 5})).toBe('5 🪙 gold');
  });
});

describe('gatherRefusalCard', () => {
  it('points an unconfigured server at /setup', () => {
    expect(
      textOf(
        gatherRefusalCard({kind: 'not_configured'}, 'farm', defaultSettings()),
      ),
    ).toContain('/setup');
  });

  it('points a countryless player at /join', () => {
    expect(
      textOf(
        gatherRefusalCard({kind: 'not_in_country'}, 'farm', defaultSettings()),
      ),
    ).toContain('/join');
  });

  it('says when the player may go again', () => {
    const text = textOf(
      gatherRefusalCard(
        {kind: 'cooldown', until: NOW + 1_000},
        'mine',
        defaultSettings(),
      ),
    );
    expect(text).toContain('/mine');
    expect(text).toMatch(/<t:\d+:R>/);
  });

  it('says exactly what a country is short and how to fix it', () => {
    const text = textOf(
      gatherRefusalCard(
        {kind: 'insufficient', short: {gold: 6}},
        'recruit',
        defaultSettings(),
      ),
    );
    expect(text).toContain('short 6 🪙 gold');
    expect(text).toContain('/farm');
    expect(text).toContain('/mine');
  });
});

describe('cooldownLines', () => {
  it('marks every command ready for a player who has not gathered', () => {
    const lines = cooldownLines(new Map(), NOW);
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(line).toContain('ready now');
  });

  it('counts down the ones that are running', () => {
    const cooldowns = new Map<GatherCommand, number>([
      ['farm', NOW + 1_000],
      ['mine', NOW - 1_000],
    ]);
    const [farm, mine, recruit] = cooldownLines(cooldowns, NOW);
    expect(farm).toMatch(/<t:\d+:R>/);
    expect(mine).toContain('ready now');
    expect(recruit).toContain('ready now');
  });
});

describe('resourcesCard', () => {
  const card = () =>
    textOf(
      resourcesCard({
        code: 'FR',
        stockpile: {food: 12, gold: 34, troops: 56},
        cooldowns: new Map([['farm', NOW + 1_000]]),
        settings: defaultSettings(),
        now: NOW,
      }),
    );

  it('names the country and its pooled stockpile', () => {
    expect(card()).toContain('🇫🇷 France');
    expect(card()).toContain('**12** food');
    expect(card()).toContain('pooled');
  });

  it('lists the player own cooldowns', () => {
    expect(card()).toContain('/farm');
    expect(card()).toContain('/recruit');
  });

  it('quotes the recruit cost from the tunables', () => {
    const text = card();
    expect(text).toContain(`${RESOURCES.recruitCost.gold} 🪙 gold`);
    expect(text).toContain(`${RESOURCES.recruitCost.food} 🌾 food`);
    expect(text).toContain(
      `${RESOURCES.recruitYield.min}–${RESOURCES.recruitYield.max} ⚔️ troops`,
    );
  });
});
