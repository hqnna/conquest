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
  OverwriteData,
  TextChannel,
} from 'discord.js';
import {CHANNELS, DISCORD_LIMITS} from '../config/constants.js';
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
 * Permission overwrites that make the game log a read-only broadcast channel:
 * everyone can read it and react, only Conquest can post.
 *
 * The view permission is granted explicitly rather than inherited, so the log
 * stays public even when the category it sits in is not.
 */
export function logChannelOverwrites(
  everyoneRoleId: string,
  conquestId: string,
): OverwriteData[] {
  return [
    {
      id: everyoneRoleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AddReactions,
      ],
      deny: [
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.SendMessagesInThreads,
        PermissionFlagsBits.CreatePublicThreads,
        PermissionFlagsBits.CreatePrivateThreads,
      ],
    },
    {
      id: conquestId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
      ],
    },
  ];
}

/**
 * How many country channels still fit in the category. The game log and the
 * archived channels of defeated countries occupy slots too, and Conquest never
 * frees one, so this only shrinks over a round.
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
    const logChannelCreated = !logChannel;

    // Channels already in the category before Conquest touched it. A reused
    // game log is Conquest's own and is not worth warning about.
    const preexisting = resolved.children.cache.filter(
      channel => channel.id !== logChannel?.id,
    ).size;

    const overwrites = logChannelOverwrites(guild.roles.everyone.id, me.id);
    if (!logChannel) {
      logChannel = await guild.channels.create({
        name: CHANNELS.gameLogName,
        type: ChannelType.GuildText,
        parent: resolved.id,
        // Above every country channel: Discord appends new channels to the end
        // of a category, so the log stays pinned at the top as countries
        // activate.
        position: 0,
        permissionOverwrites: overwrites,
        topic:
          'Conquest game log — declarations, battles, conquests, and resets.',
        reason: 'Conquest setup: public game log',
      });
    } else {
      // Re-running /setup repairs the log: move it into the (possibly new)
      // category, back to the top, and restore read-only access.
      await logChannel.edit({
        parent: resolved.id,
        position: 0,
        permissionOverwrites: overwrites,
        reason: 'Conquest setup: game log placement and permissions',
      });
    }

    upsertGuildConfig(ctx.db, {
      guildId: guild.id,
      categoryId: resolved.id,
      logChannelId: logChannel.id,
    });

    const warning =
      preexisting > 0
        ? `⚠️ **${resolved.name}** already holds ${preexisting} other channel${preexisting === 1 ? '' : 's'}. ` +
          'Conquest will leave them alone, but they count against Discord’s ' +
          `${DISCORD_LIMITS.channelsPerCategory}-channel limit — only ` +
          `${remainingCategorySlots(resolved)} more countries can be activated.`
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
            `**Game log:** ${logChannel}${logChannelCreated ? ' (created)' : ' (reused)'} — read-only, pinned to the top of the category`,
            `**Country slots left:** ${remainingCategorySlots(resolved)} of ${DISCORD_LIMITS.channelsPerCategory} (the game log takes one)`,
          ].join('\n'),
          warning,
          'Players can now run `/join`. The round ends when one country has conquered every other one.',
        ),
      ),
    );
  },
};
