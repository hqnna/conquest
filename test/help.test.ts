import {describe, expect, it} from 'vitest';
import type {ContainerBuilder} from 'discord.js';
import {
  COOLDOWNS,
  DISCORD_LIMITS,
  INVASIONS,
  RESOURCES,
  WAR,
  formatDuration,
} from '../src/config/constants.js';
import {
  HELP_SELECT_ID,
  helpCard,
  helpCustomId,
  isHelpComponent,
  parseHelpCustomId,
} from '../src/discord/help-ui.js';
import {
  HELP_TOPICS,
  TOPIC_LABELS,
  clampPage,
  indexPage,
  isHelpTopic,
  pagesFor,
} from '../src/help/topics.js';
import type {HelpTopic} from '../src/help/topics.js';

function textOf(container: ContainerBuilder): string {
  const json = container.toJSON() as {
    components: Array<{type: number; content?: string}>;
  };
  return json.components.map(component => component.content ?? '').join('\n');
}

function componentsOf(container: ContainerBuilder) {
  const json = container.toJSON() as {
    components: Array<{
      type: number;
      components?: Array<{
        type: number;
        custom_id?: string;
        disabled?: boolean;
        label?: string;
        options?: Array<{value: string; default?: boolean}>;
      }>;
    }>;
  };
  return json.components.flatMap(component => component.components ?? []);
}

/** Every page of every topic, plus the index. */
function allPages() {
  return [indexPage(), ...HELP_TOPICS.flatMap(topic => pagesFor(topic))];
}

describe('help content', () => {
  it('covers every topic the command offers', () => {
    for (const topic of HELP_TOPICS) {
      expect(pagesFor(topic).length).toBeGreaterThan(0);
      expect(TOPIC_LABELS[topic].label.length).toBeGreaterThan(0);
    }
  });

  it('gives every page a heading and something to say', () => {
    for (const page of allPages()) {
      expect(page.heading.length).toBeGreaterThan(0);
      expect(page.blocks.length).toBeGreaterThan(0);
      for (const block of page.blocks)
        expect(block.trim().length).toBeGreaterThan(0);
    }
  });

  it('keeps every page inside a Discord message', () => {
    for (const topic of HELP_TOPICS) {
      for (const page of pagesFor(topic)) {
        const card = helpCard({topic, page: pagesFor(topic).indexOf(page)});
        expect(textOf(card).length).toBeLessThan(
          DISCORD_LIMITS.charactersPerMessage,
        );
        expect(
          (card.toJSON() as {components: unknown[]}).components.length,
        ).toBeLessThan(DISCORD_LIMITS.componentsPerMessage);
      }
    }
  });

  it('paginates the long topic rather than truncating it', () => {
    expect(pagesFor('invasions').length).toBeGreaterThan(1);
  });

  it('lists every topic on the index', () => {
    const text = indexPage().blocks.join('\n');
    for (const topic of HELP_TOPICS) {
      expect(text).toContain(TOPIC_LABELS[topic].label);
    }
  });
});

describe('help numbers come from the tunables', () => {
  const everything = allPages()
    .flatMap(page => page.blocks)
    .join('\n');

  it('quotes the gather cooldowns', () => {
    expect(everything).toContain(formatDuration(COOLDOWNS.farm));
    expect(everything).toContain(formatDuration(COOLDOWNS.recruit));
  });

  it('quotes the recruit cost and yield', () => {
    expect(everything).toContain(
      `${RESOURCES.recruitCost.gold} gold and ${RESOURCES.recruitCost.food} food`,
    );
    expect(everything).toContain(
      `${RESOURCES.recruitYield.min}–${RESOURCES.recruitYield.max} troops`,
    );
  });

  it('quotes the invasion windows and cooldowns', () => {
    expect(everything).toContain(formatDuration(INVASIONS.attackVoteWindow));
    expect(everything).toContain(formatDuration(INVASIONS.defenseWindow));
    expect(everything).toContain(
      formatDuration(INVASIONS.newCountryProtection),
    );
    expect(everything).toContain(formatDuration(COOLDOWNS.invade));
    expect(everything).toContain(formatDuration(COOLDOWNS.rejoin));
  });

  it('quotes the war tick and reinforcement window', () => {
    expect(everything).toContain(formatDuration(WAR.tickInterval));
    expect(everything).toContain(formatDuration(WAR.reinforcementWindow));
    expect(everything).toContain(`${Math.round(WAR.baseLossRate * 100)}%`);
  });

  it('quotes the win condition and the channel cap', () => {
    expect(everything).toContain('total conquest');
    expect(everything).toContain(String(DISCORD_LIMITS.channelsPerCategory));
  });
});

