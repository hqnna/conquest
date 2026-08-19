import {
  ChannelType,
  InteractionContextType,
  PermissionFlagsBits,
  MessageFlags,
  PermissionsBitField,
  SlashCommandBuilder,
} from 'discord.js';
import type {
  CategoryChannel,
  ChatInputCommandInteraction,
  Guild,
  GuildBasedChannel,
  TextChannel,
} from 'discord.js';
import {CHANNELS, DISCORD_LIMITS, GAME} from '../config/constants.js';
import {getGuildConfig, upsertGuildConfig} from '../db/guild-config.js';
import {
  ACCENT,
  container,
  errorReply,
  v2EditReply,
  v2Message,
} from '../discord/ui.js';
import type {Command, CommandContext} from './types.js';

/**
 * Permissions Conquest cannot run without: it creates and archives country
 * channels, and creates, assigns, and deletes country roles.
 */
export const REQUIRED_BOT_PERMISSIONS = [
  {flag: PermissionFlagsBits.ManageChannels, name: 'Manage Channels'},
  {flag: PermissionFlagsBits.ManageRoles, name: 'Manage Roles'},
  {flag: PermissionFlagsBits.ViewChannel, name: 'View Channels'},
  {flag: PermissionFlagsBits.SendMessages, name: 'Send Messages'},
] as const;

/**
 * Names the permissions Conquest is missing, in the order it needs them.
 *
 * @returns an empty array when everything required is granted.
 */
export function missingBotPermissions(
  permissions: Readonly<PermissionsBitField> | null,
): string[] {
  if (!permissions) {
    return REQUIRED_BOT_PERMISSIONS.map(permission => permission.name);
  }
  return REQUIRED_BOT_PERMISSIONS.filter(
    permission => !permissions.has(permission.flag),
  ).map(permission => permission.name);
}

/**
 * Finds the log channel to use: the guild's existing one if it is still a
 * usable text channel, otherwise `undefined` so the caller creates a new one.
 */
export function resolveExistingLogChannel(
  guild: Guild,
  logChannelId: string | undefined,
): TextChannel | undefined {
  if (!logChannelId) return undefined;
  const channel: GuildBasedChannel | undefined =
    guild.channels.cache.get(logChannelId) ?? undefined;
  return channel?.type === ChannelType.GuildText ? channel : undefined;
}

/**
 * How many country channels still fit in the category. Archived channels from
 * defeated countries count against Discord's cap and Conquest never frees a
 * slot, so this shrinks over a round.
 */
export function remainingCategorySlots(category: CategoryChannel): number {
  return Math.max(
    0,
    DISCORD_LIMITS.channelsPerCategory - category.children.cache.size,
  );
}

export const setupCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Configure Conquest for this server (one-time setup)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild)
    .addChannelOption(option =>
      option
        .setName('category')
        .setDescription('Category Conquest will create country channels in')
        .addChannelTypes(ChannelType.GuildCategory)
        .setRequired(true),
    ),

  async execute(
    interaction: ChatInputCommandInteraction,
    ctx: CommandContext,
  ): Promise<void> {
    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply(
        errorReply(
          'Conquest is a server game.',
          'Run `/setup` from inside the server you want to play in.',
        ),
      );
      return;
    }

    const me = guild.members.me ?? (await guild.members.fetchMe());
    const missing = missingBotPermissions(me.permissions);
    if (missing.length > 0) {
      await interaction.reply(
        errorReply(
          `Conquest is missing ${missing.length === 1 ? 'a permission' : 'permissions'}.`,
          `Grant Conquest **${missing.join('**, **')}** in Server Settings → Roles, then run \`/setup\` again. ` +
            'Conquest creates a channel and a role per country and cannot run without them.',
        ),
      );
      return;
    }

    const category = interaction.options.getChannel('category', true);
    if (category.type !== ChannelType.GuildCategory) {
      await interaction.reply(
        errorReply(
          'That channel is not a category.',
          'Pick a category from the channel picker — Conquest creates its country channels inside one.',
        ),
      );
      return;
    }

    await interaction.deferReply({flags: MessageFlags.Ephemeral});

    const resolved = (await guild.channels.fetch(
      category.id,
    )) as CategoryChannel;
    const existing = getGuildConfig(ctx.db, guild.id);

    let logChannel = resolveExistingLogChannel(guild, existing?.logChannelId);
    let logChannelCreated = false;
    if (!logChannel) {
      logChannel = await guild.channels.create({
        name: CHANNELS.gameLogName,
        type: ChannelType.GuildText,
        // Deliberately outside the category: Discord caps a category at 50
        // channels and archived country channels never free their slot, so
        // every slot in the category is reserved for countries.
        topic:
          'Conquest game log — declarations, battles, conquests, and resets.',
        reason: 'Conquest setup: public game log',
      });
      logChannelCreated = true;
    }

    const config = upsertGuildConfig(ctx.db, {
      guildId: guild.id,
      categoryId: resolved.id,
      logChannelId: logChannel.id,
    });

    const occupied = resolved.children.cache.size;
    const warning =
      occupied > 0
        ? `⚠️ **${resolved.name}** already holds ${occupied} channel${occupied === 1 ? '' : 's'}. ` +
          'Conquest will leave them alone, but they count against Discord’s 50-channel limit — ' +
          `only ${remainingCategorySlots(resolved)} more countries can be activated.`
        : '';

    await logChannel
      .send(
        v2Message(
          container(
            ACCENT.success,
            '## Conquest is ready',
            `Country channels will appear in **${resolved.name}**. ` +
              'Global events — declarations, battles, conquests, and the end of a round — are posted here.',
            'Run `/join` to claim a country, then `/help` to learn the game.',
          ),
        ),
      )
      .catch(() => undefined);

    await interaction.editReply(
      v2EditReply(
        container(
          ACCENT.success,
          '## Conquest is set up',
          [
            `**Country channels:** ${resolved}`,
            `**Game log:** ${logChannel}${logChannelCreated ? ' (created)' : ' (reused)'}`,
            `**Domination threshold:** ${config.dominationThreshold} territories`,
            `**Country slots available:** ${remainingCategorySlots(resolved)} of ${DISCORD_LIMITS.channelsPerCategory}`,
          ].join('\n'),
          warning,
          `Players can now run \`/join\`. Change the win condition later with \`/game config threshold:<n>\` (default ${GAME.defaultDominationThreshold}).`,
        ),
      ),
    );
  },
};
