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
import {DISCORD_LIMITS, MERGES, formatDuration} from '../config/constants.js';
import {
  COUNTRIES,
  countryLabel,
  findCountry,
  searchCountries,
} from '../data/countries.js';
import {listCountriesByStatus} from '../db/countries.js';
import {getGuildConfig} from '../db/guild-config.js';
import {getPendingInvasionFor} from '../db/invasions.js';
import {castMergeVote, getPendingMergeFor} from '../db/merges.js';
import {getPlayer} from '../db/players.js';
import {ACCENT, container, v2EditReply} from '../discord/ui.js';
import {openOfferVote} from '../game/merge-flow.js';
import {proposeMerge} from '../game/merges.js';
import type {MergeRefusal} from '../game/merges.js';
import type {Command, CommandContext} from './types.js';

/** Countries this one could offer itself to right now. */
export function mergeTargets(input: {
  fromCode: string;
  active: ReadonlyArray<{code: string}>;
  busyCodes: ReadonlySet<string>;
}): string[] {
  return input.active
    .filter(country => country.code !== input.fromCode)
    .filter(country => !input.busyCodes.has(country.code))
    .map(country => country.code);
}

/** Turns a refusal into a card that says what to do next. */
export function mergeRefusalCard(
  refusal: MergeRefusal,
  requested: string,
): ContainerBuilder {
  switch (refusal.kind) {
    case 'not_configured':
      return container(
        ACCENT.danger,
        '### Conquest is not set up in this server yet.',
        'Ask an admin to run `/setup category:<category>` first.',
      );
    case 'not_in_country':
      return container(
        ACCENT.danger,
        '### You are not in a country.',
        'Run `/join country:<name>` — only a country can give itself to another.',
      );
    case 'unknown_country':
      return container(
        ACCENT.danger,
        `### There is no country called “${requested}”.`,
        'Pick one from the autocomplete list; it offers only countries that could take you in.',
      );
    case 'self':
      return container(
        ACCENT.danger,
        '### You cannot merge with yourselves.',
        'Pick another country.',
      );
    case 'target_inactive':
      return container(
        ACCENT.danger,
        '### Nobody holds that country.',
        'There is nobody there to merge with. Offer yourselves to a country somebody has joined.',
      );
    case 'target_defeated':
      return container(
        ACCENT.danger,
        '### That country has already fallen.',
        refusal.ownerCode
          ? `It is territory of ${countryLabel(findCountry(refusal.ownerCode)!)}. Offer yourselves to the empire that holds it instead.`
          : 'Offer yourselves to a country that still stands.',
      );
    case 'at_war':
      return container(
        ACCENT.warning,
        '### Your country is in a war.',
        'A country cannot be handed over mid-battle. See the war through first — you may not want to merge afterwards.',
      );
    case 'target_at_war':
      return container(
        ACCENT.warning,
        '### That country is in a war.',
        'Wait for it to resolve. Merging into a war would hand your people straight into it.',
      );
    case 'merge_pending':
      return container(
        ACCENT.warning,
        '### Your country already has a merge on the table.',
        'One offer at a time. Vote the current one through or down first.',
      );
    case 'target_merge_pending':
      return container(
        ACCENT.warning,
        '### That country is already deciding on a merge.',
        'Wait until they have answered it.',
      );
  }
}

export const mergeCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('merge')
    .setDescription('Propose giving your country to another one')
    .setContexts(InteractionContextType.Guild)
    .addStringOption(option =>
      option
        .setName('country')
        .setDescription('The country your own would become part of')
        .setAutocomplete(true)
        .setRequired(true),
    ),

  /**
   * Offers every other active country that is free to answer — nobody at war,
   * and nobody already deciding on a merge. Answered from the database, never
   * from the Discord API.
   */
  async autocomplete(
    interaction: AutocompleteInteraction,
    ctx: CommandContext,
  ): Promise<void> {
    const guildId = interaction.guildId;
    const player = guildId
      ? getPlayer(ctx.db, guildId, interaction.user.id)
      : undefined;
    const code = player?.countryCode;
    if (!guildId || !code) {
      await interaction.respond([]);
      return;
    }

    const active = listCountriesByStatus(ctx.db, guildId, 'active');
    const busy = new Set<string>();
    for (const country of active) {
      const pending =
        Boolean(getPendingInvasionFor(ctx.db, guildId, country.code)) ||
        Boolean(getPendingMergeFor(ctx.db, guildId, country.code));
      if (pending) busy.add(country.code);
    }

    const targets = new Set(
      mergeTargets({fromCode: code, active, busyCodes: busy}),
    );
    const matches = searchCountries(
      COUNTRIES.filter(country => targets.has(country.code)),
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
    const target = findCountry(requested);
    const player = getPlayer(ctx.db, guild.id, interaction.user.id);
    const now = Date.now();

    if (!getGuildConfig(ctx.db, guild.id)) {
      await interaction.editReply(
        v2EditReply(mergeRefusalCard({kind: 'not_configured'}, requested)),
      );
      return;
    }
    if (!player?.countryCode) {
      await interaction.editReply(
        v2EditReply(mergeRefusalCard({kind: 'not_in_country'}, requested)),
      );
      return;
    }
    if (!target) {
      await interaction.editReply(
        v2EditReply(mergeRefusalCard({kind: 'unknown_country'}, requested)),
      );
      return;
    }

    const proposed = proposeMerge(ctx.db, {
      guildId: guild.id,
      fromCode: player.countryCode,
      intoCode: target.code,
      proposerId: interaction.user.id,
      now,
    });

    if (!proposed.ok) {
      await interaction.editReply(
        v2EditReply(mergeRefusalCard(proposed.refusal, requested)),
      );
      return;
    }

    // Offering is approving: the proposer's own vote is already cast.
    castMergeVote(ctx.db, {
      mergeId: proposed.merge.id,
      kind: 'offer',
      userId: interaction.user.id,
      choice: 'approve',
      now,
    });

    await openOfferVote(ctx.db, guild, proposed.merge, now, ctx.map);

    await interaction.editReply(
      v2EditReply(
        container(
          ACCENT.warning,
          `## You proposed joining ${countryLabel(target)}`,
          'Your countrymen are voting in your country channel; your own approval is already counted.',
          `If they agree, ${countryLabel(target)} is asked to take you in, and has ${formatDuration(MERGES.voteWindow)} to answer. Only if both countries vote for it does anything move.`,
        ),
      ),
    );
  },
};
