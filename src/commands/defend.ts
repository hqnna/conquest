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
import {countryLabel, findCountry} from '../data/countries.js';
import {getCountry} from '../db/countries.js';
import type {Stake} from '../db/invasions.js';
import {getPlayer} from '../db/players.js';
import type {Stockpile} from '../db/resources.js';
import {stakeLine} from '../discord/invasion-ui.js';
import {ACCENT, container, relativeTime, v2EditReply} from '../discord/ui.js';
import {openDefenseVote} from '../game/invasion-flow.js';
import {proposeDefense} from '../game/invasions.js';
import type {DefendRefusal} from '../game/invasions.js';
import {stakeSuggestions} from './invade.js';
import type {Command, CommandContext} from './types.js';

/** Turns a refusal into a card that says what to do next. */
export function defendRefusalCard(refusal: DefendRefusal): ContainerBuilder {
  switch (refusal.kind) {
    case 'not_in_country':
      return container(
        ACCENT.danger,
        '### You are not in a country.',
        'Run `/join country:<name>` first.',
      );
    case 'not_under_attack':
      return container(
        ACCENT.neutral,
        '### Nobody is invading you.',
        'There is nothing to defend against. `/defend` only works while your country is under attack.',
      );
    case 'window_closed':
      return container(
        ACCENT.danger,
        '### The defence window has closed.',
        'The battle is being fought with whatever was committed before now.',
      );
    case 'proposal_pending':
      return container(
        ACCENT.warning,
        '### Your country is already voting on a defence.',
        `${stakeLine(refusal.proposal.stake)} is on the table until ${relativeTime(refusal.proposal.voteDeadline)}. ` +
          'Vote it down first if you want to propose something else.',
      );
    case 'already_defended':
      return container(
        ACCENT.warning,
        '### Your country has already committed its defence.',
        'What is committed stands until the battle. Only one defence is raised per invasion.',
      );
    case 'no_troops':
      return container(
        ACCENT.danger,
        '### A defence needs troops.',
        'Commit at least one — supplies alone do not hold ground.',
      );
    case 'cannot_afford':
      return container(
        ACCENT.danger,
        '### Your country cannot cover that defence.',
        `It holds ⚔️ ${refusal.stockpile.troops} troops · 🪙 ${refusal.stockpile.gold} gold · 🌾 ${refusal.stockpile.food} food.`,
        'Commit less — a defence that is voted down costs nothing, but one you cannot pay for never stands.',
      );
  }
}

export const defendCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('defend')
    .setDescription('Propose a defence against the invasion of your country')
    .setContexts(InteractionContextType.Guild)
    .addIntegerOption(option =>
      option
        .setName('troops')
        .setDescription('Troops to commit to the defence')
        .setMinValue(1)
        .setAutocomplete(true)
        .setRequired(true),
    )
    .addIntegerOption(option =>
      option
        .setName('gold')
        .setDescription('Gold to commit as war supplies')
        .setMinValue(0)
        .setAutocomplete(true)
        .setRequired(false),
    )
    .addIntegerOption(option =>
      option
        .setName('food')
        .setDescription('Food to commit as war supplies')
        .setMinValue(0)
        .setAutocomplete(true)
        .setRequired(false),
    ),

  /** Suggests fractions of what the country has left to defend with. */
  async autocomplete(
    interaction: AutocompleteInteraction,
    ctx: CommandContext,
  ): Promise<void> {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.respond([]);
      return;
    }
    const player = getPlayer(ctx.db, guildId, interaction.user.id);
    const country = player?.countryCode
      ? getCountry(ctx.db, guildId, player.countryCode)
      : undefined;
    const focused = interaction.options.getFocused(true);
    const available = country
      ? (
          {
            troops: country.troops,
            gold: country.gold,
            food: country.food,
          } as Stockpile
        )[focused.name as keyof Stockpile]
      : 0;
    await interaction.respond(stakeSuggestions(available ?? 0));
  },

  async execute(
    interaction: ChatInputCommandInteraction,
    ctx: CommandContext,
  ): Promise<void> {
    const guild = interaction.guild;
    if (!guild) return;

    await interaction.deferReply({flags: MessageFlags.Ephemeral});

    const player = getPlayer(ctx.db, guild.id, interaction.user.id);
    if (!player?.countryCode) {
      await interaction.editReply(
        v2EditReply(defendRefusalCard({kind: 'not_in_country'})),
      );
      return;
    }

    const stake: Stake = {
      troops: interaction.options.getInteger('troops', true),
      gold: interaction.options.getInteger('gold') ?? 0,
      food: interaction.options.getInteger('food') ?? 0,
    };
    const now = Date.now();

    const proposed = proposeDefense(ctx.db, {
      guildId: guild.id,
      code: player.countryCode,
      proposerId: interaction.user.id,
      stake,
      now,
    });

    if (!proposed.ok) {
      await interaction.editReply(
        v2EditReply(defendRefusalCard(proposed.refusal)),
      );
      return;
    }

    await openDefenseVote(
      ctx.db,
      guild,
      proposed.invasion,
      proposed.proposal,
      now,
    );

    const attacker = findCountry(proposed.invasion.attackerCode);
    await interaction.editReply(
      v2EditReply(
        container(
          ACCENT.defender,
          `## You proposed a defence against ${attacker ? countryLabel(attacker) : proposed.invasion.attackerCode}`,
          `**Defence:** ${stakeLine(stake)}\nYour countrymen are voting on it in your country channel.`,
          `The battle is fought ${relativeTime(proposed.invasion.defenseDeadline!)} whatever happens, so approving early buys nothing — but leaving it too late means fighting with nothing.`,
        ),
      ),
    );
  },
};
