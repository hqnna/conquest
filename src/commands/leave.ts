import {
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import type {ChatInputCommandInteraction, Guild} from 'discord.js';
import {COOLDOWNS, formatDuration} from '../config/constants.js';
import {countryLabel, findCountry} from '../data/countries.js';
import {getCountry} from '../db/countries.js';
import type {Database} from '../db/index.js';
import {countCountryMembers, getPlayer, leaveCountry} from '../db/players.js';
import {announce} from '../discord/log.js';
import {ACCENT, container, relativeTime, v2EditReply} from '../discord/ui.js';
import {disbandCountry, revokeCountryRole} from '../game/country-lifecycle.js';
import {decideLeave} from '../game/policy.js';
import type {Command, CommandContext} from './types.js';

/**
 * Removes a player from their country, disbanding it if they were the last
 * one, and announcing the fall if so.
 *
 * Shared by `/leave` and by a member leaving the server, which is the same
 * thing minus the cooldown — there is no one left to hold to it.
 *
 * @returns the country they left, or undefined if they were in none.
 */
export async function removePlayerFromCountry(
  db: Database,
  guild: Guild,
  userId: string,
  options: {withCooldown: boolean; now: number},
): Promise<{code: string; disbanded: boolean} | undefined> {
  const player = getPlayer(db, guild.id, userId);
  const decision = decideLeave({
    player,
    memberCount: player?.countryCode
      ? countCountryMembers(db, guild.id, player.countryCode)
      : 0,
  });
  if (!decision.ok) return undefined;

  const state = getCountry(db, guild.id, decision.code);
  leaveCountry(db, {
    guildId: guild.id,
    userId,
    now: options.now,
    withCooldown: options.withCooldown,
  });

  if (state?.roleId) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member) {
      await revokeCountryRole(
        member,
        state.roleId,
        `Conquest: left ${state.name}`,
      ).catch(() => undefined);
    }
  }

  if (decision.deactivates && state) {
    await disbandCountry(db, guild, state);
    const country = findCountry(decision.code);
    await announce(
      db,
      guild,
      container(
        ACCENT.warning,
        `## ${country ? countryLabel(country) : decision.code} is no more`,
        'Its last player left. The country is unclaimed again, its stockpile is gone, and any territory it held has been released.',
      ),
    );
  }

  return {code: decision.code, disbanded: decision.deactivates};
}

export const leaveCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Leave your country')
    .setContexts(InteractionContextType.Guild),

  async execute(
    interaction: ChatInputCommandInteraction,
    ctx: CommandContext,
  ): Promise<void> {
    const guild = interaction.guild;
    if (!guild) return;

    await interaction.deferReply({flags: MessageFlags.Ephemeral});

    const now = Date.now();
    const result = await removePlayerFromCountry(
      ctx.db,
      guild,
      interaction.user.id,
      {withCooldown: true, now},
    );

    if (!result) {
      await interaction.editReply(
        v2EditReply(
          container(
            ACCENT.danger,
            '### You are not in a country.',
            'Run `/join country:<name>` to pick one.',
          ),
        ),
      );
      return;
    }

    const country = findCountry(result.code);
    await interaction.editReply(
      v2EditReply(
        container(
          ACCENT.warning,
          `## You left ${country ? countryLabel(country) : result.code}`,
          result.disbanded
            ? 'You were its last player, so the country has been disbanded — its channel and role are gone, and its stockpile with them.'
            : 'Your countrymen carry on without you.',
          `You can join a country again ${relativeTime(now + COOLDOWNS.rejoin)} (${formatDuration(COOLDOWNS.rejoin)}).`,
        ),
      ),
    );
  },
};
