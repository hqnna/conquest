/** Environment configuration, read once at startup. */

export interface Env {
  /** Bot token used to log in and to register slash commands. */
  token: string;
  /** Application (client) ID used when registering slash commands. */
  clientId: string;
  /** Path to the SQLite file holding all game state. */
  databasePath: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        'Set it in your shell or in a .env file before starting Conquest.',
    );
  }
  return value;
}

/** Reads Conquest's configuration from the environment. */
export function loadEnv(): Env {
  return {
    token: required('DISCORD_TOKEN'),
    clientId: required('DISCORD_CLIENT_ID'),
    databasePath: process.env.CONQUEST_DB_PATH ?? 'conquest.db',
  };
}
