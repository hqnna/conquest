/**
 * Picking which war a command is about.
 *
 * A country can be fighting several wars at once, so `/defend`, `/reinforce`,
 * and `/surrender` all have to say which one they mean. They take an `enemy`
 * option for it, and this decides what that option resolves to:
 *
 * - named, and it matches a war the command applies to → that war;
 * - omitted, and only one war applies → that war, so nobody types `enemy` in
 *   a game where a country is only ever in one fight;
 * - omitted with several → refused, listing them, rather than guessing and
 *   committing an army to the wrong front.
 */
import {countryLabel, findCountry} from '../data/countries.js';
import type {Invasion} from '../db/invasions.js';
import {listPendingInvasionsFor} from '../db/invasions.js';
import type {Database} from '../db/index.js';

/** The other country in a war, whichever side the reader is on. */
export function enemyOf(code: string, invasion: Invasion): string {
  return invasion.attackerCode === code
    ? invasion.defenderCode
    : invasion.attackerCode;
}

/** How an enemy country reads, falling back to its code. */
export function enemyLabel(code: string): string {
  const country = findCountry(code);
  return country ? countryLabel(country) : code;
}

/** Why a command could not tell which war it was about. */
export type WarChoiceRefusal =
  | {kind: 'none'}
  | {kind: 'ambiguous'; candidates: Invasion[]}
  | {kind: 'unknown'; requested: string; candidates: Invasion[]};

/** The war a command will act on, or why it cannot say. */
export type WarChoice =
  {ok: true; invasion: Invasion} | {ok: false; refusal: WarChoiceRefusal};

/** Resolves the `enemy` option against the wars a command applies to. */
export function chooseWar(input: {
  code: string;
  candidates: readonly Invasion[];
  requested: string | null;
}): WarChoice {
  const {code, candidates, requested} = input;
  if (candidates.length === 0) return {ok: false, refusal: {kind: 'none'}};

  if (requested) {
    const match = candidates.find(
      invasion => enemyOf(code, invasion) === requested,
    );
    return match
      ? {ok: true, invasion: match}
      : {
          ok: false,
          refusal: {kind: 'unknown', requested, candidates: [...candidates]},
        };
  }

  if (candidates.length === 1) return {ok: true, invasion: candidates[0]};
  return {
    ok: false,
    refusal: {kind: 'ambiguous', candidates: [...candidates]},
  };
}

/**
 * Invasions of this country that a defence could still answer.
 *
 * Wars that are already being fought are offered only when none are waiting
 * for an answer, so that `/defend` with no enemy named picks the invasion that
 * actually needs one — and still explains itself when the only war left is
 * one whose defence is already committed.
 */
export function warsToDefend(
  db: Database,
  guildId: string,
  code: string,
): Invasion[] {
  const defending = listPendingInvasionsFor(db, guildId, code).filter(
    invasion => invasion.defenderCode === code,
  );
  const answerable = defending.filter(
    invasion => invasion.status === 'defense_window',
  );
  return answerable.length > 0 ? answerable : defending;
}

/**
 * Wars where this country is the side being asked to reinforce or give up.
 *
 * Only those: reinforcing is the answer to having been fought to nothing, not
 * a way to pour troops into any war at any moment.
 */
export function warsAwaitingAnswer(
  db: Database,
  guildId: string,
  code: string,
): Invasion[] {
  return listPendingInvasionsFor(db, guildId, code).filter(
    invasion =>
      invasion.status === 'reinforcing' &&
      invasion.reinforcingSide ===
        (invasion.attackerCode === code ? 'attacker' : 'defender'),
  );
}
