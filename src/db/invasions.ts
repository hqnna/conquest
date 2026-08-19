import type {Database} from 'better-sqlite3';

/** Where an invasion is in its life. */
export type InvasionStatus =
  | 'attack_vote'
  | 'defense_window'
  | 'resolved_attacker_win'
  | 'resolved_defender_win'
  | 'cancelled';

/** Statuses in which a country is considered busy fighting. */
export const PENDING_STATUSES: readonly InvasionStatus[] = [
  'attack_vote',
  'defense_window',
];

/** A stake of troops and supplies committed to a battle. */
export interface Stake {
  troops: number;
  gold: number;
  food: number;
}

/** One invasion, from declaration to resolution. */
export interface Invasion {
  id: number;
  guildId: string;
  attackerCode: string;
  defenderCode: string;
  attack: Stake;
  /** The defence that was approved, or null if none ever was. */
  defense: Stake | null;
  status: InvasionStatus;
  attackVoteDeadline: number;
  /** When the battle resolves; set once the attack vote passes. */
  defenseDeadline: number | null;
  attackMessageId: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

interface InvasionRow {
  id: number;
  guild_id: string;
  attacker_code: string;
  defender_code: string;
  attack_troops: number;
  attack_gold: number;
  attack_food: number;
  defense_troops: number | null;
  defense_gold: number | null;
  defense_food: number | null;
  status: InvasionStatus;
  attack_vote_deadline: number;
  defense_deadline: number | null;
  attack_message_id: string | null;
  created_at: number;
  resolved_at: number | null;
}

function toInvasion(row: InvasionRow): Invasion {
  return {
    id: row.id,
    guildId: row.guild_id,
    attackerCode: row.attacker_code,
    defenderCode: row.defender_code,
    attack: {
      troops: row.attack_troops,
      gold: row.attack_gold,
      food: row.attack_food,
    },
    defense:
      row.defense_troops === null
        ? null
        : {
            troops: row.defense_troops,
            gold: row.defense_gold ?? 0,
            food: row.defense_food ?? 0,
          },
    status: row.status,
    attackVoteDeadline: row.attack_vote_deadline,
    defenseDeadline: row.defense_deadline,
    attackMessageId: row.attack_message_id,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

/** Reads one invasion. */
export function getInvasion(db: Database, id: number): Invasion | undefined {
  const row = db.prepare('SELECT * FROM invasions WHERE id = ?').get(id) as
    InvasionRow | undefined;
  return row && toInvasion(row);
}

/**
 * The invasion a country is currently caught up in, attacking or defending.
 *
 * A country may be in at most one at a time, which is what makes overlapping
 * declarations rejectable.
 */
export function getPendingInvasionFor(
  db: Database,
  guildId: string,
  code: string,
): Invasion | undefined {
  const row = db
    .prepare(
      `SELECT * FROM invasions
        WHERE guild_id = ?
          AND (attacker_code = ? OR defender_code = ?)
          AND status IN ('attack_vote', 'defense_window')
        ORDER BY id
        LIMIT 1`,
    )
    .get(guildId, code, code) as InvasionRow | undefined;
  return row && toInvasion(row);
}

/** Every invasion still in flight in a guild. */
export function listPendingInvasions(
  db: Database,
  guildId: string,
): Invasion[] {
  return (
    db
      .prepare(
        `SELECT * FROM invasions
          WHERE guild_id = ? AND status IN ('attack_vote', 'defense_window')
          ORDER BY id`,
      )
      .all(guildId) as InvasionRow[]
  ).map(toInvasion);
}

/**
 * Attack votes whose window has closed, across every guild.
 *
 * The sweeper works globally because deadlines are absolute timestamps, not
 * per-guild timers.
 */
export function listExpiredAttackVotes(db: Database, now: number): Invasion[] {
  return (
    db
      .prepare(
        `SELECT * FROM invasions
          WHERE status = 'attack_vote' AND attack_vote_deadline <= ?
          ORDER BY id`,
      )
      .all(now) as InvasionRow[]
  ).map(toInvasion);
}

/** Invasions whose defence window has closed and which must now resolve. */
export function listInvasionsToResolve(db: Database, now: number): Invasion[] {
  return (
    db
      .prepare(
        `SELECT * FROM invasions
          WHERE status = 'defense_window' AND defense_deadline <= ?
          ORDER BY id`,
      )
      .all(now) as InvasionRow[]
  ).map(toInvasion);
}

/** Opens an invasion with the attacker's proposed stake. */
export function createInvasion(
  db: Database,
  input: {
    guildId: string;
    attackerCode: string;
    defenderCode: string;
    attack: Stake;
    attackVoteDeadline: number;
    now: number;
  },
): Invasion {
  const result = db
    .prepare(
      `INSERT INTO invasions
         (guild_id, attacker_code, defender_code, attack_troops, attack_gold,
          attack_food, status, attack_vote_deadline, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'attack_vote', ?, ?)`,
    )
    .run(
      input.guildId,
      input.attackerCode,
      input.defenderCode,
      input.attack.troops,
      input.attack.gold,
      input.attack.food,
      input.attackVoteDeadline,
      input.now,
    );
  return getInvasion(db, Number(result.lastInsertRowid))!;
}

/** Remembers the vote message, so an expiry can still disable its buttons. */
export function setAttackMessage(
  db: Database,
  id: number,
  messageId: string,
): void {
  db.prepare('UPDATE invasions SET attack_message_id = ? WHERE id = ?').run(
    messageId,
    id,
  );
}

/** Moves an approved invasion into its defence window. */
export function openDefenseWindow(
  db: Database,
  id: number,
  defenseDeadline: number,
): void {
  db.prepare(
    `UPDATE invasions SET status = 'defense_window', defense_deadline = ?
      WHERE id = ? AND status = 'attack_vote'`,
  ).run(defenseDeadline, id);
}

/** Records the defence stake that was approved and escrowed. */
export function setDefenseStake(db: Database, id: number, stake: Stake): void {
  db.prepare(
    `UPDATE invasions
        SET defense_troops = ?, defense_gold = ?, defense_food = ?
      WHERE id = ?`,
  ).run(stake.troops, stake.gold, stake.food, id);
}

/** Closes an invasion with its outcome. */
export function finishInvasion(
  db: Database,
  id: number,
  status: Exclude<InvasionStatus, 'attack_vote' | 'defense_window'>,
  now: number,
): void {
  db.prepare(
    'UPDATE invasions SET status = ?, resolved_at = ? WHERE id = ?',
  ).run(status, now, id);
}

/** A defence a player has put to their country. */
export interface DefenseProposal {
  id: number;
  invasionId: number;
  proposerId: string;
  stake: Stake;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  voteDeadline: number;
  messageId: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

interface DefenseProposalRow {
  id: number;
  invasion_id: number;
  proposer_id: string;
  troops: number;
  gold: number;
  food: number;
  status: DefenseProposal['status'];
  vote_deadline: number;
  message_id: string | null;
  created_at: number;
  resolved_at: number | null;
}

function toProposal(row: DefenseProposalRow): DefenseProposal {
  return {
    id: row.id,
    invasionId: row.invasion_id,
    proposerId: row.proposer_id,
    stake: {troops: row.troops, gold: row.gold, food: row.food},
    status: row.status,
    voteDeadline: row.vote_deadline,
    messageId: row.message_id,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

/** Reads a proposal by id. */
export function getProposal(
  db: Database,
  id: number,
): DefenseProposal | undefined {
  const row = db
    .prepare('SELECT * FROM defense_proposals WHERE id = ?')
    .get(id) as DefenseProposalRow | undefined;
  return row && toProposal(row);
}

/** The defence currently being voted on, if any. */
export function getPendingProposal(
  db: Database,
  invasionId: number,
): DefenseProposal | undefined {
  const row = db
    .prepare(
      `SELECT * FROM defense_proposals
        WHERE invasion_id = ? AND status = 'pending'
        ORDER BY id DESC LIMIT 1`,
    )
    .get(invasionId) as DefenseProposalRow | undefined;
  return row && toProposal(row);
}

/** Proposals whose vote window has closed. */
export function listExpiredProposals(
  db: Database,
  now: number,
): DefenseProposal[] {
  return (
    db
      .prepare(
        `SELECT * FROM defense_proposals
          WHERE status = 'pending' AND vote_deadline <= ?
          ORDER BY id`,
      )
      .all(now) as DefenseProposalRow[]
  ).map(toProposal);
}

/** Puts a defence to the country. */
export function createProposal(
  db: Database,
  input: {
    invasionId: number;
    proposerId: string;
    stake: Stake;
    voteDeadline: number;
    now: number;
  },
): DefenseProposal {
  const result = db
    .prepare(
      `INSERT INTO defense_proposals
         (invasion_id, proposer_id, troops, gold, food, status, vote_deadline, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(
      input.invasionId,
      input.proposerId,
      input.stake.troops,
      input.stake.gold,
      input.stake.food,
      input.voteDeadline,
      input.now,
    );
  return getProposal(db, Number(result.lastInsertRowid))!;
}

/** Remembers a proposal's vote message. */
export function setProposalMessage(
  db: Database,
  id: number,
  messageId: string,
): void {
  db.prepare('UPDATE defense_proposals SET message_id = ? WHERE id = ?').run(
    messageId,
    id,
  );
}

/** Closes a proposal. A rejected one may be replaced within the window. */
export function finishProposal(
  db: Database,
  id: number,
  status: Exclude<DefenseProposal['status'], 'pending'>,
  now: number,
): void {
  db.prepare(
    `UPDATE defense_proposals SET status = ?, resolved_at = ?
      WHERE id = ? AND status = 'pending'`,
  ).run(status, now, id);
}
