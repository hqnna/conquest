/**
 * Merges: the peaceful road to the same place conquest leads.
 *
 * A country can offer itself to another. Both sides vote — the country giving
 * itself up, then the country asked to take it in — and only if both agree is
 * the union made. It has to be both: a one-sided merge would let a large
 * country walk into a small one and take it over from the inside, which is a
 * conquest wearing a friendly face.
 *
 * What the union does is exactly what a conquest does, because it leaves the
 * world in the same shape: the absorbed country becomes a territory of the
 * absorbing one, with its stockpile, its people, and everything it had taken.
 * Sharing that settlement is deliberate — a merged world and a conquered one
 * must count the same when the round is judged.
 */
import {settingsFor} from '../db/guild-settings.js';
import {getCountry, listTerritories} from '../db/countries.js';
import type {CountryState} from '../db/countries.js';
import type {Database} from '../db/index.js';
import {getPendingInvasionFor} from '../db/invasions.js';
import {
  createMerge,
  finishMerge,
  getPendingMergeFor,
  openAcceptVote,
} from '../db/merges.js';
import type {Merge} from '../db/merges.js';
import {transferPlayers} from '../db/players.js';
import {lootStockpile} from '../db/resources.js';
import type {Stockpile} from '../db/resources.js';

/** Why Conquest turned a merge offer down. */
export type MergeRefusal =
  | {kind: 'not_configured'}
  | {kind: 'not_in_country'}
  | {kind: 'unknown_country'}
  | {kind: 'self'}
  | {kind: 'target_inactive'}
  | {kind: 'target_defeated'; ownerCode: string | null}
  | {kind: 'at_war'}
  | {kind: 'target_at_war'}
  | {kind: 'merge_pending'; mergeId: number}
  | {kind: 'target_merge_pending'; mergeId: number};

/** Whether an offer may be put to the two countries. */
export type MergeDecision = {ok: true} | {ok: false; refusal: MergeRefusal};

/**
 * Decides whether a merge may be offered.
 *
 * Autocomplete offers only countries that could take the offer, but a player
 * can always type something else, so every rule is checked again here.
 *
 * A war outranks an offer: a country in one cannot give itself away mid-fight,
 * and neither can the country it is fighting. Protections and cooldowns do not
 * come into it — nothing here is an attack.
 */
export function decideMerge(input: {
  configured: boolean;
  from: CountryState | undefined;
  into: CountryState | undefined;
  intoKnown: boolean;
  fromPendingInvasion: boolean;
  intoPendingInvasion: boolean;
  fromPendingMerge: Merge | undefined;
  intoPendingMerge: Merge | undefined;
}): MergeDecision {
  const {from, into} = input;
  if (!input.configured) return {ok: false, refusal: {kind: 'not_configured'}};
  if (!from || from.status !== 'active') {
    return {ok: false, refusal: {kind: 'not_in_country'}};
  }
  if (!input.intoKnown) return {ok: false, refusal: {kind: 'unknown_country'}};
  if (into && into.code === from.code) {
    return {ok: false, refusal: {kind: 'self'}};
  }
  if (into?.status === 'defeated') {
    return {
      ok: false,
      refusal: {kind: 'target_defeated', ownerCode: into.ownerCode},
    };
  }
  if (!into || into.status !== 'active') {
    return {ok: false, refusal: {kind: 'target_inactive'}};
  }
  if (input.fromPendingInvasion) return {ok: false, refusal: {kind: 'at_war'}};
  if (input.intoPendingInvasion) {
    return {ok: false, refusal: {kind: 'target_at_war'}};
  }
  if (input.fromPendingMerge) {
    return {
      ok: false,
      refusal: {kind: 'merge_pending', mergeId: input.fromPendingMerge.id},
    };
  }
  if (input.intoPendingMerge) {
    return {
      ok: false,
      refusal: {
        kind: 'target_merge_pending',
        mergeId: input.intoPendingMerge.id,
      },
    };
  }
  return {ok: true};
}

/**
 * Puts a merge offer to the country making it.
 *
 * Nothing moves yet: the offer is only carried to the other country if this
 * one votes to make it. The rules are re-checked inside the transaction, so
 * two players offering at the same moment cannot both open a vote.
 */
