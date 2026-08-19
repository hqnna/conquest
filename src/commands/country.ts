import {
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  ContainerBuilder,
} from 'discord.js';
import {DISCORD_LIMITS} from '../config/constants.js';
import {
  COUNTRIES,
  countryLabel,
  findCountry,
  searchCountries,
} from '../data/countries.js';
import type {CountryData} from '../data/countries.js';
import {getCountry, listCountries, listTerritories} from '../db/countries.js';
import type {CountryState} from '../db/countries.js';
import {getPlayer, listCountryMembers} from '../db/players.js';
import {ACCENT, container, relativeTime, v2EditReply} from '../discord/ui.js';
import type {Command, CommandContext} from './types.js';

/** Renders the timers that decide whether a country can fight right now. */
function statusLines(state: CountryState, now: number): string[] {
  const lines: string[] = [];
  if (state.protectedUntil && state.protectedUntil > now) {
    lines.push(
      `🛡️ New-country protection until ${relativeTime(state.protectedUntil)}`,
    );
  }
  if (state.defenseImmunityUntil && state.defenseImmunityUntil > now) {
    lines.push(
      `🛡️ Immune after a successful defence until ${relativeTime(state.defenseImmunityUntil)}`,
    );
  }
  if (state.invadeCooldownUntil && state.invadeCooldownUntil > now) {
    lines.push(
      `⏳ Cannot declare an invasion until ${relativeTime(state.invadeCooldownUntil)}`,
    );
  }
  return lines;
}

/**
 * Builds a country's detail card.
 *
 * The stockpile is included only for the country's own members — knowing what
 * a rival is sitting on would give away every invasion.
 */
export function countryCard(input: {
  country: CountryData;
  state: CountryState | undefined;
  members: string[];
  territories: CountryState[];
  viewerIsMember: boolean;
  now: number;
}): ContainerBuilder {
  const {country, state, members, territories} = input;

  if (!state || state.status === 'inactive') {
    return container(
      ACCENT.neutral,
      `## ${countryLabel(country)}`,
      'Unclaimed. Nobody has founded this country yet.',
      'Run `/join country:' + country.name + '` to raise its flag.',
    );
  }

  if (state.status === 'defeated') {
    const owner = state.ownerCode ? findCountry(state.ownerCode) : undefined;
    return container(
      ACCENT.danger,
      `## 🏳️ ${country.flag} ${country.name}`,
      owner
        ? `Conquered. It is territory of ${countryLabel(owner)}.`
        : 'Conquered.',
      state.channelId
        ? `Its channel survives as a read-only archive: <#${state.channelId}>.`
        : '',
    );
  }

  const roster =
    members.length > 0
      ? members.map(id => `<@${id}>`).join(', ')
      : 'Nobody — this country is about to be disbanded.';

  const territoryList =
    territories.length > 0
      ? territories
          .map(territory => {
            const data = findCountry(territory.code);
            return data ? countryLabel(data) : territory.code;
          })
          .join(', ')
      : 'None yet.';

  const timers = statusLines(state, input.now);

  return container(
    ACCENT.neutral,
    `## ${countryLabel(country)}`,
    [
      `**Players (${members.length}):** ${roster}`,
      `**Territories (${territories.length}):** ${territoryList}`,
    ].join('\n'),
    input.viewerIsMember
      ? `**Stockpile** — 🌾 ${state.food} food · 🪙 ${state.gold} gold · ⚔️ ${state.troops} troops`
      : '*Only this country’s own players can see its stockpile.*',
    timers.join('\n'),
  );
}

export const countryCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('country')
    .setDescription('Look up a country: players, territories, and status')
    .setContexts(InteractionContextType.Guild)
    .addStringOption(option =>
      option
        .setName('name')
        .setDescription('Country to look up (defaults to your own)')
        .setAutocomplete(true)
        .setRequired(false),
    ),

  /** Offers every country this game has touched, fallen empires included. */
  async autocomplete(
    interaction: AutocompleteInteraction,
    ctx: CommandContext,
  ): Promise<void> {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.respond([]);
      return;
    }

    const touched = new Set(
      listCountries(ctx.db, guildId)
        .filter(state => state.status !== 'inactive')
        .map(state => state.code),
    );
    const pool = COUNTRIES.filter(country => touched.has(country.code));
    const matches = searchCountries(
      pool.length > 0 ? pool : COUNTRIES,
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

    const player = getPlayer(ctx.db, guild.id, interaction.user.id);
    const requested =
      interaction.options.getString('name') ?? player?.countryCode ?? '';
    const country = findCountry(requested);

    if (!country) {
      await interaction.editReply(
        v2EditReply(
          container(
            ACCENT.danger,
            requested
              ? `### There is no country called “${requested}”.`
              : '### You are not in a country.',
            'Name a country, or run `/join` to claim one of your own.',
          ),
        ),
      );
      return;
    }

    const state = getCountry(ctx.db, guild.id, country.code);
    await interaction.editReply(
      v2EditReply(
        countryCard({
          country,
          state,
          members: listCountryMembers(ctx.db, guild.id, country.code),
          territories: listTerritories(ctx.db, guild.id, country.code),
          viewerIsMember: player?.countryCode === country.code,
          now: Date.now(),
        }),
      ),
    );
  },
};
