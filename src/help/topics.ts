/**
 * The text of `/help`.
 *
 * Every number here is read from the tunables module rather than written out,
 * so the help cannot drift from the game. Change a cooldown and this changes
 * with it — including in dev mode, where the help honestly reports the
 * shortened timers.
 */
import {DEV_MODE, DISCORD_LIMITS, formatDuration} from '../config/constants.js';
import {defaultSettings} from '../config/settings.js';
import type {Settings} from '../config/settings.js';

/** The topics `/help` offers. */
export const HELP_TOPICS = [
  'about',
  'guide',
  'resources',
  'invasions',
  'rules',
] as const;

export type HelpTopic = (typeof HELP_TOPICS)[number];

/** One page of one topic. */
export interface HelpPage {
  heading: string;
  /** Markdown blocks, rendered as separated text displays. */
  blocks: string[];
}

/** How each topic is labelled in the select menu. */
export const TOPIC_LABELS: Readonly<
  Record<HelpTopic, {label: string; description: string; emoji: string}>
> = {
  about: {
    label: 'About',
    description: 'What Conquest is, and how a round ends',
    emoji: '👑',
  },
  guide: {
    label: 'Getting started',
    description: 'Join a country, gather, coordinate, invade',
    emoji: '🧭',
  },
  resources: {
    label: 'Resources',
    description: 'Food, gold, troops, and their cooldowns',
    emoji: '🌾',
  },
  invasions: {
    label: 'Invasions',
    description: 'Votes, wars of attrition, and what they cost',
    emoji: '⚔️',
  },
  rules: {
    label: 'Rules',
    description: 'Cooldowns, limits, and winning the round',
    emoji: '📜',
  },
};

/**
 * The pages, written against one guild's settings.
 *
 * Nothing here quotes a number directly: every one comes from the settings
 * handed in, so the help describes the game as this server actually plays it.
 */
