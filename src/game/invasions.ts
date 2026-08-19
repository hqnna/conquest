/**
 * The invasion pipeline: declaring, escrowing, defending, and resolving.
 *
 * Every state change here is one database transaction. A partially applied
 * conquest — players moved but territory not, or a stake escrowed twice —
 * would be a corrupt game, so nothing is left half-done between statements.
 *
 * Discord work happens after the transaction commits, driven by what it
 * returns.
 */
import {COOLDOWNS, INVASIONS} from '../config/constants.js';
import {
  getCountry,
  listTerritories,
  setCountryChannel,
} from '../db/countries.js';
import type {CountryState} from '../db/countries.js';
import type {Database} from '../db/index.js';
import {
  createInvasion,
  createProposal,
  finishInvasion,
  finishProposal,
  getPendingInvasionFor,
  getPendingProposal,
  openDefenseWindow,
  setDefenseStake,
} from '../db/invasions.js';
import type {DefenseProposal, Invasion, Stake} from '../db/invasions.js';
import {countCountryMembers, transferPlayers} from '../db/players.js';
import {
  addResources,
  getStockpile,
  lootStockpile,
  spendResources,
} from '../db/resources.js';
import type {Stockpile} from '../db/resources.js';
import {clearVotes} from '../db/votes.js';
import {NO_STAKE, resolveBattle, rollLuck} from './resolution.js';
import type {BattleOutcome} from './resolution.js';

/** Why Conquest turned a declaration down. */
export type InvadeRefusal =
  | {kind: 'not_configured'}
  | {kind: 'not_in_country'}
  | {kind: 'unknown_country'}
  | {kind: 'self'}
  | {kind: 'target_inactive'}
  | {kind: 'target_defeated'; ownerCode: string | null}
  | {kind: 'no_troops'}
  | {kind: 'cannot_afford'; stockpile: Stockpile}
  | {kind: 'on_cooldown'; until: number}
  | {kind: 'target_protected'; until: number}
  | {kind: 'target_immune'; until: number}
  | {kind: 'attacker_busy'; invasionId: number}
  | {kind: 'target_busy'; invasionId: number};

/** Whether a declaration may be put to the country. */
export type InvadeDecision = {ok: true} | {ok: false; refusal: InvadeRefusal};

/** Whether a stake is affordable out of a stockpile. */
export function canAfford(stockpile: Stockpile, stake: Stake): boolean {
  return (
    stockpile.troops >= stake.troops &&
    stockpile.gold >= stake.gold &&
    stockpile.food >= stake.food
  );
}

/**
 * Decides whether an invasion may be declared.
 *
 * Autocomplete offers only legal targets, but a player can always type
 * something else, so every rule is checked again here.
 */
export function decideInvade(input: {
  configured: boolean;
  attacker: CountryState | undefined;
  defender: CountryState | undefined;
  defenderKnown: boolean;
  stake: Stake;
  attackerPending: Invasion | undefined;
  defenderPending: Invasion | undefined;
  now: number;
}): InvadeDecision {
  const {attacker, defender, stake, now} = input;
  if (!input.configured) return {ok: false, refusal: {kind: 'not_configured'}};
  if (!attacker || attacker.status !== 'active') {
    return {ok: false, refusal: {kind: 'not_in_country'}};
  }
  if (!input.defenderKnown) {
    return {ok: false, refusal: {kind: 'unknown_country'}};
  }
  if (defender && defender.code === attacker.code) {
    return {ok: false, refusal: {kind: 'self'}};
  }
  if (defender?.status === 'defeated') {
    return {
      ok: false,
      refusal: {kind: 'target_defeated', ownerCode: defender.ownerCode},
    };
  }
  if (!defender || defender.status !== 'active') {
    return {ok: false, refusal: {kind: 'target_inactive'}};
  }
  if (stake.troops < 1) return {ok: false, refusal: {kind: 'no_troops'}};
  if (!canAfford(attacker, stake)) {
    return {ok: false, refusal: {kind: 'cannot_afford', stockpile: attacker}};
  }
  if (attacker.invadeCooldownUntil && attacker.invadeCooldownUntil > now) {
    return {
      ok: false,
      refusal: {kind: 'on_cooldown', until: attacker.invadeCooldownUntil},
    };
  }
  if (input.attackerPending) {
    return {
      ok: false,
      refusal: {kind: 'attacker_busy', invasionId: input.attackerPending.id},
    };
  }
  if (input.defenderPending) {
    return {
      ok: false,
      refusal: {kind: 'target_busy', invasionId: input.defenderPending.id},
    };
  }
  if (defender.protectedUntil && defender.protectedUntil > now) {
    return {
      ok: false,
      refusal: {kind: 'target_protected', until: defender.protectedUntil},
    };
  }
  if (defender.defenseImmunityUntil && defender.defenseImmunityUntil > now) {
    return {
      ok: false,
      refusal: {kind: 'target_immune', until: defender.defenseImmunityUntil},
    };
  }
  return {ok: true};
}

