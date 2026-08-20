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
import {formatDuration} from '../config/constants.js';
import {TUNABLES, TUNABLES_BY_KEY} from '../config/settings.js';
import type {Tunable} from '../config/settings.js';
import {listCountriesByStatus} from '../db/countries.js';
import {getGuildConfig} from '../db/guild-config.js';
import {
  clearOverride,
  clearOverrides,
  forgetSettings,
  setOverride,
  settingsFor,
  summariseSettings,
} from '../db/guild-settings.js';
import type {SettingSummary} from '../db/guild-settings.js';
import {ACCENT, container, v2EditReply} from '../discord/ui.js';
import type {Command, CommandContext} from './types.js';

/** The `customId` of the button that actually wipes a guild's game. */
export const RESET_CONFIRM_ID = 'game:reset:confirm';

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
    'The category, the game log, and this server’s settings are kept. Nothing else survives, and none of it can be recovered.',
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

/** How a tunable's value reads, in the unit an admin types. */
export function formatSetting(tunable: Tunable, value: number): string {
  switch (tunable.unit) {
    case 'minutes':
      return value === 0 ? 'none' : formatDuration(value * 60_000);
    case 'percent':
      return `${value}%`;
    case 'count':
      return String(value);
  }
}

/** What `/game tune` reports back once it has changed something. */
export function tunedCard(input: {
  tunable: Tunable;
  value: number;
  previous: number;
}): ContainerBuilder {
  return container(
    ACCENT.success,
    `## ${input.tunable.label} changed`,
    `${input.tunable.description}\n**${formatSetting(input.tunable, input.previous)}** → **${formatSetting(input.tunable, input.value)}**`,
    'It applies from now on. Deadlines already running keep the value they started with, so a war in progress is not retuned underneath the countries fighting it.',
  );
}

/** What `/game settings` shows: every setting, and which were changed. */
export function settingsCard(
  summaries: readonly SettingSummary[],
): ContainerBuilder {
  const changed = summaries.filter(summary => !summary.isDefault);
  const lines = summaries.map(
    summary =>
      `${summary.isDefault ? '·' : '✏️'} **${summary.tunable.label}** — ${formatSetting(summary.tunable, summary.value)}`,
  );

  return container(
    ACCENT.neutral,
    '## This server’s settings',
    lines.join('\n'),
    changed.length > 0
      ? `✏️ marks the ${changed.length} setting${changed.length === 1 ? '' : 's'} this server has changed. ` +
          'Put one back with `/game tune` and no value, or all of them with `/game reset-settings`.'
      : 'Everything is as Conquest ships it. Change one with `/game tune`.',
  );
}

/**
 * Changes one setting, or puts it back.
 *
 * Bounds are checked here so an admin is told what the setting will accept,
 * and again in the repository, because a bad number stored is a bad number
 * every time it is read afterwards.
 */
async function tune(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
  guildId: string,
): Promise<void> {
  const key = interaction.options.getString('setting', true);
  const tunable = TUNABLES_BY_KEY.get(key);
  if (!tunable) {
    await interaction.editReply(
      v2EditReply(
        container(
          ACCENT.danger,
          '### Conquest has no such setting.',
          'Pick one from the list — it only offers settings that exist.',
        ),
      ),
    );
    return;
  }

  const previous = tunable.read(settingsFor(ctx.db, guildId));
  const value = interaction.options.getInteger('value');

  if (value === null) {
    const had = clearOverride(ctx.db, guildId, tunable.key);
    forgetSettings(guildId);
    const restored = tunable.read(settingsFor(ctx.db, guildId));
    await interaction.editReply(
      v2EditReply(
        container(
          ACCENT.success,
          had
            ? `## ${tunable.label} restored`
            : `## ${tunable.label} was already the default`,
          `It is **${formatSetting(tunable, restored)}**, which is what Conquest ships with.`,
        ),
      ),
    );
    return;
  }

  if (value < tunable.min || value > tunable.max) {
    await interaction.editReply(
      v2EditReply(
        container(
          ACCENT.danger,
          `### ${tunable.label} must be between ${tunable.min} and ${tunable.max}.`,
          `${tunable.description}`,
          `It is currently **${formatSetting(tunable, previous)}**, and values are given in ${tunable.unit === 'count' ? 'whole units' : tunable.unit}.`,
        ),
      ),
    );
    return;
  }

  setOverride(ctx.db, guildId, tunable.key, value, Date.now());
  forgetSettings(guildId);

  await interaction.editReply(
    v2EditReply(tunedCard({tunable, value, previous})),
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
        .setName('settings')
        .setDescription('Show every setting, and what this server has changed'),
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('tune')
        .setDescription('Change one setting for this server')
        .addStringOption(option =>
          option
            .setName('setting')
            .setDescription('What to change')
            .setRequired(true)
            // A small, fixed set, so these are choices rather than
            // autocomplete.
            .addChoices(
              ...TUNABLES.map(tunable => ({
                name: tunable.label,
                value: tunable.key,
              })),
            ),
        )
        .addIntegerOption(option =>
          option
            .setName('value')
            .setDescription(
              'The new value; leave it out to restore the default',
            )
            .setRequired(false),
        ),
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('reset-settings')
        .setDescription('Put every setting back to what Conquest ships with'),
    ),

  async execute(
    interaction: ChatInputCommandInteraction,
    ctx: CommandContext,
  ): Promise<void> {
    const guild = interaction.guild;
    if (!guild) return;

    await interaction.deferReply({flags: MessageFlags.Ephemeral});

    if (!getGuildConfig(ctx.db, guild.id)) {
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

    switch (interaction.options.getSubcommand()) {
      case 'settings':
        await interaction.editReply(
          v2EditReply(settingsCard(summariseSettings(ctx.db, guild.id))),
        );
        return;

      case 'tune':
        await tune(interaction, ctx, guild.id);
        return;

      case 'reset-settings': {
        const cleared = clearOverrides(ctx.db, guild.id);
        forgetSettings(guild.id);
        await interaction.editReply(
          v2EditReply(
            container(
              ACCENT.success,
              '## Settings restored',
              cleared > 0
                ? `Put ${cleared} setting${cleared === 1 ? '' : 's'} back to what Conquest ships with.`
                : 'Nothing had been changed; everything was already as Conquest ships it.',
            ),
          ),
        );
        return;
      }

      default: {
        const active = listCountriesByStatus(ctx.db, guild.id, 'active');
        const channels =
          active.length +
          listCountriesByStatus(ctx.db, guild.id, 'defeated').length;
        await interaction.editReply(
          v2EditReply(
            resetConfirmationCard({
              activeCountries: active.length,
              channels,
            }),
          ),
        );
      }
    }
  },
};