function buildPages(
  settings: Settings,
): Readonly<Record<HelpTopic, HelpPage[]>> {
  const {resources, cooldowns, invasions, war} = settings;
  const troopRange = `${resources.recruitYield.min}–${resources.recruitYield.max}`;
  const gatherRange = `${resources.farmYield.min}–${resources.farmYield.max}`;

  return {
    about: [
      {
        heading: '👑 Conquest',
        blocks: [
          'Conquest is a war for the whole server. You join a real country, pool everything you gather with your countrymen, and vote on who to march against.',
          [
            '**Countries are shared.** Everything anyone farms, mines, or recruits goes into one stockpile, and every commitment of it is put to a vote.',
            '**Wars are long.** An invasion is not a dice roll. Two armies grind each other down over hours until one of them has nothing left in the field.',
            '**Conquest is total.** Beat a country and you take everything: its stockpile, its people, its territory, and its channel as a war trophy you can read.',
          ].join('\n'),
          [
            '**The round ends** only with total conquest: when one country has taken every other country in the world and stands alone.',
            'Then the world is wiped and everyone starts again from nothing.',
          ].join('\n'),
          'New here? Read `/help topic:guide`.',
        ],
      },
    ],

    guide: [
      {
        heading: '🧭 Getting started',
        blocks: [
          '**1. Join a country.** `/join country:<name>` puts you in one and gives you its private channel. Join an empty country and you found it; join a busy one and you have allies from the first minute.',
          [
            `**2. Gather.** \`/farm\` and \`/mine\` every ${formatDuration(cooldowns.farm)}, \`/recruit\` every ${formatDuration(cooldowns.recruit)}.`,
            'Everything you gather belongs to the country, not to you. `/resources` shows the pot and your own cooldowns.',
          ].join('\n'),
          [
            '**3. Talk.** Your country channel is private. Nobody outside it can read what you are planning, and you cannot see what anyone else is planning either.',
            '`/country name:<name>` tells you how big a rival is and whether it can be attacked — but never what it has in its stockpile.',
          ].join('\n'),
          [
            '**4. March.** `/invade country:<target> troops:<n>` puts an invasion to your country. Your own vote is already counted.',
            `A freshly founded country cannot be attacked for ${formatDuration(invasions.newCountryProtection)}, so there is time to build up first — but attacking anyone gives that protection up.`,
          ].join('\n'),
          'The next thing to read is `/help topic:invasions`, because a war costs more than it looks like it will.',
        ],
      },
    ],

    resources: [
      {
        heading: '🌾 Resources',
        blocks: [
          'Three resources, pooled per country. Everything anyone gathers goes into the same stockpile.',
          [
            `🌾 **Food** — \`/farm\`, ${gatherRange} per go, every ${formatDuration(cooldowns.farm)}.`,
            `🪙 **Gold** — \`/mine\`, ${gatherRange} per go, every ${formatDuration(cooldowns.mine)}.`,
            `⚔️ **Troops** — \`/recruit\` turns **${resources.recruitCost.gold} gold and ${resources.recruitCost.food} food** into ${troopRange} troops, every ${formatDuration(cooldowns.recruit)}.`,
          ].join('\n'),
          [
            '**Cooldowns are yours, not your country’s.** Every player gathers on their own clock, so a country of six gathers six times as fast as a country of one.',
            'That cuts both ways: a big country is a big target.',
          ].join('\n'),
          [
            '**Troops fight. Gold and food also fight.** Supplies sent with an army make it hit harder, up to **+50%** power at one supply per troop. Past that they add nothing and are still lost.',
            '`/resources` shows the stockpile and your own timers, and only you see it.',
          ].join('\n'),
        ],
      },
    ],

    invasions: [
      {
        heading: '⚔️ Invasions — declaring',
        blocks: [
          '`/invade country:<target> troops:<n> [gold] [food]` puts an invasion to your country. Troops are required; supplies are optional and make those troops fight harder.',
          [
            `**The vote.** A strict majority of your country must approve, within ${formatDuration(invasions.attackVoteWindow)}. Your own \`/invade\` counts as your approval, so a one-player country passes on its own.`,
            '**The cost is immediate.** The moment it passes, the whole stake leaves your stockpile. You cannot promise the same troops to two wars.',
          ].join('\n'),
          [
            `**The defender is told at once**, and has ${formatDuration(invasions.defenseWindow)} to answer with \`/defend\`.`,
            '**Ignoring an invasion loses it.** A country that never answers is absorbed without a fight — and the attacker’s army comes home untouched.',
          ].join('\n'),
          'The next page covers what happens when they do fight back.',
        ],
      },
      {
        heading: '⚔️ Invasions — the war',
        blocks: [
          `Once a defence takes the field, the two armies grind each other down. Every ${formatDuration(war.tickInterval)} both sides lose part of everything they committed.`,
          [
            `**Losses depend on the enemy.** An even war costs both sides about **${Math.round(war.baseLossRate * 100)}%** a round. Being outgunned two to one costs double, while the stronger side pays half.`,
            `**Defending is easier.** The defender fights at **+${Math.round((invasions.homeAdvantage - 1) * 100)}%** on home ground, so an attacker needs a real advantage, not a marginal one.`,
            '**Luck matters a little**, never enough to save a badly outmatched army.',
          ].join('\n'),
          [
            `**When your troops run out**, your country is asked to answer within ${formatDuration(war.reinforcementWindow)}: \`/reinforce\` and carry the vote, or \`/surrender\`.`,
            '**Saying nothing is surrender.** So is having an empty stockpile — a country with nothing left to send has already lost.',
          ].join('\n'),
        ],
      },
      {
        heading: '⚔️ Invasions — the spoils',
        blocks: [
          [
            '**If the attacker gives up**, whatever is left of its army marches home. It loses the war, not its army.',
            'The defender keeps its survivors, its country, and everything in it.',
          ].join('\n'),
          [
            '**If the defender gives up, it is absorbed entirely:**',
            '• its remaining army is captured',
            '• its stockpile is looted',
            '• its players join the winner',
            '• its territories change hands, including everything it had taken',
            '• its channel becomes a read-only archive the conquerors can read',
          ].join('\n'),
          [
            `**Afterwards.** The attacker cannot declare again for ${formatDuration(cooldowns.invade)}, win or lose.`,
            `A country that fought off an invasion cannot be attacked again for ${formatDuration(invasions.successfulDefenseImmunity)}.`,
          ].join('\n'),
        ],
      },
    ],

    rules: [
      {
        heading: '📜 Rules',
        blocks: [
          [
            `**One country at a time.** \`/leave\` puts you on a ${formatDuration(cooldowns.rejoin)} cooldown before you can join another, so nobody switches sides mid-war.`,
            'Leaving discards any vote you had cast, and the majority is recounted over whoever is still there.',
            'If you were the last player, your country is disbanded and everything it held is released.',
          ].join('\n'),
          [
            '**One war at a time.** A country fights one invasion at a time, attacking or defending. It cannot be attacked by two countries at once, and cannot open a second front of its own.',
            `**Protections.** A new country cannot be invaded for ${formatDuration(invasions.newCountryProtection)}, but attacking anybody gives that up immediately.`,
          ].join('\n'),
          [
            `**Room in the world.** Discord allows ${DISCORD_LIMITS.channelsPerCategory} channels per category, and conquered countries keep theirs as archives.`,
            'Late in a round there may be no room to found a new country, and joining an existing one is the way in. Existing countries can always be joined.',
          ].join('\n'),
          [
            '**Winning.** There is one way to win, and it is total conquest: be the last country left, having taken every other country yourself. A rival that disbands on its own does not count — somebody has to beat it.',
            'Then everything is wiped and the next round starts from nothing.',
          ].join('\n'),
        ],
      },
    ],
  };
}

/** The pages of one topic, as this guild has tuned the game. */
export function pagesFor(
  topic: HelpTopic,
  settings: Settings = defaultSettings(),
): HelpPage[] {
  const pages = buildPages(settings)[topic];
  return DEV_MODE
    ? pages.map((page, index) =>
        index === 0
          ? {
              ...page,
              blocks: [
                ...page.blocks,
                '*Dev mode: every timer above is drastically shortened for playtesting.*',
              ],
            }
          : page,
      )
    : pages;
}

/** The index page, shown when `/help` is run with no topic. */
export function indexPage(): HelpPage {
  return {
    heading: '👑 Conquest — help',
    blocks: [
      'A war for the whole server: join a country, pool what you gather, and vote on who to march against.',
      HELP_TOPICS.map(
        topic =>
          `${TOPIC_LABELS[topic].emoji} **${TOPIC_LABELS[topic].label}** — ${TOPIC_LABELS[topic].description}`,
      ).join('\n'),
      'Pick a topic below, or run `/help topic:<name>`.',
    ],
  };
}

/** Clamps a page number to one this topic actually has. */
export function clampPage(topic: HelpTopic, page: number): number {
  const total = pagesFor(topic).length;
  if (!Number.isFinite(page)) return 0;
  return Math.min(Math.max(0, Math.trunc(page)), total - 1);
}

/** Whether a string names a topic. */
export function isHelpTopic(value: string): value is HelpTopic {
  return (HELP_TOPICS as readonly string[]).includes(value);
}
