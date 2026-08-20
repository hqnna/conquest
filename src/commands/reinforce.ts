import {
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
} from 'discord.js';
import {countryLabel, findCountry} from '../data/countries.js';
import {getCountry} from '../db/countries.js';
import type {Stake} from '../db/invasions.js';
import {getPlayer} from '../db/players.js';
import type {Stockpile} from '../db/resources.js';
import {stakeLine} from '../discord/invasion-ui.js';
import {ACCENT, container, relativeTime, v2EditReply} from '../discord/ui.js';
import {endWar, openReinforcementVote} from '../game/invasion-flow.js';
import {proposeReinforcement} from '../game/invasions.js';
import {defendRefusalCard, suggestEnemies, warChoiceCard} from './defend.js';
import {stakeSuggestions} from './invade.js';
import {chooseWar, warsAwaitingAnswer} from './war-target.js';
import type {Command, CommandContext} from './types.js';

/** The enemy in one war, as it reads in a reply. */
function countryName(
  invasion: {attackerCode: string; defenderCode: string},
  code: string,
): string {
  const enemy = findCountry(
    invasion.attackerCode === code
      ? invasion.defenderCode
      : invasion.attackerCode,
  );
  return enemy ? countryLabel(enemy) : '?';
}

/** Reads the three stake options off the interaction. */
function readStake(interaction: ChatInputCommandInteraction): Stake {
  return {
    troops: interaction.options.getInteger('troops', true),
    gold: interaction.options.getInteger('gold') ?? 0,
    food: interaction.options.getInteger('food') ?? 0,
  };
}

/** Suggests the wars awaiting an answer, and what is left at home to send. */
async function suggestReinforcement(
  interaction: AutocompleteInteraction,
  ctx: CommandContext,
): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name === 'enemy') {
    await suggestEnemies(interaction, ctx, warsAwaitingAnswer);
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
}

export const reinforceCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('reinforce')
    .setDescription('Send fresh forces to a war your country is losing')
    .setContexts(InteractionContextType.Guild)
    .addIntegerOption(option =>
      option
        .setName('troops')
        .setDescription('Troops to send')
        .setMinValue(1)
        .setAutocomplete(true)
        .setRequired(true),
    )
    .addIntegerOption(option =>
      option
        .setName('gold')
        .setDescription('Gold to send as war supplies')
        .setMinValue(0)
        .setAutocomplete(true)
        .setRequired(false),
    )
    .addIntegerOption(option =>
      option
        .setName('food')
        .setDescription('Food to send as war supplies')
        .setMinValue(0)
        .setAutocomplete(true)
        .setRequired(false),
    )
    .addStringOption(option =>
      option
        .setName('enemy')
        .setDescription(
          'Which war to send them to (only needed while fighting several)',
        )
        .setAutocomplete(true)
        .setRequired(false),
    ),

  autocomplete: suggestReinforcement,

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

    const chosen = chooseWar({
      code: player.countryCode,
      candidates: warsAwaitingAnswer(ctx.db, guild.id, player.countryCode),
      requested: interaction.options.getString('enemy'),
    });
    if (!chosen.ok) {
      await interaction.editReply(
        v2EditReply(
          warChoiceCard(chosen.refusal, player.countryCode, 'reinforce'),
        ),
      );
      return;
    }

    const now = Date.now();
    const proposed = proposeReinforcement(ctx.db, {
      guildId: guild.id,
      code: player.countryCode,
      invasionId: chosen.invasion.id,
      proposerId: interaction.user.id,
      stake: readStake(interaction),
      now,
    });

    if (!proposed.ok) {
      await interaction.editReply(
        v2EditReply(defendRefusalCard(proposed.refusal)),
      );
      return;
    }

    await openReinforcementVote(
      ctx.db,
      guild,
      proposed.invasion,
      proposed.proposal,
      now,
    );

    await interaction.editReply(
      v2EditReply(
        container(
          ACCENT.warning,
          `## You proposed reinforcements against ${countryName(chosen.invasion, player.countryCode)}`,
          `**Sending:** ${stakeLine(proposed.proposal.stake)}\nYour countrymen are voting on it now.`,
          `If it is not approved by ${relativeTime(proposed.proposal.voteDeadline)}, the war is over and your country has lost it.`,
        ),
      ),
    );
  },
};

export const surrenderCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('surrender')
    .setDescription('Give up a war your country is fighting')
    .setContexts(InteractionContextType.Guild)
    .addStringOption(option =>
      option
        .setName('enemy')
        .setDescription(
          'Which war to give up (only needed while fighting several)',
        )
        .setAutocomplete(true)
        .setRequired(false),
    ),

  /** Offers only the wars that are actually asking for an answer. */
  async autocomplete(
    interaction: AutocompleteInteraction,
    ctx: CommandContext,
  ): Promise<void> {
    await suggestEnemies(interaction, ctx, warsAwaitingAnswer);
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

    // Surrender is the answer to being asked to reinforce, not a way out of a
    // war a country is currently winning, so only wars that are asking are
    // offered at all.
    const chosen = chooseWar({
      code: player.countryCode,
      candidates: warsAwaitingAnswer(ctx.db, guild.id, player.countryCode),
      requested: interaction.options.getString('enemy'),
    });
    if (!chosen.ok) {
      await interaction.editReply(
        v2EditReply(
          warChoiceCard(chosen.refusal, player.countryCode, 'surrender'),
        ),
      );
      return;
    }

    const invasion = chosen.invasion;
    const side =
      invasion.attackerCode === player.countryCode ? 'attacker' : 'defender';
    const now = Date.now();
    await endWar(
      ctx.db,
      guild,
      invasion,
      side === 'attacker' ? 'defender' : 'attacker',
      'surrender',
      now,
    );

    const enemy = findCountry(
      side === 'attacker' ? invasion.defenderCode : invasion.attackerCode,
    );
    await interaction.editReply(
      v2EditReply(
        container(
          ACCENT.warning,
          '## Your country has given up',
          side === 'attacker'
            ? `The invasion of ${enemy ? countryLabel(enemy) : ''} is over. What was left of your army marched home.`
            : `${enemy ? countryLabel(enemy) : 'The invader'} has taken your country. Its players, stockpile, and territory go with it.`,
        ),
      ),
    );
  },
};
