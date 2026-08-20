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
import {countryLabel, findCountry} from '../data/countries.js';
import {getCountry} from '../db/countries.js';
import type {Invasion, Stake} from '../db/invasions.js';
import {getPlayer} from '../db/players.js';
import type {Stockpile} from '../db/resources.js';
import {stakeLine} from '../discord/invasion-ui.js';
import {ACCENT, container, relativeTime, v2EditReply} from '../discord/ui.js';
import {openDefenseVote} from '../game/invasion-flow.js';
import {proposeDefense} from '../game/invasions.js';
import type {DefendRefusal} from '../game/invasions.js';
import {stakeSuggestions} from './invade.js';
import {chooseWar, enemyLabel, enemyOf, warsToDefend} from './war-target.js';
import type {WarChoiceRefusal} from './war-target.js';
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

/** One line naming a war and what it is waiting for. */
export function warOptionLine(code: string, invasion: Invasion): string {
  const them = enemyLabel(enemyOf(code, invasion));
  switch (invasion.status) {
    case 'defense_window':
      return `• **${them}** — a defence is due ${relativeTime(invasion.defenseDeadline ?? 0)}`;
    case 'reinforcing':
      return `• **${them}** — reinforce or give up by ${relativeTime(invasion.reinforceDeadline ?? 0)}`;
    case 'war':
      return `• **${them}** — being fought, ${invasion.rounds} round${invasion.rounds === 1 ? '' : 's'} in`;
    default:
      return `• **${them}**`;
  }
}

/**
 * Says which war a command needed to be told about.
 *
 * @param verb what the player was trying to do, for the copy.
 */
export function warChoiceCard(
  refusal: WarChoiceRefusal,
  code: string,
  verb: 'defend' | 'reinforce' | 'surrender',
): ContainerBuilder {
  const command =
    verb === 'defend'
      ? '`/defend enemy:<country> troops:<n>`'
      : verb === 'reinforce'
        ? '`/reinforce enemy:<country> troops:<n>`'
        : '`/surrender enemy:<country>`';

  switch (refusal.kind) {
    case 'none':
      return verb === 'defend'
        ? container(
            ACCENT.neutral,
            '### Nobody is invading you.',
            'There is nothing to defend against. `/defend` only works while your country is under attack.',
          )
        : container(
            ACCENT.neutral,
            '### There is nothing to answer.',
            'A country reinforces or gives up only once its forces in one war are spent and it is asked.',
          );
    case 'ambiguous':
      return container(
        ACCENT.warning,
        '### Which war?',
        'Your country is fighting more than one, so name the enemy:',
        refusal.candidates
          .map(invasion => warOptionLine(code, invasion))
          .join('\n'),
        `Run ${command}.`,
      );
    case 'unknown':
      return container(
        ACCENT.danger,
        `### No such war with “${enemyLabel(refusal.requested)}”.`,
        'These are the wars this applies to:',
        refusal.candidates
          .map(invasion => warOptionLine(code, invasion))
          .join('\n'),
      );
  }
}

/** Offers the enemies a command applies to, straight from the database. */
export async function suggestEnemies(
  interaction: AutocompleteInteraction,
  ctx: CommandContext,
  wars: (db: CommandContext['db'], guildId: string, code: string) => Invasion[],
): Promise<void> {
  const guildId = interaction.guildId;
  const player = guildId
    ? getPlayer(ctx.db, guildId, interaction.user.id)
    : undefined;
  if (!guildId || !player?.countryCode) {
    await interaction.respond([]);
    return;
  }
  const code = player.countryCode;
  const typed = interaction.options.getFocused().toLowerCase();
  await interaction.respond(
    wars(ctx.db, guildId, code)
      .map(invasion => enemyOf(code, invasion))
      .filter(enemy => enemyLabel(enemy).toLowerCase().includes(typed))
      .slice(0, DISCORD_LIMITS.autocompleteChoices)
      .map(enemy => ({name: enemyLabel(enemy), value: enemy})),
  );
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
    )
    .addStringOption(option =>
      option
        .setName('enemy')
        .setDescription(
          'Which invader to answer (only needed while fighting several)',
        )
        .setAutocomplete(true)
        .setRequired(false),
    ),

  /**
   * Suggests the invaders to answer, and fractions of what the country has
   * left to defend with.
   */
  async autocomplete(
    interaction: AutocompleteInteraction,
    ctx: CommandContext,
  ): Promise<void> {
    const focused = interaction.options.getFocused(true);
    if (focused.name === 'enemy') {
      await suggestEnemies(interaction, ctx, warsToDefend);
      return;
    }
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.respond([]);
      return;
    }
    const player = getPlayer(ctx.db, guildId, interaction.user.id);
    const country = player?.countryCode
      ? getCountry(ctx.db, guildId, player.countryCode)
      : undefined;
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

    const chosen = chooseWar({
      code: player.countryCode,
      candidates: warsToDefend(ctx.db, guild.id, player.countryCode),
      requested: interaction.options.getString('enemy'),
    });
    if (!chosen.ok) {
      await interaction.editReply(
        v2EditReply(
          warChoiceCard(chosen.refusal, player.countryCode, 'defend'),
        ),
      );
      return;
    }

    const proposed = proposeDefense(ctx.db, {
      guildId: guild.id,
      code: player.countryCode,
      invasionId: chosen.invasion.id,
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