/**
 * Opens an attack vote.
 *
 * Nothing is spent yet: the stake is escrowed only if the country approves.
 * The declaration is re-validated inside the transaction, so two players
 * declaring at the same moment cannot both open a vote.
 */
export function declareInvasion(
  db: Database,
  input: {
    guildId: string;
    attackerCode: string;
    defenderCode: string;
    stake: Stake;
    now: number;
  },
): {ok: true; invasion: Invasion} | {ok: false; refusal: InvadeRefusal} {
  return db.transaction(() => {
    const attacker = getCountry(db, input.guildId, input.attackerCode);
    const defender = getCountry(db, input.guildId, input.defenderCode);
    const decision = decideInvade({
      configured: true,
      attacker,
      defender,
      defenderKnown: true,
      stake: input.stake,
      attackerPending: getPendingInvasionFor(
        db,
        input.guildId,
        input.attackerCode,
      ),
      defenderPending: getPendingInvasionFor(
        db,
        input.guildId,
        input.defenderCode,
      ),
      now: input.now,
    });
    if (!decision.ok) return {ok: false as const, refusal: decision.refusal};

    const invasion = createInvasion(db, {
      guildId: input.guildId,
      attackerCode: input.attackerCode,
      defenderCode: input.defenderCode,
      attack: input.stake,
      attackVoteDeadline: input.now + INVASIONS.attackVoteWindow,
      now: input.now,
    });
    return {ok: true as const, invasion};
  })();
}

/** Why an approved attack vote could not go ahead after all. */
export type EscrowFailure = {kind: 'cannot_afford'; stockpile: Stockpile};

/**
 * Escrows the attacker's stake and opens the defence window.
 *
 * The stake leaves the stockpile the moment the vote passes, so a country
 * cannot promise the same troops to two wars or spend them while the battle
 * is pending. If the stockpile has fallen below the stake since the
 * declaration, the invasion is cancelled instead of shipping an army that
 * does not exist.
 */
export function escrowAndOpenDefense(
  db: Database,
  invasion: Invasion,
  now: number,
): {ok: true; defenseDeadline: number} | {ok: false; failure: EscrowFailure} {
  return db.transaction(() => {
    const paid = spendResources(
      db,
      invasion.guildId,
      invasion.attackerCode,
      invasion.attack,
    );
    if (!paid) {
      finishInvasion(db, invasion.id, 'cancelled', now);
      return {
        ok: false as const,
        failure: {
          kind: 'cannot_afford' as const,
          stockpile: getStockpile(
            db,
            invasion.guildId,
            invasion.attackerCode,
          ) ?? {
            food: 0,
            gold: 0,
            troops: 0,
          },
        },
      };
    }

    // Marching voids a new country's protection: you cannot shelter and
    // conquer at the same time.
    db.prepare(
      'UPDATE countries SET protected_until = NULL WHERE guild_id = ? AND code = ?',
    ).run(invasion.guildId, invasion.attackerCode);

    const defenseDeadline = now + INVASIONS.defenseWindow;
    openDefenseWindow(db, invasion.id, defenseDeadline);
    return {ok: true as const, defenseDeadline};
  })();
}

/** Why Conquest turned a defence proposal down. */
export type DefendRefusal =
  | {kind: 'not_in_country'}
  | {kind: 'not_under_attack'}
  | {kind: 'window_closed'}
  | {kind: 'proposal_pending'; proposal: DefenseProposal}
  | {kind: 'already_defended'}
  | {kind: 'no_troops'}
  | {kind: 'cannot_afford'; stockpile: Stockpile};

/**
 * Puts a defence to the defending country.
 *
 * Only one proposal may be pending at a time; a rejected one may be replaced
 * while the window lasts. The vote window is capped by the defence deadline,
 * since a vote that ends after the battle would decide nothing.
 */
