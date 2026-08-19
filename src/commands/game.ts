import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import type {ChatInputCommandInteraction, ContainerBuilder} from 'discord.js';
import {GAME, formatDuration} from '../config/constants.js';
import {countryLabel, findCountry} from '../data/countries.js';
import {listCountriesByStatus, territoryCounts} from '../db/countries.js';
import {getGuildConfig, setDominationThreshold} from '../db/guild-config.js';
import {ACCENT, container, v2EditReply} from '../discord/ui.js';
import type {Command, CommandContext} from './types.js';

/** The `customId` of the button that actually wipes a guild's game. */
export const RESET_CONFIRM_ID = 'game:reset:confirm';

/** How high a domination threshold an admin may set. */
export const MAX_THRESHOLD = 100;

/**
 * The confirmation put in front of a reset.
 *
 * Resetting destroys a round outright, so it takes a deliberate second act.
 * The button carries nothing but its own name and is revalidated on click,
 * like every other component in Conquest.
 */
export function resetConfirmationCard(input: {
  activeCountries: number;
  channels: number;
}): ContainerBuilder {
  const card = container(
    ACCENT.danger,
    '## Reset the game?',
    `This deletes **${input.channels}** country channel${input.channels === 1 ? '' : 's'} and every country role, and wipes all ${input.activeCountries} active ${input.activeCountries === 1 ? 'country' : 'countries'} with their stockpiles, players, and wars.`,
    'The category, the game log, and the domination threshold are kept. Nothing else survives, and none of it can be recovered.',
  );
  card.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(RESET_CONFIRM_ID)
        .setLabel('Reset the game')
        .setStyle(ButtonStyle.Danger),
    ),
  );
  return card;
}

/** What `/game config` reports back once it has changed something. */
export function configCard(input: {
  threshold: number;
  leader?: {code: string; territories: number};
}): ContainerBuilder {
  const leaderLine = input.leader
    ? `The largest empire is ${countryLabel(findCountry(input.leader.code)!)} with **${input.leader.territories}**.`
    : 'Nobody holds any territory yet.';
  return container(
    ACCENT.success,
    '## Domination threshold updated',
    `A country now wins the round at **${input.threshold}** territories.`,
    `${leaderLine} A country also wins by standing alone for ${formatDuration(GAME.lastCountryStandingDuration)}.`,
  );
}

export const gameCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('game')
    .setDescription('Admin controls for this server’s game')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand(subcommand =>
      subcommand
        .setName('reset')
        .setDescription('Wipe the world and start a fresh round'),
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('config')
        .setDescription('Change how the round is won')
        .addIntegerOption(option =>
          option
            .setName('threshold')
            .setDescription('Territories needed to win the round')
            .setMinValue(1)
            .setMaxValue(MAX_THRESHOLD)
            .setRequired(true),
        ),
    ),

  async execute(
    interaction: ChatInputCommandInteraction,
    ctx: CommandContext,
  ): Promise<void> {
    const guild = interaction.guild;
    if (!guild) return;

    await interaction.deferReply({flags: MessageFlags.Ephemeral});

    const config = getGuildConfig(ctx.db, guild.id);
    if (!config) {
      await interaction.editReply(
        v2EditReply(
          container(
            ACCENT.danger,
            '### Conquest is not set up in this server yet.',
            'Run `/setup category:<category>` first — there is no game to configure or reset.',
          ),
        ),
      );
      return;
    }

    if (interaction.options.getSubcommand() === 'config') {
      const threshold = interaction.options.getInteger('threshold', true);
      setDominationThreshold(ctx.db, guild.id, threshold);

      const counts = territoryCounts(ctx.db, guild.id);
      const leader = [...counts.entries()]
        .map(([code, territories]) => ({code, territories}))
        .sort((a, b) => b.territories - a.territories)[0];

      await interaction.editReply(v2EditReply(configCard({threshold, leader})));
      return;
    }

    const active = listCountriesByStatus(ctx.db, guild.id, 'active');
    const channels =
      listCountriesByStatus(ctx.db, guild.id, 'active').length +
      listCountriesByStatus(ctx.db, guild.id, 'defeated').length;

    await interaction.editReply(
      v2EditReply(
        resetConfirmationCard({activeCountries: active.length, channels}),
      ),
    );
  },
};
