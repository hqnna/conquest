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
import {getPendingInvasionFor} from '../db/invasions.js';
import type {Stake} from '../db/invasions.js';
import {getPlayer} from '../db/players.js';
import type {Stockpile} from '../db/resources.js';
import {stakeLine} from '../discord/invasion-ui.js';
import {ACCENT, container, relativeTime, v2EditReply} from '../discord/ui.js';
import {endWar, openReinforcementVote} from '../game/invasion-flow.js';
import {proposeReinforcement} from '../game/invasions.js';
import {defendRefusalCard} from './defend.js';
import {stakeSuggestions} from './invade.js';
import type {Command, CommandContext} from './types.js';

/** Reads the three stake options off the interaction. */
function readStake(interaction: ChatInputCommandInteraction): Stake {
  return {
    troops: interaction.options.getInteger('troops', true),
    gold: interaction.options.getInteger('gold') ?? 0,
    food: interaction.options.getInteger('food') ?? 0,
  };
}

/** Suggests fractions of what the country has left at home. */
async function suggestFromStockpile(
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
    ),

  autocomplete: suggestFromStockpile,

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

    const now = Date.now();
    const proposed = proposeReinforcement(ctx.db, {
      guildId: guild.id,
      code: player.countryCode,
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
          '## You proposed reinforcements',
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
    .setDescription('Give up the war your country is fighting')
    .setContexts(InteractionContextType.Guild),

  async execute(
    interaction: ChatInputCommandInteraction,
    ctx: CommandContext,
  ): Promise<void> {
    const guild = interaction.guild;
    if (!guild) return;

    await interaction.deferReply({flags: MessageFlags.Ephemeral});

    const player = getPlayer(ctx.db, guild.id, interaction.user.id);
    const invasion = player?.countryCode
      ? getPendingInvasionFor(ctx.db, guild.id, player.countryCode)
      : undefined;

    if (!player?.countryCode || !invasion) {
      await interaction.editReply(
        v2EditReply(defendRefusalCard({kind: 'not_under_attack'})),
      );
      return;
    }

    const side =
      invasion.attackerCode === player.countryCode ? 'attacker' : 'defender';

    // Surrender is the answer to being asked to reinforce, not a way out of a
    // war a country is currently winning.
    if (
      invasion.status !== 'reinforcing' ||
      invasion.reinforcingSide !== side
    ) {
      await interaction.editReply(
        v2EditReply(
          container(
            ACCENT.neutral,
            '### There is nothing to surrender yet.',
            'A country gives up only once its forces in the field are spent and it is asked to reinforce.',
          ),
        ),
      );
      return;
    }

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