export function proposeDefense(
  db: Database,
  input: {
    guildId: string;
    code: string;
    proposerId: string;
    stake: Stake;
    now: number;
  },
):
  | {ok: true; invasion: Invasion; proposal: DefenseProposal}
  | {ok: false; refusal: DefendRefusal} {
  return db.transaction(() => {
    const invasion = getPendingInvasionFor(db, input.guildId, input.code);
    if (!invasion || invasion.defenderCode !== input.code) {
      return {ok: false as const, refusal: {kind: 'not_under_attack' as const}};
    }
    if (invasion.status !== 'defense_window' || !invasion.defenseDeadline) {
      return {ok: false as const, refusal: {kind: 'not_under_attack' as const}};
    }
    if (invasion.defenseDeadline <= input.now) {
      return {ok: false as const, refusal: {kind: 'window_closed' as const}};
    }
    if (invasion.defense) {
      return {ok: false as const, refusal: {kind: 'already_defended' as const}};
    }

    const pending = getPendingProposal(db, invasion.id);
    if (pending) {
      return {
        ok: false as const,
        refusal: {kind: 'proposal_pending' as const, proposal: pending},
      };
    }
    if (input.stake.troops < 1) {
      return {ok: false as const, refusal: {kind: 'no_troops' as const}};
    }

    const stockpile = getStockpile(db, input.guildId, input.code);
    if (!stockpile) {
      return {ok: false as const, refusal: {kind: 'not_in_country' as const}};
    }
    if (!canAfford(stockpile, input.stake)) {
      return {
        ok: false as const,
        refusal: {kind: 'cannot_afford' as const, stockpile},
      };
    }

    // A replacement proposal starts its vote clean.
    clearVotes(db, invasion.id, 'defense');
    const proposal = createProposal(db, {
      invasionId: invasion.id,
      proposerId: input.proposerId,
      stake: input.stake,
      voteDeadline: Math.min(
        input.now + INVASIONS.attackVoteWindow,
        invasion.defenseDeadline,
      ),
      now: input.now,
    });
    return {ok: true as const, invasion, proposal};
  })();
}

/**
 * Escrows an approved defence.
 *
 * As with the attack stake, the resources leave the stockpile immediately so
 * they cannot be spent twice before the battle.
 */
export function escrowDefense(
  db: Database,
  invasion: Invasion,
  proposal: DefenseProposal,
  now: number,
): {ok: true} | {ok: false; failure: EscrowFailure} {
  return db.transaction(() => {
    const paid = spendResources(
      db,
      invasion.guildId,
      invasion.defenderCode,
      proposal.stake,
    );
    if (!paid) {
      finishProposal(db, proposal.id, 'rejected', now);
      return {
        ok: false as const,
        failure: {
          kind: 'cannot_afford' as const,
          stockpile: getStockpile(
            db,
            invasion.guildId,
            invasion.defenderCode,
          ) ?? {
            food: 0,
            gold: 0,
            troops: 0,
          },
        },
      };
    }
    finishProposal(db, proposal.id, 'approved', now);
    setDefenseStake(db, invasion.id, proposal.stake);
    return {ok: true as const};
  })();
}

/** Everything that happened when a battle resolved. */
export interface ResolutionReport {
  invasion: Invasion;
  outcome: BattleOutcome;
  /** The defence that turned up, which may be nothing at all. */
  defense: Stake;
  /** Stockpile looted from the defeated country, on a conquest. */
  loot: Stockpile | null;
  /** Players moved into the winning country, on a conquest. */
  transferredPlayers: string[];
  /** Countries that changed hands, the defender included. */
  capturedTerritories: CountryState[];
  /** The defeated country's role, which must now be deleted. */
  defeatedRoleId: string | null;
  /** The defeated country's channel, which becomes a read-only archive. */
  defeatedChannelId: string | null;
  /** The winner's role, which takes over the archives. */
  winnerRoleId: string | null;
}

/**
 * Resolves a battle and applies everything that follows from it.
 *
 * Resolution happens at the end of the defence window regardless of when the
 * defence vote passed, so defenders cannot probe the timing by approving late.
 *
 * The whole settlement — casualties, returns, loot, players, territory,
 * cooldowns — is one transaction.
 */
