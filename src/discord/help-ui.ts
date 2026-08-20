/**
 * The `/help` card: a page, buttons to page through it, and a menu to switch
 * topic without running the command again.
 *
 * The components carry the whole state — `help:<topic>:<page>` — and are read
 * back on click, so a help message keeps working after a restart with no
 * collector to lose.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import type {ContainerBuilder} from 'discord.js';
import {defaultSettings} from '../config/settings.js';
import type {Settings} from '../config/settings.js';
import {
  HELP_TOPICS,
  TOPIC_LABELS,
  clampPage,
  indexPage,
  isHelpTopic,
  pagesFor,
} from '../help/topics.js';
import type {HelpTopic} from '../help/topics.js';
import {ACCENT, container} from './ui.js';

/** Where a help message currently is. */
export interface HelpLocation {
  /** The topic being read, or undefined on the index page. */
  topic?: HelpTopic;
  page: number;
}

/** customId of the topic menu. The chosen topic arrives as its value. */
export const HELP_SELECT_ID = 'help:select';

/** Builds the customId for a page button. */
export function helpCustomId(location: HelpLocation): string {
  return `help:${location.topic ?? 'index'}:${location.page}`;
}

/**
 * Reads a help component's customId.
 *
 * @returns where to go, or undefined if the id is not one of Conquest's.
 */
export function parseHelpCustomId(customId: string): HelpLocation | undefined {
  const parts = customId.split(':');
  if (parts.length !== 3 || parts[0] !== 'help') return undefined;
  const [, topic, rawPage] = parts;
  const page = Number(rawPage);
  if (!Number.isInteger(page) || page < 0) return undefined;
  if (topic === 'index') return {page: 0};
  if (!isHelpTopic(topic)) return undefined;
  return {topic, page: clampPage(topic, page)};
}

/** Whether a customId belongs to the help system. */
export function isHelpComponent(customId: string): boolean {
  return customId === HELP_SELECT_ID || customId.startsWith('help:');
}

/** The topic menu, with the current topic pre-selected. */
function topicMenu(
  current?: HelpTopic,
): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(HELP_SELECT_ID)
      .setPlaceholder('Read about…')
      .addOptions(
        HELP_TOPICS.map(topic =>
          new StringSelectMenuOptionBuilder()
            .setLabel(TOPIC_LABELS[topic].label)
            .setDescription(TOPIC_LABELS[topic].description)
            .setEmoji(TOPIC_LABELS[topic].emoji)
            .setValue(topic)
            .setDefault(topic === current),
        ),
      ),
  );
}

/** Previous and Next, disabled at the ends rather than hidden. */
function pageButtons(
  topic: HelpTopic,
  page: number,
  total: number,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(helpCustomId({topic, page: page - 1}))
      .setLabel('Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId(helpCustomId({topic, page: page + 1}))
      .setLabel('Next')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= total - 1),
  );
}

/**
 * Builds the help card for a location.
 *
 * Long topics are paginated rather than truncated, so nothing is ever cut
 * off — a reader can always reach the rest.
 */
export function helpCard(
  location: HelpLocation,
  settings: Settings = defaultSettings(),
): ContainerBuilder {
  if (!location.topic) {
    const page = indexPage();
    const card = container(
      ACCENT.neutral,
      `## ${page.heading}`,
      ...page.blocks,
    );
    card.addActionRowComponents(topicMenu());
    return card;
  }

  const pages = pagesFor(location.topic, settings);
  const index = clampPage(location.topic, location.page);
  const page = pages[index];

  const heading =
    pages.length > 1
      ? `## ${page.heading}\n-# Page ${index + 1} of ${pages.length}`
      : `## ${page.heading}`;

  const card = container(ACCENT.neutral, heading, ...page.blocks);
  if (pages.length > 1) {
    card.addActionRowComponents(
      pageButtons(location.topic, index, pages.length),
    );
  }
  card.addActionRowComponents(topicMenu(location.topic));
  return card;
}
