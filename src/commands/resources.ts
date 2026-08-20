import {
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import type {ChatInputCommandInteraction, ContainerBuilder} from 'discord.js';
import {formatDuration} from '../config/constants.js';
import type {Settings} from '../config/settings.js';
import {settingsFor} from '../db/guild-settings.js';
import {countryLabel, findCountry} from '../data/countries.js';
import {GATHER_COMMANDS, listCooldowns} from '../db/cooldowns.js';
import type {GatherCommand} from '../db/cooldowns.js';
import {getPlayer} from '../db/players.js';
import {getStockpile} from '../db/resources.js';
import type {Stockpile} from '../db/resources.js';
import {ACCENT, container, relativeTime, v2EditReply} from '../discord/ui.js';
import {gatherRules} from '../game/gathering.js';
import {stockpileLine} from './gather.js';
import type {Command, CommandContext} from './types.js';

/**
 * One line per gather command: ready, or counting down to when it will be.
 *
 * Deadlines are Discord timestamps, so they localise themselves and keep
 * counting without Conquest editing anything.
 */
export function cooldownLines(
  cooldowns: ReadonlyMap<GatherCommand, number>,
  now: number,
): string[] {
  return GATHER_COMMANDS.map(command => {
    const until = cooldowns.get(command);
    return until && until > now
      ? `\`/${command}\` — ready ${relativeTime(until)}`
      : `\`/${command}\` — ✅ ready now`;
  });
}

/** The `/resources` card: what the country holds and what you may do next. */
export function resourcesCard(input: {
  code: string;
  stockpile: Stockpile;
  cooldowns: ReadonlyMap<GatherCommand, number>;
  settings: Settings;
  now: number;
}): ContainerBuilder {
  const country = findCountry(input.code);
  const {recruitCost, recruitYield} = input.settings.resources;
  return container(
    ACCENT.neutral,
    `## ${country ? countryLabel(country) : input.code}`,
    `**Stockpile** — ${stockpileLine(input.stockpile)}\nResources are pooled: everything your countrymen gather lands here.`,
    [
      '**Your gather cooldowns**',
      ...cooldownLines(input.cooldowns, input.now),
    ].join('\n'),
    `\`/recruit\` turns ${recruitCost.gold} 🪙 gold and ${recruitCost.food} 🌾 food into ` +
      `${recruitYield.min}–${recruitYield.max} ⚔️ troops, every ${formatDuration(
        gatherRules(input.settings).recruit.cooldown,
      )}.`,
  );
}

export const resourcesCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('resources')
    .setDescription('Your country stockpile and your own gather cooldowns')
    .setContexts(InteractionContextType.Guild),

  async execute(
    interaction: ChatInputCommandInteraction,
    ctx: CommandContext,
  ): Promise<void> {
    const guildId = interaction.guildId;
    if (!guildId) return;

    await interaction.deferReply({flags: MessageFlags.Ephemeral});

    const player = getPlayer(ctx.db, guildId, interaction.user.id);
    const stockpile = player?.countryCode
      ? getStockpile(ctx.db, guildId, player.countryCode)
      : undefined;

    if (!player?.countryCode || !stockpile) {
      await interaction.editReply(
        v2EditReply(
          container(
            ACCENT.danger,
            '### You are not in a country.',
            'Run `/join country:<name>` to claim one — resources are pooled per country.',
          ),
        ),
      );
      return;
    }

    await interaction.editReply(
      v2EditReply(
        resourcesCard({
          code: player.countryCode,
          stockpile,
          cooldowns: listCooldowns(ctx.db, guildId, interaction.user.id),
          settings: settingsFor(ctx.db, guildId),
          now: Date.now(),
        }),
      ),
    );
  },
};