export function resolveInvasion(
  db: Database,
  invasion: Invasion,
  now: number,
  random: () => number = Math.random,
): ResolutionReport {
  const defense = invasion.defense ?? NO_STAKE;
  const outcome = resolveBattle(invasion.attack, defense, {
    attacker: rollLuck(random),
    defender: rollLuck(random),
  });

  return db.transaction(() => {
    const {guildId, attackerCode, defenderCode} = invasion;

    // Whoever wins, the attacker cannot march again for a while.
    db.prepare(
      'UPDATE countries SET invade_cooldown_until = ? WHERE guild_id = ? AND code = ?',
    ).run(now + COOLDOWNS.invade, guildId, attackerCode);

    if (!outcome.attackerWins) {
      addResources(db, guildId, defenderCode, outcome.defenderReturns);
      addResources(db, guildId, defenderCode, outcome.captured);
      db.prepare(
        'UPDATE countries SET defense_immunity_until = ? WHERE guild_id = ? AND code = ?',
      ).run(now + INVASIONS.successfulDefenseImmunity, guildId, defenderCode);
      finishInvasion(db, invasion.id, 'resolved_defender_win', now);
      return {
        invasion,
        outcome,
        defense,
        loot: null,
        transferredPlayers: [],
        capturedTerritories: [],
        defeatedRoleId: null,
        defeatedChannelId: null,
        winnerRoleId: getCountry(db, guildId, defenderCode)?.roleId ?? null,
      };
    }

    const defeated = getCountry(db, guildId, defenderCode)!;
    const winner = getCountry(db, guildId, attackerCode)!;

    // Survivors march home; their supplies were spent on the campaign.
    addResources(db, guildId, attackerCode, outcome.attackerReturns);

    // Everything the defender had left is carried off.
    const loot = lootStockpile(db, guildId, defenderCode, attackerCode);

    const transferredPlayers = transferPlayers(db, {
      guildId,
      fromCode: defenderCode,
      toCode: attackerCode,
      now,
    });

    // The defeated country and everything it had taken become the winner's.
    const inherited = listTerritories(db, guildId, defenderCode);
    db.prepare(
      `UPDATE countries SET owner_code = ?
        WHERE guild_id = ? AND owner_code = ?`,
    ).run(attackerCode, guildId, defenderCode);
    db.prepare(
      `UPDATE countries
          SET status = 'defeated', owner_code = ?, role_id = NULL,
              food = 0, gold = 0, troops = 0,
              protected_until = NULL, invade_cooldown_until = NULL,
              defense_immunity_until = NULL
        WHERE guild_id = ? AND code = ?`,
    ).run(attackerCode, guildId, defenderCode);

    finishInvasion(db, invasion.id, 'resolved_attacker_win', now);

    return {
      invasion,
      outcome,
      defense,
      loot,
      transferredPlayers,
      capturedTerritories: [
        getCountry(db, guildId, defenderCode)!,
        ...inherited,
      ],
      defeatedRoleId: defeated.roleId,
      defeatedChannelId: defeated.channelId,
      winnerRoleId: winner.roleId,
    };
  })();
}

/**
 * Calls off an invasion and hands back everything that was escrowed.
 *
 * Used when a country empties mid-war: there is nobody left to fight it, and
 * the other side should not lose a stake to an opponent that ceased to exist.
 */
export function cancelInvasion(
  db: Database,
  invasion: Invasion,
  now: number,
): void {
  db.transaction(() => {
    if (invasion.status === 'defense_window') {
      addResources(
        db,
        invasion.guildId,
        invasion.attackerCode,
        invasion.attack,
      );
      if (invasion.defense) {
        addResources(
          db,
          invasion.guildId,
          invasion.defenderCode,
          invasion.defense,
        );
      }
    }
    const pending = getPendingProposal(db, invasion.id);
    if (pending) finishProposal(db, pending.id, 'expired', now);
    finishInvasion(db, invasion.id, 'cancelled', now);
  })();
}

/** Records where a defeated country's archive lives after a conquest. */
export function recordArchive(
  db: Database,
  guildId: string,
  code: string,
  channelId: string,
): void {
  setCountryChannel(db, guildId, code, channelId);
}

/** Players in a country right now, for reading a vote against its size. */
export function memberCount(
  db: Database,
  guildId: string,
  code: string,
): number {
  return countCountryMembers(db, guildId, code);
}