export function proposeMerge(
  db: Database,
  input: {
    guildId: string;
    fromCode: string;
    intoCode: string;
    proposerId: string;
    now: number;
  },
): {ok: true; merge: Merge} | {ok: false; refusal: MergeRefusal} {
  return db.transaction(() => {
    const decision = decideMerge({
      configured: true,
      from: getCountry(db, input.guildId, input.fromCode),
      into: getCountry(db, input.guildId, input.intoCode),
      intoKnown: true,
      fromPendingInvasion: Boolean(
        getPendingInvasionFor(db, input.guildId, input.fromCode),
      ),
      intoPendingInvasion: Boolean(
        getPendingInvasionFor(db, input.guildId, input.intoCode),
      ),
      fromPendingMerge: getPendingMergeFor(db, input.guildId, input.fromCode),
      intoPendingMerge: getPendingMergeFor(db, input.guildId, input.intoCode),
    });
    if (!decision.ok) return {ok: false as const, refusal: decision.refusal};

    const merge = createMerge(db, {
      guildId: input.guildId,
      fromCode: input.fromCode,
      intoCode: input.intoCode,
      proposerId: input.proposerId,
      offerDeadline:
        input.now + settingsFor(db, input.guildId).merges.voteWindow,
      now: input.now,
    });
    return {ok: true as const, merge};
  })();
}

/**
 * Carries an approved offer to the country asked to absorb it.
 *
 * @returns the deadline that country now has to answer by.
 */
export function beginAcceptVote(
  db: Database,
  merge: Merge,
  now: number,
): number {
  const deadline = now + settingsFor(db, merge.guildId).merges.voteWindow;
  openAcceptVote(db, merge.id, deadline);
  return deadline;
}

/** Everything a completed merge moved. */
export interface MergeReport {
  merge: Merge;
  /** What the absorbed country's stockpile added to the absorbing one. */
  stockpile: Stockpile;
  /** Players moved into the absorbing country. */
  transferredPlayers: string[];
  /** Countries that changed hands, the absorbed country included. */
  capturedTerritories: CountryState[];
  /** The absorbed country's role, which must now be deleted. */
  absorbedRoleId: string | null;
  /** The absorbed country's channel, which becomes a read-only archive. */
  absorbedChannelId: string | null;
  /** The absorbing country's role, which takes over the archives. */
  absorberRoleId: string | null;
}

/** Why a merge both sides approved could not be made after all. */
export type MergeFailure =
  {kind: 'gone'; code: string} | {kind: 'at_war'; code: string};

/**
 * Makes the union, and applies everything that follows from it.
 *
 * The world may have moved between the vote passing and this running — a
 * country can be invaded while it is deciding — so both sides are checked
 * again here. War outranks paperwork: if either country is fighting, the
 * merge is called off rather than dissolving an army mid-battle.
 *
 * The whole settlement is one transaction. A half-applied merge would be as
 * corrupt a game as a half-applied conquest.
 */
export function completeMerge(
  db: Database,
  merge: Merge,
  now: number,
): {ok: true; report: MergeReport} | {ok: false; failure: MergeFailure} {
  return db.transaction(() => {
    const {guildId, fromCode, intoCode} = merge;
    const absorbed = getCountry(db, guildId, fromCode);
    const absorber = getCountry(db, guildId, intoCode);

    for (const [country, code] of [
      [absorbed, fromCode],
      [absorber, intoCode],
    ] as const) {
      if (!country || country.status !== 'active') {
        finishMerge(db, merge.id, 'cancelled', now);
        return {ok: false as const, failure: {kind: 'gone' as const, code}};
      }
      if (getPendingInvasionFor(db, guildId, code)) {
        finishMerge(db, merge.id, 'cancelled', now);
        return {ok: false as const, failure: {kind: 'at_war' as const, code}};
      }
    }

    const stockpile = lootStockpile(db, guildId, fromCode, intoCode);
    const transferredPlayers = transferPlayers(db, {
      guildId,
      fromCode,
      toCode: intoCode,
      now,
    });

    // Everything the absorbed country had taken comes with it.
    const inherited = listTerritories(db, guildId, fromCode);
    db.prepare(
      'UPDATE countries SET owner_code = ? WHERE guild_id = ? AND owner_code = ?',
    ).run(intoCode, guildId, fromCode);
    db.prepare(
      `UPDATE countries
          SET status = 'defeated', owner_code = ?, role_id = NULL,
              food = 0, gold = 0, troops = 0,
              protected_until = NULL, invade_cooldown_until = NULL,
              defense_immunity_until = NULL
        WHERE guild_id = ? AND code = ?`,
    ).run(intoCode, guildId, fromCode);

    // Taking a country in voids new-country protection just as marching on one
    // does: a country cannot shelter behind its youth and grow at the same
    // time.
    db.prepare(
      'UPDATE countries SET protected_until = NULL WHERE guild_id = ? AND code = ?',
    ).run(guildId, intoCode);

    finishMerge(db, merge.id, 'completed', now);

    return {
      ok: true as const,
      report: {
        merge,
        stockpile,
        transferredPlayers,
        capturedTerritories: [getCountry(db, guildId, fromCode)!, ...inherited],
        absorbedRoleId: absorbed!.roleId,
        absorbedChannelId: absorbed!.channelId,
        absorberRoleId: absorber!.roleId,
      },
    };
  })();
}
