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
  'merges',
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
  merges: {
    label: 'Merging',
    description: 'Giving your country to another one, by vote',
    emoji: '🤝',
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
  const {resources, cooldowns, invasions, war, merges} = settings;
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
            '**The war room is the exception.** Everyone can talk there, so it is where countries reach each other — threats, bargains, and offers to merge.',
            '`/country name:<name>` tells you how big a rival is and whether it can be attacked — but never what it has in its stockpile.',
          ].join('\n'),
          [
            '**4. March.** `/invade country:<target> troops:<n>` puts an invasion to your country. Your own vote is already counted.',
            `A freshly founded country cannot be attacked for ${formatDuration(invasions.newCountryProtection)}, so there is time to build up first — but attacking anyone gives that protection up.`,
          ].join('\n'),
          [
            '**5. Or join them.** `/merge country:<name>` offers your whole country to another one. Both sides vote, and if both agree you become one country.',
            'It is the only way to grow without fighting — and the only way to give a country away.',
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
          [
            '**You can be in more than one war.** Attack somebody who is already fighting, gang up on a target with a friend, or march back on your own invader — all of it is allowed. Only a second declaration on the same country is refused.',
            'While you are in several, add `enemy:<country>` to `/defend`, `/reinforce`, and `/surrender` to say which war you mean.',
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
            '**A country that falls loses every war it was fighting.** Those wars are called off, and each side gets its surviving force back.',
            'For the fallen country that is no rescue: it has no home left, so an army it had abroad comes back into a stockpile the victor takes with everything else. Striking an enemy who is busy invading somebody else can win you their whole expedition.',
          ].join('\n'),
          [
            `**Afterwards.** The attacker cannot declare again for ${formatDuration(cooldowns.invade)}, win or lose.`,
            `A country that fought off an invasion cannot be attacked again for ${formatDuration(invasions.successfulDefenseImmunity)}.`,
          ].join('\n'),
        ],
      },
    ],

    merges: [
      {
        heading: '🤝 Merging',
        blocks: [
          '`/merge country:<name>` offers your country to another one. A country can be given away as well as taken — and the world counts it the same either way.',
          [
            `**Both countries vote.** Yours decides whether to make the offer, then theirs decides whether to take you in. Each side has ${formatDuration(merges.voteWindow)}, and each needs a strict majority.`,
            'Your own `/merge` counts as your approval. If either side says no, or says nothing, nothing moves at all.',
          ].join('\n'),
          [
            '**If both agree, the smaller country ends:**',
            '• everyone in it joins the other country',
            '• its whole stockpile goes with them',
            '• its territories become theirs',
            '• its channel becomes a read-only archive',
          ].join('\n'),
          [
            '**Think before you accept.** The players you take in vote with you afterwards, so a big country joining a small one can end up deciding what the small one does.',
            'Taking a country in also gives up new-country protection, exactly as marching on somebody does.',
          ].join('\n'),
          '**War outranks it.** A country in a war cannot offer or accept, and an invasion that starts mid-vote calls the merge off.',
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
            '**Wars can overlap.** A country can fight several at once, attacking and defending at the same time, and two countries can pile on the same target. The only thing you cannot do is declare twice on the same country.',
            'That is what makes an alliance mean something: if somebody invades a country you promised to protect, you can march on the invader while their army is already committed.',
            '`/defend`, `/reinforce`, and `/surrender` take `enemy:<country>` to say which war you mean — you only need it once you are in more than one.',
            `**Protections.** A new country cannot be invaded for ${formatDuration(invasions.newCountryProtection)}, but attacking anybody gives that up immediately.`,
          ].join('\n'),
          [
            `**Room in the world.** Discord allows ${DISCORD_LIMITS.channelsPerCategory} channels per category, and conquered countries keep theirs as archives.`,
            'Late in a round there may be no room to found a new country, and joining an existing one is the way in. Existing countries can always be joined.',
          ].join('\n'),
          [
            '**Winning.** There is one way to win, and it is total conquest: be the last country left, having taken every other country yourself — beaten in war or handed over by `/merge`. A rival that disbands on its own does not count.',
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