describe('help customIds', () => {
  it('round-trips every location', () => {
    for (const topic of HELP_TOPICS) {
      expect(parseHelpCustomId(helpCustomId({topic, page: 0}))).toEqual({
        topic,
        page: 0,
      });
    }
    expect(parseHelpCustomId(helpCustomId({page: 0}))).toEqual({page: 0});
  });

  it('clamps a page the topic does not have', () => {
    expect(parseHelpCustomId('help:about:99')).toEqual({
      topic: 'about',
      page: pagesFor('about').length - 1,
    });
  });

  it('rejects ids that are not Conquest help', () => {
    for (const bad of [
      'vote:7:attack:approve',
      'help:about',
      'help:about:1:2',
      'help:nonsense:0',
      'help:about:-1',
      'help:about:x',
      '',
    ]) {
      expect(parseHelpCustomId(bad)).toBeUndefined();
    }
  });

  it('recognises its own components, and nobody else’s', () => {
    expect(isHelpComponent(HELP_SELECT_ID)).toBe(true);
    expect(isHelpComponent('help:about:0')).toBe(true);
    expect(isHelpComponent('vote:7:attack:approve')).toBe(false);
    expect(isHelpComponent('game:reset:confirm')).toBe(false);
  });
});

describe('clampPage', () => {
  it('keeps a page inside the topic', () => {
    expect(clampPage('invasions', -5)).toBe(0);
    expect(clampPage('invasions', 999)).toBe(pagesFor('invasions').length - 1);
    expect(clampPage('invasions', 1)).toBe(1);
  });

  it('copes with nonsense', () => {
    expect(clampPage('about', Number.NaN)).toBe(0);
    expect(clampPage('about', 1.7)).toBe(0);
  });
});

describe('isHelpTopic', () => {
  it('accepts only real topics', () => {
    for (const topic of HELP_TOPICS) expect(isHelpTopic(topic)).toBe(true);
    expect(isHelpTopic('strategy')).toBe(false);
    expect(isHelpTopic('')).toBe(false);
  });
});

describe('helpCard', () => {
  it('offers the topic menu on the index', () => {
    const menu = componentsOf(helpCard({page: 0})).find(
      component => component.custom_id === HELP_SELECT_ID,
    );
    expect(menu?.options?.map(option => option.value)).toEqual([
      ...HELP_TOPICS,
    ]);
  });

  it('has no page buttons on the index', () => {
    const buttons = componentsOf(helpCard({page: 0})).filter(
      component => component.label,
    );
    expect(buttons).toEqual([]);
  });

  it('marks the topic being read in the menu', () => {
    const menu = componentsOf(helpCard({topic: 'rules', page: 0})).find(
      component => component.custom_id === HELP_SELECT_ID,
    );
    const chosen = menu?.options?.filter(option => option.default);
    expect(chosen?.map(option => option.value)).toEqual(['rules']);
  });

  it('shows no page buttons on a single-page topic', () => {
    const buttons = componentsOf(helpCard({topic: 'about', page: 0})).filter(
      component => component.label,
    );
    expect(buttons).toEqual([]);
  });

  it('disables Previous on the first page and Next on the last', () => {
    const total = pagesFor('invasions').length;
    const first = componentsOf(helpCard({topic: 'invasions', page: 0})).filter(
      component => component.label,
    );
    expect(first.map(button => button.disabled)).toEqual([true, false]);

    const last = componentsOf(
      helpCard({topic: 'invasions', page: total - 1}),
    ).filter(component => component.label);
    expect(last.map(button => button.disabled)).toEqual([false, true]);
  });

  it('numbers the pages of a paginated topic', () => {
    expect(textOf(helpCard({topic: 'invasions', page: 1}))).toContain(
      `Page 2 of ${pagesFor('invasions').length}`,
    );
  });

  it('does not number a topic that fits on one page', () => {
    expect(textOf(helpCard({topic: 'about', page: 0}))).not.toContain('Page 1');
  });

  it('steps to a real page from every button it draws', () => {
    for (const topic of HELP_TOPICS as readonly HelpTopic[]) {
      const total = pagesFor(topic).length;
      for (let page = 0; page < total; page++) {
        for (const button of componentsOf(helpCard({topic, page})).filter(
          component => component.label,
        )) {
          if (button.disabled) continue;
          const target = parseHelpCustomId(button.custom_id!);
          expect(target?.topic).toBe(topic);
          expect(target!.page).toBeGreaterThanOrEqual(0);
          expect(target!.page).toBeLessThan(total);
        }
      }
    }
  });
});
