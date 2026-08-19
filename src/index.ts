import {Events} from 'discord.js';
import {DEV_MODE} from './config/constants.js';
import {openDatabase} from './db/index.js';
import {
  createClient,
  registerInteractionHandler,
  registerMemberHandler,
} from './discord/client.js';
import {loadEnv} from './env.js';
import {startSweeper} from './game/sweeper.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const db = openDatabase(env.databasePath);
  const client = createClient();

  registerInteractionHandler(client, {db});
  registerMemberHandler(client, {db});

  let stopSweeper: (() => void) | undefined;
  client.once(Events.ClientReady, ready => {
    console.log(
      `Conquest is online as ${ready.user.tag}` +
        (DEV_MODE ? ' (dev mode: timers are drastically shortened)' : ''),
    );
    // Deadlines live in the database, so the sweeper picks up anything that
    // expired while Conquest was down.
    stopSweeper = startSweeper(db, client);
  });

  const shutdown = (signal: string) => {
    console.log(`Received ${signal}; shutting Conquest down.`);
    stopSweeper?.();
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
