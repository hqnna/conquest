/**
 * Paging and switching topic in a help message.
 *
 * Everything needed is in the component's own id, so these keep working after
 * a restart. The reply is only ever edited in place, and only for the person
 * it belongs to — Discord enforces that for an ephemeral message.
 */
import type {ButtonInteraction, StringSelectMenuInteraction} from 'discord.js';
import type {Database} from '../db/index.js';
import {settingsFor} from '../db/guild-settings.js';
import {isHelpTopic} from '../help/topics.js';
import {HELP_SELECT_ID, helpCard, parseHelpCustomId} from './help-ui.js';
import {v2Message} from './ui.js';

/** Moves a help message to the page its button names. */
export async function handleHelpButton(
  db: Database,
  interaction: ButtonInteraction,
): Promise<void> {
  const location = parseHelpCustomId(interaction.customId);
  if (!location) return;
  await interaction.update(
    v2Message(helpCard(location, settingsOf(db, interaction.guildId))),
  );
}

/** This guild's settings, or the shipped ones outside a guild. */
function settingsOf(db: Database, guildId: string | null) {
  return guildId ? settingsFor(db, guildId) : undefined;
}

/** Switches a help message to the chosen topic, from its first page. */
export async function handleHelpSelect(
  db: Database,
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  if (interaction.customId !== HELP_SELECT_ID) return;
  const [topic] = interaction.values;
  await interaction.update(
    v2Message(
      helpCard(
        topic && isHelpTopic(topic) ? {topic, page: 0} : {page: 0},
        settingsOf(db, interaction.guildId),
      ),
    ),
  );
}
