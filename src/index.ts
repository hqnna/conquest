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
import {createMapRenderer} from './map/index.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const db = openDatabase(env.databasePath);
  const client = createClient();

  const map = await createMapRenderer();
  console.log(
    map
      ? `Map rendering enabled via ${map.backend}.`
      : 'No SVG rasterizer available; /map will show text standings only.',
  );

  registerInteractionHandler(client, {db, map});
  registerMemberHandler(client, {db, map});

  let stopSweeper: (() => void) | undefined;
  client.once(Events.ClientReady, ready => {
    console.log(
      `Conquest is online as ${ready.user.tag}` +
        (DEV_MODE ? ' (dev mode: timers are drastically shortened)' : ''),
    );
    // Deadlines live in the database, so the sweeper picks up anything that
    // expired while Conquest was down.
    stopSweeper = startSweeper(db, client, map);
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
