import {ChannelType} from 'discord.js';
import type {ContainerBuilder, Guild, TextChannel} from 'discord.js';
import {getGuildConfig} from '../db/guild-config.js';
import type {Database} from '../db/index.js';
import {v2Message} from './ui.js';

/** Resolves the guild's game log channel, if it is still there. */
export async function getGameLog(
  db: Database,
  guild: Guild,
): Promise<TextChannel | undefined> {
  const config = getGuildConfig(db, guild.id);
  if (!config) return undefined;
  const channel = await guild.channels
    .fetch(config.logChannelId)
    .catch(() => null);
  return channel?.type === ChannelType.GuildText ? channel : undefined;
}

/**
 * Announces a global event in the game log.
 *
 * Announcements are never the point of the command that triggers them, so a
 * missing or unwritable log channel is logged and shrugged off rather than
 * failing the player's action.
 */
export async function announce(
  db: Database,
  guild: Guild,
  ...containers: ContainerBuilder[]
): Promise<void> {
  const log = await getGameLog(db, guild);
  if (!log) return;
  await log.send(v2Message(...containers)).catch((error: unknown) => {
    console.error(`Could not post to the game log in ${guild.id}:`, error);
  });
}
