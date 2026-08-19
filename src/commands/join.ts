import {
  ChannelType,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import type {
  AutocompleteInteraction,
  CategoryChannel,
  ChatInputCommandInteraction,
  ContainerBuilder,
} from 'discord.js';
import {
  DISCORD_LIMITS,
  INVASIONS,
  formatDuration,
} from '../config/constants.js';
import {
  COUNTRIES,
  countryLabel,
  findCountry,
  searchCountries,
} from '../data/countries.js';
import {getCountry, listCountries} from '../db/countries.js';
import {getGuildConfig} from '../db/guild-config.js';
import {getPlayer, joinCountry} from '../db/players.js';
import {announce} from '../discord/log.js';
import {
  ACCENT,
  container,
  relativeTime,
  v2EditReply,
  v2Message,
} from '../discord/ui.js';
import {foundCountry, grantCountryRole} from '../game/country-lifecycle.js';
import {decideJoin, joinableCodes} from '../game/policy.js';
import type {JoinRefusal} from '../game/policy.js';
import {remainingCategorySlots} from './setup.js';
import type {Command, CommandContext} from './types.js';

export const joinCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('join')
    .setDescription('Join a country and start playing')
    .setContexts(InteractionContextType.Guild)
    .addStringOption(option =>
      option
        .setName('country')
        .setDescription('The country to join')
        .setAutocomplete(true)
        .setRequired(true),
    ),

  /**
   * Offers only countries that can actually be joined, answered entirely from
   * the database and the channel cache — never from the Discord API, which
   * would blow Discord's ~3s budget.
   */
  async autocomplete(
    interaction: AutocompleteInteraction,
    ctx: CommandContext,
  ): Promise<void> {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.respond([]);
      return;
    }

    const config = getGuildConfig(ctx.db, guildId);
    const category = config
      ? interaction.guild?.channels.cache.get(config.categoryId)
      : undefined;
    const slots =
      category?.type === ChannelType.GuildCategory
        ? remainingCategorySlots(category)
        : 0;

    const joinable = joinableCodes(
      listCountries(ctx.db, guildId),
      COUNTRIES.map(country => country.code),
      slots,
    );
    const matches = searchCountries(
      COUNTRIES.filter(country => joinable.has(country.code)),
      interaction.options.getFocused(),
    ).slice(0, DISCORD_LIMITS.autocompleteChoices);

    await interaction.respond(
      matches.map(country => ({
        name: countryLabel(country),
        value: country.code,
      })),
    );
  },

  async execute(
    interaction: ChatInputCommandInteraction,
    ctx: CommandContext,
  ): Promise<void> {
    const guild = interaction.guild;
    if (!guild) return;

    await interaction.deferReply({flags: MessageFlags.Ephemeral});

    const requested = interaction.options.getString('country', true);
    const country = findCountry(requested);
    const config = getGuildConfig(ctx.db, guild.id);

    const fetched = config
      ? await guild.channels.fetch(config.categoryId).catch(() => null)
      : null;
    const category: CategoryChannel | undefined =
      fetched?.type === ChannelType.GuildCategory ? fetched : undefined;

    const now = Date.now();
    const decision = decideJoin({
      configured: Boolean(config && category),
      known: Boolean(country),
      country: country ? getCountry(ctx.db, guild.id, country.code) : undefined,
      player: getPlayer(ctx.db, guild.id, interaction.user.id),
      slotsRemaining: category ? remainingCategorySlots(category) : 0,
      now,
    });

    if (!decision.ok) {
      await interaction.editReply(
        v2EditReply(refusalCard(decision.refusal, requested)),
      );
      return;
    }

    // The decision only says yes once both of these are known.
    const target = country!;
    const existing = getCountry(ctx.db, guild.id, target.code);

    let roleId: string;
    let channelId: string;
    if (decision.activates) {
      const presence = await foundCountry(
        ctx.db,
        guild,
        category!,
        target,
        now,
      );
      roleId = presence.role.id;
      channelId = presence.channel.id;
    } else {
      roleId = existing!.roleId!;
      channelId = existing!.channelId!;
    }

    const member = await guild.members.fetch(interaction.user.id);
    await grantCountryRole(member, roleId, `Conquest: joined ${target.name}`);
    joinCountry(ctx.db, {
      guildId: guild.id,
      userId: interaction.user.id,
      code: target.code,
      now,
    });

    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (channel?.isTextBased()) {
      await channel
        .send(v2Message(welcomeCard(`${member}`, target, decision.activates)))
        .catch(() => undefined);
    }

    if (decision.activates) {
      await announce(
        ctx.db,
        guild,
        container(
          ACCENT.neutral,
          `## ${countryLabel(target)} has entered the game`,
          `Founded by ${member}. Cannot be invaded until ${relativeTime(now + INVASIONS.newCountryProtection)}.`,
        ),
      );
    }

    await interaction.editReply(
      v2EditReply(
        container(
          ACCENT.success,
          `## You joined ${countryLabel(target)}`,
          decision.activates
            ? `You founded ${target.name}. Its private channel is <#${channelId}>.`
            : `Plan with your countrymen in <#${channelId}>.`,
          'Gather with `/farm`, `/mine`, and `/recruit`. See where you stand with `/resources` and `/country`.',
        ),
      ),
    );
  },
};

