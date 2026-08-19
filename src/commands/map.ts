import {
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import type {ChatInputCommandInteraction, ContainerBuilder} from 'discord.js';
import {GAME} from '../config/constants.js';
import {countryLabel, findCountry} from '../data/countries.js';
import {listCountriesByStatus, territoryCounts} from '../db/countries.js';
import {getGuildConfig} from '../db/guild-config.js';
import {memberCounts} from '../db/players.js';
import {ACCENT, container, v2EditReply} from '../discord/ui.js';
import type {Command, CommandContext} from './types.js';

/** One country's standing in the world. */
export interface StandingsEntry {
  code: string;
  players: number;
  territories: number;
}

/**
 * Ranks the world by territory, then players, then code.
 *
 * The final tiebreak is the country code so the order is total and stable —
 * the standings must not shuffle between two renders of the same state.
 */
export function standings(
  activeCodes: readonly string[],
  players: ReadonlyMap<string, number>,
  territories: ReadonlyMap<string, number>,
): StandingsEntry[] {
  return activeCodes
    .map(code => ({
      code,
      players: players.get(code) ?? 0,
      territories: territories.get(code) ?? 0,
    }))
    .sort(
      (a, b) =>
        b.territories - a.territories ||
        b.players - a.players ||
        a.code.localeCompare(b.code),
    );
}

/**
 * Renders the world as text.
 *
 * A rendered image replaces this in a later phase; the standings it shows are
 * the legend that will sit beneath that image.
 */
export function worldCard(
  entries: readonly StandingsEntry[],
  threshold: number,
): ContainerBuilder {
  if (entries.length === 0) {
    return container(
      ACCENT.neutral,
      '## The world is empty',
      'No country has been founded yet. Run `/join country:<name>` to be the first.',
    );
  }

  const rows = entries.map((entry, index) => {
    const country = findCountry(entry.code);
    const name = country ? countryLabel(country) : entry.code;
    const territory = `${entry.territories} territor${entry.territories === 1 ? 'y' : 'ies'}`;
    const people = `${entry.players} player${entry.players === 1 ? '' : 's'}`;
    return `**${index + 1}.** ${name} — ${territory}, ${people}`;
  });

  const leader = entries[0];
  const progress = `**${findCountry(leader.code)?.name ?? leader.code}** leads with ${leader.territories} of the ${threshold} territories needed to win.`;

  return container(
    ACCENT.neutral,
    '## The world',
    rows.join('\n'),
    progress,
    '*Conquest renders this as a map once map rendering lands.*',
  );
}

export const mapCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('map')
    .setDescription('See who holds what')
    .setContexts(InteractionContextType.Guild),

  async execute(
    interaction: ChatInputCommandInteraction,
    ctx: CommandContext,
  ): Promise<void> {
    const guildId = interaction.guildId;
    if (!guildId) return;

    await interaction.deferReply({flags: MessageFlags.Ephemeral});

    const config = getGuildConfig(ctx.db, guildId);
    const entries = standings(
      listCountriesByStatus(ctx.db, guildId, 'active').map(state => state.code),
      memberCounts(ctx.db, guildId),
      territoryCounts(ctx.db, guildId),
    );

    await interaction.editReply(
      v2EditReply(
        worldCard(
          entries,
          config?.dominationThreshold ?? GAME.defaultDominationThreshold,
        ),
      ),
    );
  },
};
