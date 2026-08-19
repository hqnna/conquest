/**
 * Pure decisions about country membership.
 *
 * Autocomplete is a suggestion UI, never validation: every decision here is
 * made again server-side from database state, whatever the user submitted.
 */
import type {CountryState} from '../db/countries.js';
import type {PlayerState} from '../db/players.js';

/** Why Conquest turned a `/join` down. */
export type JoinRefusal =
  | {kind: 'not_configured'}
  | {kind: 'unknown_country'}
  | {kind: 'already_joined'; code: string}
  | {kind: 'rejoin_cooldown'; until: number}
  | {kind: 'defeated'; ownerCode: string | null}
  | {kind: 'at_capacity'};

/** Whether a `/join` may proceed, and whether it founds a new country. */
export type JoinDecision =
  {ok: true; activates: boolean} | {ok: false; refusal: JoinRefusal};

/**
 * Decides whether a player may join a country.
 *
 * @param country the country's row, or undefined if it has never been
 *   activated in this guild — which makes it inactive and joinable.
 * @param slotsRemaining free channel slots in the category; only checked when
 *   joining would activate a new country, since joining an existing one
 *   creates nothing.
 */
export function decideJoin(input: {
  configured: boolean;
  known: boolean;
  country: CountryState | undefined;
  player: PlayerState | undefined;
  slotsRemaining: number;
  now: number;
}): JoinDecision {
  if (!input.configured) return {ok: false, refusal: {kind: 'not_configured'}};
  if (!input.known) return {ok: false, refusal: {kind: 'unknown_country'}};

  const {player, country} = input;
  if (player?.countryCode) {
    return {
      ok: false,
      refusal: {kind: 'already_joined', code: player.countryCode},
    };
  }
  if (player?.rejoinCooldownUntil && player.rejoinCooldownUntil > input.now) {
    return {
      ok: false,
      refusal: {kind: 'rejoin_cooldown', until: player.rejoinCooldownUntil},
    };
  }
  if (country?.status === 'defeated') {
    return {
      ok: false,
      refusal: {kind: 'defeated', ownerCode: country.ownerCode},
    };
  }

  const activates = country?.status !== 'active';
  if (activates && input.slotsRemaining <= 0) {
    return {ok: false, refusal: {kind: 'at_capacity'}};
  }
  return {ok: true, activates};
}

/** Why Conquest turned a `/leave` down. */
export type LeaveRefusal = {kind: 'not_in_country'};

/** Whether a `/leave` may proceed, and whether it empties the country. */
export type LeaveDecision =
  | {ok: true; code: string; deactivates: boolean}
  | {ok: false; refusal: LeaveRefusal};

/**
 * Decides whether a player may leave, and whether their country dies with
 * them.
 *
 * @param memberCount players in the country including the one leaving.
 */
export function decideLeave(input: {
  player: PlayerState | undefined;
  memberCount: number;
}): LeaveDecision {
  const code = input.player?.countryCode;
  if (!code) return {ok: false, refusal: {kind: 'not_in_country'}};
  return {ok: true, code, deactivates: input.memberCount <= 1};
}

/** Countries a player may join right now, for `/join` autocomplete. */
export function joinableCodes(
  countries: readonly CountryState[],
  allCodes: readonly string[],
  slotsRemaining: number,
): Set<string> {
  const byCode = new Map(countries.map(country => [country.code, country]));
  const joinable = new Set<string>();
  for (const code of allCodes) {
    const status = byCode.get(code)?.status ?? 'inactive';
    if (status === 'defeated') continue;
    if (status === 'inactive' && slotsRemaining <= 0) continue;
    joinable.add(code);
  }
  return joinable;
}