/** The message posted in a country's channel when someone arrives. */
function welcomeCard(
  member: string,
  country: {flag: string; name: string},
  founded: boolean,
): ContainerBuilder {
  if (!founded) {
    return container(
      ACCENT.success,
      `### ${member} joined ${country.flag} ${country.name}`,
      'Welcome. Check `/resources` to see what the country has to work with.',
    );
  }
  return container(
    ACCENT.success,
    `## ${country.flag} ${country.name} rises`,
    `${member} founded ${country.name}. Gather with \`/farm\`, \`/mine\`, and \`/recruit\`, then vote on where to march.`,
    `New countries cannot be invaded for ${formatDuration(INVASIONS.newCountryProtection)} — use it.`,
  );
}

/** Turns a refusal into a card that says what to do instead. */
function refusalCard(
  refusal: JoinRefusal,
  requested: string,
): ContainerBuilder {
  switch (refusal.kind) {
    case 'not_configured':
      return container(
        ACCENT.danger,
        '### Conquest is not set up in this server yet.',
        'Ask an admin to run `/setup category:<category>` first.',
      );
    case 'unknown_country':
      return container(
        ACCENT.danger,
        `### There is no country called “${requested}”.`,
        'Pick one from the autocomplete list — it only offers countries you can actually join.',
      );
    case 'already_joined': {
      const current = findCountry(refusal.code);
      return container(
        ACCENT.danger,
        `### You are already in ${current ? countryLabel(current) : refusal.code}.`,
        'Run `/leave` first if you want to switch — the rejoin cooldown makes switching mid-war costly.',
      );
    }
    case 'rejoin_cooldown':
      return container(
        ACCENT.danger,
        '### You left a country too recently.',
        `You can join again ${relativeTime(refusal.until)}. The cooldown stops country-hopping while invasions are in flight.`,
      );
    case 'defeated': {
      const owner = refusal.ownerCode
        ? findCountry(refusal.ownerCode)
        : undefined;
      return container(
        ACCENT.danger,
        '### That country has been conquered.',
        owner
          ? `It is territory of ${countryLabel(owner)} now. Pick another country — or join ${owner.name} itself.`
          : 'Conquered countries cannot be joined. Pick another one.',
      );
    }
    case 'at_capacity':
      return container(
        ACCENT.danger,
        '### Country limit reached — join an existing country instead.',
        `Discord allows ${DISCORD_LIMITS.channelsPerCategory} channels per category and conquered countries keep theirs, so no new countries can be founded. ` +
          'Autocomplete is only offering countries already in play.',
      );
  }
}
