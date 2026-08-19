import {Events} from 'discord.js';
import {DEV_MODE} from './config/constants.js';
import {openDatabase} from './db/index.js';
import {createClient, registerInteractionHandler} from './discord/client.js';
import {loadEnv} from './env.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const db = openDatabase(env.databasePath);
  const client = createClient();

  registerInteractionHandler(client, {db});

  client.once(Events.ClientReady, ready => {
    console.log(
      `Conquest is online as ${ready.user.tag}` +
        (DEV_MODE ? ' (dev mode: timers are drastically shortened)' : ''),
    );
  });

  const shutdown = (signal: string) => {
    console.log(`Received ${signal}; shutting Conquest down.`);
    void client.destroy().finally(() => {
      db.close();
      process.exit(0);
    });
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  await client.login(env.token);
}

main().catch((error: unknown) => {
  console.error('Conquest failed to start:', error);
  process.exit(1);
});
