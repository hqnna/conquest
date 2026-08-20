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
import {getCountry, listCountriesByStatus} from '../db/countries.js';
import {getGuildConfig} from '../db/guild-config.js';
import {listPendingInvasionsFor} from '../db/invasions.js';
import type {Stake} from '../db/invasions.js';
import {getPlayer} from '../db/players.js';
import type {Stockpile} from '../db/resources.js';
import {castVote} from '../db/votes.js';
import {ACCENT, container, relativeTime, v2EditReply} from '../discord/ui.js';
import {openAttackVote} from '../game/invasion-flow.js';
import {declareInvasion} from '../game/invasions.js';
import type {InvadeRefusal} from '../game/invasions.js';
import {stakeLine} from '../discord/invasion-ui.js';
import type {Command, CommandContext} from './types.js';

/**
 * Suggests fractions of what the country actually holds.
 *
 * Amounts are suggestions only — Discord lets a player type any number, and
 * the command validates whatever arrives.
 */
export function stakeSuggestions(
  available: number,
): Array<{name: string; value: number}> {
  if (available <= 0) {
    return [{name: 'Your country has none of this to commit', value: 0}];
  }
  const fractions: Array<[string, number]> = [
    ['25%', 0.25],
    ['50%', 0.5],
    ['75%', 0.75],
    ['everything', 1],
  ];
  const seen = new Set<number>();
  const suggestions: Array<{name: string; value: number}> = [];
  for (const [label, fraction] of fractions) {
    const amount = Math.max(1, Math.floor(available * fraction));
    if (amount > available || seen.has(amount)) continue;
    seen.add(amount);
    suggestions.push({name: `${amount} (${label})`, value: amount});
  }
  return suggestions;
}

/**
 * Countries this country could legally march on right now.
 *
 * A country already at war is a legal target — coming to somebody's aid by
 * striking their invader is the whole point of allowing it. What is excluded
 * is a country this one is already invading, since that war is running.
 */
export function legalTargets(input: {
  attackerCode: string;
  active: ReadonlyArray<{
    code: string;
    protectedUntil: number | null;
    defenseImmunityUntil: number | null;
  }>;
  /** Countries this attacker already has a war against. */
  engagedCodes: ReadonlySet<string>;
  now: number;
}): string[] {
  return input.active
    .filter(country => country.code !== input.attackerCode)
    .filter(country => !input.engagedCodes.has(country.code))
    .filter(
      country =>
        !(country.protectedUntil && country.protectedUntil > input.now),
    )
    .filter(
      country =>
        !(
          country.defenseImmunityUntil &&
          country.defenseImmunityUntil > input.now
        ),
    )
    .map(country => country.code);
}

/** Reads the three stake options off the interaction. */
function readStake(interaction: ChatInputCommandInteraction): Stake {
  return {
    troops: interaction.options.getInteger('troops', true),
    gold: interaction.options.getInteger('gold') ?? 0,
    food: interaction.options.getInteger('food') ?? 0,
  };
}

/** Turns a refusal into a card that says what to do next. */
export function invadeRefusalCard(
  refusal: InvadeRefusal,
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
        'Run `/join country:<name>` — you can only march with a country behind you.',
      );
    case 'unknown_country':
      return container(
        ACCENT.danger,
        `### There is no country called “${requested}”.`,
        'Pick one from the autocomplete list; it offers only targets you can legally attack.',
      );
    case 'self':
      return container(
        ACCENT.danger,
        '### You cannot invade yourself.',
        'Pick another country.',
      );
    case 'target_inactive':
      return container(
        ACCENT.danger,
        '### Nobody holds that country.',
        'There is nothing there to conquer. Attack a country somebody has joined, or take it yourself with `/join`.',
      );
    case 'target_defeated':
      return container(
        ACCENT.danger,
        '### That country has already fallen.',
        refusal.ownerCode
          ? `It is territory of ${countryLabel(findCountry(refusal.ownerCode)!)}. Invade the empire that holds it instead.`
          : 'Invade a country that still stands.',
      );
    case 'no_troops':
      return container(
        ACCENT.danger,
        '### An invasion needs troops.',
        'Commit at least one. Supplies alone do not fight — they only make troops fight harder.',
      );
    case 'cannot_afford':
      return container(
        ACCENT.danger,
        '### Your country cannot cover that stake.',
        `It holds ⚔️ ${refusal.stockpile.troops} troops · 🪙 ${refusal.stockpile.gold} gold · 🌾 ${refusal.stockpile.food} food.`,
        'Commit less, or gather more first.',
      );
    case 'on_cooldown':
      return container(
        ACCENT.warning,
        '### Your country is still recovering from its last war.',
        `You can declare again ${relativeTime(refusal.until)} (${formatDuration(INVASIONS.attackVoteWindow)} of voting follows that).`,
      );
    case 'target_protected':
      return container(
        ACCENT.warning,
        '### That country is under new-country protection.',
        `It can be invaded ${relativeTime(refusal.until)}. Freshly founded countries get ${formatDuration(INVASIONS.newCountryProtection)} to find their feet — though marching on anyone voids their own protection.`,
      );
    case 'target_immune':
      return container(
        ACCENT.warning,
        '### That country just fought off an invasion.',
        `It is immune until ${relativeTime(refusal.until)}. Let someone else soften it up.`,
      );
    case 'already_invading':
      return container(
        ACCENT.warning,
        '### You are already marching on them.',
        'One war per enemy: see that one through, or reinforce it, before declaring another. ' +
          'You may still declare on somebody else.',
      );
  }
}

