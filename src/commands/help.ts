import {
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import type {ChatInputCommandInteraction} from 'discord.js';
import {HELP_TOPICS, TOPIC_LABELS, isHelpTopic} from '../help/topics.js';
import {helpCard} from '../discord/help-ui.js';
import {v2EditReply} from '../discord/ui.js';
import {settingsFor} from '../db/guild-settings.js';
import type {Command, CommandContext} from './types.js';

export const helpCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('How Conquest works')
    .setContexts(InteractionContextType.Guild)
    .addStringOption(option =>
      option
        .setName('topic')
        .setDescription('What to read about')
        .setRequired(false)
        // A small, fixed set, so these are choices rather than autocomplete.
        .addChoices(
          ...HELP_TOPICS.map(topic => ({
            name: TOPIC_LABELS[topic].label,
            value: topic,
          })),
        ),
    ),

  async execute(
    interaction: ChatInputCommandInteraction,
    ctx: CommandContext,
  ): Promise<void> {
    // Help is personal and would only clutter a channel.
    await interaction.deferReply({flags: MessageFlags.Ephemeral});

    const requested = interaction.options.getString('topic');
    // Help documents the game as this server actually plays it.
    const settings = interaction.guildId
      ? settingsFor(ctx.db, interaction.guildId)
      : undefined;
    await interaction.editReply(
      v2EditReply(
        helpCard(
          requested && isHelpTopic(requested)
            ? {topic: requested, page: 0}
            : {page: 0},
          settings,
        ),
      ),
    );
  },
};
