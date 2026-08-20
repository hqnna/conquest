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
import type {GatherCommand} from '../db/cooldowns.js';
import {getCooldown} from '../db/cooldowns.js';
import {getGuildConfig} from '../db/guild-config.js';
import {getPlayer} from '../db/players.js';
import {getStockpile} from '../db/resources.js';
import type {ResourceDelta, Stockpile} from '../db/resources.js';
import {ACCENT, container, relativeTime, v2EditReply} from '../discord/ui.js';
import {decideGather, gather, gatherRules} from '../game/gathering.js';
import type {GatherRefusal} from '../game/gathering.js';
import type {Command, CommandContext} from './types.js';

/** How each resource reads in copy. */
export const RESOURCE_LABEL: Readonly<Record<keyof Stockpile, string>> = {
  food: '🌾 food',
  gold: '🪙 gold',
  troops: '⚔️ troops',
};

/** What each gather command is called and what it says it does. */
const GATHER_COPY: Readonly<
  Record<
    GatherCommand,
    {description: string; flavour: (amount: number) => string}
  >
> = {
  farm: {
    description: 'Work the fields for food',
    flavour: amount =>
      `Your fields brought in **${amount} ${RESOURCE_LABEL.food}**.`,
  },
  mine: {
    description: 'Work the mines for gold',
    flavour: amount =>
      `Your mines yielded **${amount} ${RESOURCE_LABEL.gold}**.`,
  },
  recruit: {
    description: 'Turn gold and food into troops',
    flavour: amount =>
      `**${amount} ${RESOURCE_LABEL.troops}** answered the call.`,
  },
};

/** Renders a stockpile as one line. */
export function stockpileLine(stockpile: Stockpile): string {
  return (
    `🌾 **${stockpile.food}** food · ` +
    `🪙 **${stockpile.gold}** gold · ` +
    `⚔️ **${stockpile.troops}** troops`
  );
}

/** Renders a cost or a shortfall, e.g. `10 🪙 gold and 4 🌾 food`. */
export function deltaLine(delta: ResourceDelta): string {
  const parts = (['food', 'gold', 'troops'] as const)
    .filter(resource => (delta[resource] ?? 0) > 0)
    .map(resource => `${delta[resource]} ${RESOURCE_LABEL[resource]}`);
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** Turns a refusal into a card that says what to do next. */
export function gatherRefusalCard(
  refusal: GatherRefusal,
  command: GatherCommand,
  settings: Settings,
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
        'Run `/join country:<name>` first — resources are pooled by country, so you need one to gather for.',
      );
    case 'cooldown':
      return container(
        ACCENT.warning,
        `### You have already run \`/${command}\` recently.`,
        `You can go again ${relativeTime(refusal.until)}. ` +
          'Meanwhile the other gather commands run on their own cooldowns.',
      );
    case 'insufficient':
      return container(
        ACCENT.danger,
        '### Your country cannot afford that.',
        `\`/recruit\` costs ${deltaLine(gatherRules(settings).recruit.cost)}, and you are short ${deltaLine(refusal.short)}.`,
        'Run `/farm` and `/mine` first, or wait for your countrymen to.',
      );
  }
}

/** Builds one of the three gather commands; they differ only in their copy. */
function makeGatherCommand(command: GatherCommand): Command {
  const copy = GATHER_COPY[command];

  return {
    data: new SlashCommandBuilder()
      .setName(command)
      .setDescription(copy.description)
      .setContexts(InteractionContextType.Guild),

    async execute(
      interaction: ChatInputCommandInteraction,
      ctx: CommandContext,
    ): Promise<void> {
      const guildId = interaction.guildId;
      if (!guildId) return;

      await interaction.deferReply({flags: MessageFlags.Ephemeral});

      const now = Date.now();
      const settings = settingsFor(ctx.db, guildId);
      const rules = gatherRules(settings)[command];
      const player = getPlayer(ctx.db, guildId, interaction.user.id);
      const code = player?.countryCode ?? null;
      const decision = decideGather({
        configured: Boolean(getGuildConfig(ctx.db, guildId)),
        countryCode: code,
        stockpile: code ? getStockpile(ctx.db, guildId, code) : undefined,
        command,
        cooldownUntil: getCooldown(
          ctx.db,
          guildId,
          interaction.user.id,
          command,
        ),
        settings,
        now,
      });

      if (!decision.ok) {
        await interaction.editReply(
          v2EditReply(gatherRefusalCard(decision.refusal, command, settings)),
        );
        return;
      }

      const outcome = gather(ctx.db, {
        guildId,
        userId: interaction.user.id,
        code: code!,
        command,
        now,
      });

      if (!outcome.ok) {
        await interaction.editReply(
          v2EditReply(gatherRefusalCard(outcome.refusal, command, settings)),
        );
        return;
      }

      const country = findCountry(code!);
      const spent = deltaLine(outcome.result.cost);
      await interaction.editReply(
        v2EditReply(
          container(
            ACCENT.success,
            `### ${copy.flavour(outcome.result.amount)}`,
            [
              spent ? `Spent ${spent}.` : '',
              `**${country ? countryLabel(country) : code}** now holds ${stockpileLine(outcome.result.stockpile)}.`,
            ]
              .filter(Boolean)
              .join('\n'),
            `You can run \`/${command}\` again ${relativeTime(outcome.result.nextAvailableAt)} (every ${formatDuration(rules.cooldown)}).`,
          ),
        ),
      );
    },
  };
}

export const farmCommand = makeGatherCommand('farm');
export const mineCommand = makeGatherCommand('mine');
export const recruitCommand = makeGatherCommand('recruit');