export const invadeCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('invade')
    .setDescription('Propose an invasion to your country')
    .setContexts(InteractionContextType.Guild)
    .addStringOption(option =>
      option
        .setName('country')
        .setDescription('The country to invade')
        .setAutocomplete(true)
        .setRequired(true),
    )
    .addIntegerOption(option =>
      option
        .setName('troops')
        .setDescription('Troops to commit (they fight, and they can be lost)')
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

  /**
   * Offers legal targets for the country option and live stockpile fractions
   * for the amounts, all from the database — an empty target list is itself
   * the answer that there is nobody to attack.
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

    const player = getPlayer(ctx.db, guildId, interaction.user.id);
    const code = player?.countryCode;
    const focused = interaction.options.getFocused(true);

    if (focused.name !== 'country') {
      const stockpile = code ? getCountry(ctx.db, guildId, code) : undefined;
      const available = stockpile
        ? (
            {
              troops: stockpile.troops,
              gold: stockpile.gold,
              food: stockpile.food,
            } as Stockpile
          )[focused.name as keyof Stockpile]
        : 0;
      await interaction.respond(stakeSuggestions(available ?? 0));
      return;
    }

    if (!code) {
      await interaction.respond([]);
      return;
    }

    const now = Date.now();
    const active = listCountriesByStatus(ctx.db, guildId, 'active');
    const engaged = new Set(
      listPendingInvasionsFor(ctx.db, guildId, code)
        .filter(invasion => invasion.attackerCode === code)
        .map(invasion => invasion.defenderCode),
    );

    const targets = new Set(
      legalTargets({attackerCode: code, active, engagedCodes: engaged, now}),
    );
    const matches = searchCountries(
      COUNTRIES.filter(country => targets.has(country.code)),
      focused.value,
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
    const stake = readStake(interaction);
    const now = Date.now();

    if (!getGuildConfig(ctx.db, guild.id)) {
      await interaction.editReply(
        v2EditReply(invadeRefusalCard({kind: 'not_configured'}, requested)),
      );
      return;
    }
    if (!player?.countryCode) {
      await interaction.editReply(
        v2EditReply(invadeRefusalCard({kind: 'not_in_country'}, requested)),
      );
      return;
    }
    if (!target) {
      await interaction.editReply(
        v2EditReply(invadeRefusalCard({kind: 'unknown_country'}, requested)),
      );
      return;
    }

    const declared = declareInvasion(ctx.db, {
      guildId: guild.id,
      attackerCode: player.countryCode,
      defenderCode: target.code,
      stake,
      now,
    });

    if (!declared.ok) {
      await interaction.editReply(
        v2EditReply(invadeRefusalCard(declared.refusal, requested)),
      );
      return;
    }

    // Declaring is approving: the initiator's own vote is already cast.
    castVote(ctx.db, {
      invasionId: declared.invasion.id,
      kind: 'attack',
      userId: interaction.user.id,
      choice: 'approve',
      now,
    });

    await openAttackVote(
      ctx.db,
      guild,
      declared.invasion,
      interaction.user.id,
      now,
    );

    await interaction.editReply(
      v2EditReply(
        container(
          ACCENT.attacker,
          `## You proposed invading ${countryLabel(target)}`,
          `**Stake:** ${stakeLine(stake)}\nYour countrymen are voting in your country channel; your own approval is already counted.`,
          `If it passes, the stake is committed at once and the battle is fought ${formatDuration(INVASIONS.defenseWindow)} later.`,
        ),
      ),
    );
  },
};
