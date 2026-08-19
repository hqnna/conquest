/**
 * Registers Conquest's slash commands with Discord.
 *
 * Run `pnpm deploy-commands` to publish globally, or set `DISCORD_GUILD_ID` to
 * publish to one guild, which updates instantly and is what you want while
 * developing.
 */
import {REST, Routes} from 'discord.js';
import {COMMANDS} from '../commands/index.js';
import {loadEnv} from '../env.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const guildId = process.env.DISCORD_GUILD_ID;
  const body = COMMANDS.map(command => command.data.toJSON());
  const rest = new REST().setToken(env.token);

  const route = guildId
    ? Routes.applicationGuildCommands(env.clientId, guildId)
    : Routes.applicationCommands(env.clientId);

  await rest.put(route, {body});
  console.log(
    `Registered ${body.length} command${body.length === 1 ? '' : 's'} ` +
      (guildId ? `to guild ${guildId}.` : 'globally (may take up to an hour).'),
  );
}

main().catch((error: unknown) => {
  console.error('Failed to register commands:', error);
  process.exit(1);
});
