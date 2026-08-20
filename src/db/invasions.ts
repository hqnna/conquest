import type {Database} from 'better-sqlite3';

/** Where an invasion is in its life. */
export type InvasionStatus =
  | 'attack_vote'
  | 'defense_window'
  | 'war'
  | 'reinforcing'
  | 'resolved_attacker_win'
  | 'resolved_defender_win'
  | 'cancelled';

/** Statuses in which a country is considered busy fighting. */
export const PENDING_STATUSES: readonly InvasionStatus[] = [
  'attack_vote',
  'defense_window',
  'war',
  'reinforcing',
];

/** Which country a stake, a vote, or a surrender belongs to. */
export type Side = 'attacker' | 'defender';

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
  /** Everything the attacker has committed, reinforcements included. */
  attack: Stake;
  /** Everything the defender has committed, or null if it never defended. */
  defense: Stake | null;
  /** What the attacker still has standing on the field. */
  attackField: Stake;
  /** What the defender still has standing on the field. */
  defenseField: Stake;
  status: InvasionStatus;
  attackVoteDeadline: number;
  /** When the defender's chance to answer the invasion runs out. */
  defenseDeadline: number | null;
  /** When the next round of fighting lands. */
  nextTickAt: number | null;
  /** Which side must reinforce or give up. */
  reinforcingSide: Side | null;
  /** When that side's silence becomes a surrender. */
  reinforceDeadline: number | null;
  /** Rounds fought so far. */
  rounds: number;
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
  attack_field_troops: number;
  attack_field_gold: number;
  attack_field_food: number;
  defense_field_troops: number;
  defense_field_gold: number;
  defense_field_food: number;
  status: InvasionStatus;
  attack_vote_deadline: number;
  defense_deadline: number | null;
  next_tick_at: number | null;
  reinforcing_side: Side | null;
  reinforce_deadline: number | null;
  rounds: number;
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
    attackField: {
      troops: row.attack_field_troops,
      gold: row.attack_field_gold,
      food: row.attack_field_food,
    },
    defenseField: {
      troops: row.defense_field_troops,
      gold: row.defense_field_gold,
      food: row.defense_field_food,
    },
    status: row.status,
    attackVoteDeadline: row.attack_vote_deadline,
    defenseDeadline: row.defense_deadline,
    nextTickAt: row.next_tick_at,
    reinforcingSide: row.reinforcing_side,
    reinforceDeadline: row.reinforce_deadline,
    rounds: row.rounds,
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
 * One of the invasions a country is caught up in, attacking or defending.
 *
 * A country may be in several at once — that is what lets a third country come
 * to somebody's aid by striking their invader mid-war — so this answers "is it
 * fighting at all", and callers that need to act on a particular war use
 * {@link listPendingInvasionsFor} or {@link getPendingInvasionBetween}.
 */
export function getPendingInvasionFor(
  db: Database,
  guildId: string,
  code: string,
): Invasion | undefined {
  return listPendingInvasionsFor(db, guildId, code)[0];
}

/**
 * Every invasion a country is caught up in, oldest first, on either side.
 *
 * Wars are independent of one another: each has its own escrow, its own
 * rounds, and its own end.
 */
export function listPendingInvasionsFor(
  db: Database,
  guildId: string,
  code: string,
): Invasion[] {
  return (
    db
      .prepare(
        `SELECT * FROM invasions
          WHERE guild_id = ?
            AND (attacker_code = ? OR defender_code = ?)
            AND status IN ('attack_vote', 'defense_window', 'war', 'reinforcing')
          ORDER BY id`,
      )
      .all(guildId, code, code) as InvasionRow[]
  ).map(toInvasion);
}

/**
 * The pending invasion of one country by another, if there is one.
 *
 * Direction matters: a country marching on its own invader is a second war,
 * not this one. What this rules out is the same country declaring twice on the
 * same target.
 */
export function getPendingInvasionBetween(
  db: Database,
  guildId: string,
  attackerCode: string,
  defenderCode: string,
): Invasion | undefined {
  const row = db
    .prepare(
      `SELECT * FROM invasions
        WHERE guild_id = ? AND attacker_code = ? AND defender_code = ?
          AND status IN ('attack_vote', 'defense_window', 'war', 'reinforcing')
        ORDER BY id
        LIMIT 1`,
    )
    .get(guildId, attackerCode, defenderCode) as InvasionRow | undefined;
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
          WHERE guild_id = ?
            AND status IN ('attack_vote', 'defense_window', 'war', 'reinforcing')
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

/** Invasions whose defence window closed without an answer. */
export function listUnansweredInvasions(db: Database, now: number): Invasion[] {
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

/** Wars with a round of fighting due. */
export function listWarsDueATick(db: Database, now: number): Invasion[] {
  return (
    db
      .prepare(
        `SELECT * FROM invasions
          WHERE status = 'war' AND next_tick_at <= ?
          ORDER BY id`,
      )
      .all(now) as InvasionRow[]
  ).map(toInvasion);
}

/** Wars where a side has run out of time to reinforce. */
export function listExpiredReinforcements(
  db: Database,
  now: number,
): Invasion[] {
  return (
    db
      .prepare(
        `SELECT * FROM invasions
          WHERE status = 'reinforcing' AND reinforce_deadline <= ?
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

/**
 * Marches: the attacker's stake takes the field and the defender is given its
 * chance to answer.
 */
export function openDefenseWindow(
  db: Database,
  id: number,
  attack: Stake,
  defenseDeadline: number,
): void {
  db.prepare(
    `UPDATE invasions
        SET status = 'defense_window', defense_deadline = ?,
            attack_field_troops = ?, attack_field_gold = ?, attack_field_food = ?
      WHERE id = ? AND status = 'attack_vote'`,
  ).run(defenseDeadline, attack.troops, attack.gold, attack.food, id);
}

/** The defence turns up, and the fighting starts. */
export function beginWar(
  db: Database,
  id: number,
  defense: Stake,
  firstTickAt: number,
): void {
  db.prepare(
    `UPDATE invasions
        SET status = 'war',
            defense_troops = ?, defense_gold = ?, defense_food = ?,
            defense_field_troops = ?, defense_field_gold = ?, defense_field_food = ?,
            next_tick_at = ?
      WHERE id = ? AND status = 'defense_window'`,
  ).run(
    defense.troops,
    defense.gold,
    defense.food,
    defense.troops,
    defense.gold,
    defense.food,
    firstTickAt,
    id,
  );
}

/** Writes back what survived a round, and schedules the next. */
export function recordRound(
  db: Database,
  id: number,
  fields: {attack: Stake; defense: Stake},
  nextTickAt: number,
): void {
  db.prepare(
    `UPDATE invasions
        SET attack_field_troops = ?, attack_field_gold = ?, attack_field_food = ?,
            defense_field_troops = ?, defense_field_gold = ?, defense_field_food = ?,
            rounds = rounds + 1,
            next_tick_at = ?
      WHERE id = ?`,
  ).run(
    fields.attack.troops,
    fields.attack.gold,
    fields.attack.food,
    fields.defense.troops,
    fields.defense.gold,
    fields.defense.food,
    nextTickAt,
    id,
  );
}

/** Pauses the war while one side decides to reinforce or give up. */
export function openReinforcement(
  db: Database,
  id: number,
  side: Side,
  deadline: number,
): void {
  db.prepare(
    `UPDATE invasions
        SET status = 'reinforcing', reinforcing_side = ?,
            reinforce_deadline = ?, next_tick_at = NULL
      WHERE id = ?`,
  ).run(side, deadline, id);
}

/** Fresh forces arrive, and the fighting resumes. */
export function applyReinforcement(
  db: Database,
  id: number,
  side: Side,
  stake: Stake,
  nextTickAt: number,
): void {
  const columns =
    side === 'attacker'
      ? {
          total: ['attack_troops', 'attack_gold', 'attack_food'],
          field: [
            'attack_field_troops',
            'attack_field_gold',
            'attack_field_food',
          ],
        }
      : {
          total: ['defense_troops', 'defense_gold', 'defense_food'],
          field: [
            'defense_field_troops',
            'defense_field_gold',
            'defense_field_food',
          ],
        };
  db.prepare(
    `UPDATE invasions
        SET ${columns.total[0]} = COALESCE(${columns.total[0]}, 0) + ?,
            ${columns.total[1]} = COALESCE(${columns.total[1]}, 0) + ?,
            ${columns.total[2]} = COALESCE(${columns.total[2]}, 0) + ?,
            ${columns.field[0]} = ${columns.field[0]} + ?,
            ${columns.field[1]} = ${columns.field[1]} + ?,
            ${columns.field[2]} = ${columns.field[2]} + ?,
            status = 'war', reinforcing_side = NULL,
            reinforce_deadline = NULL, next_tick_at = ?
      WHERE id = ?`,
  ).run(
    stake.troops,
    stake.gold,
    stake.food,
    stake.troops,
    stake.gold,
    stake.food,
    nextTickAt,
    id,
  );
}

/** Closes an invasion with its outcome. */
export function finishInvasion(
  db: Database,
  id: number,
  status: Extract<
    InvasionStatus,
    'resolved_attacker_win' | 'resolved_defender_win' | 'cancelled'
  >,
  now: number,
): void {
  db.prepare(
    `UPDATE invasions
        SET status = ?, resolved_at = ?, next_tick_at = NULL,
            reinforcing_side = NULL, reinforce_deadline = NULL
      WHERE id = ?`,
  ).run(status, now, id);
}

/** A stake somebody has put to their country: the defence, or reinforcements. */
export interface StakeProposal {
  id: number;
  invasionId: number;
  side: Side;
  kind: 'defense' | 'reinforcement';
  proposerId: string;
  stake: Stake;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  voteDeadline: number;
  messageId: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

interface StakeProposalRow {
  id: number;
  invasion_id: number;
  side: Side;
  kind: 'defense' | 'reinforcement';
  proposer_id: string;
  troops: number;
  gold: number;
  food: number;
  status: StakeProposal['status'];
  vote_deadline: number;
  message_id: string | null;
  created_at: number;
  resolved_at: number | null;
}

function toProposal(row: StakeProposalRow): StakeProposal {
  return {
    id: row.id,
    invasionId: row.invasion_id,
    side: row.side,
    kind: row.kind,
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
): StakeProposal | undefined {
  const row = db
    .prepare('SELECT * FROM stake_proposals WHERE id = ?')
    .get(id) as StakeProposalRow | undefined;
  return row && toProposal(row);
}

/** The stake currently being voted on, if any. */
export function getPendingProposal(
  db: Database,
  invasionId: number,
): StakeProposal | undefined {
  const row = db
    .prepare(
      `SELECT * FROM stake_proposals
        WHERE invasion_id = ? AND status = 'pending'
        ORDER BY id DESC LIMIT 1`,
    )
    .get(invasionId) as StakeProposalRow | undefined;
  return row && toProposal(row);
}

/** Proposals whose vote window has closed. */
export function listExpiredProposals(
  db: Database,
  now: number,
): StakeProposal[] {
  return (
    db
      .prepare(
        `SELECT * FROM stake_proposals
          WHERE status = 'pending' AND vote_deadline <= ?
          ORDER BY id`,
      )
      .all(now) as StakeProposalRow[]
  ).map(toProposal);
}

/** Puts a stake to a country. */
export function createProposal(
  db: Database,
  input: {
    invasionId: number;
    side: Side;
    kind: 'defense' | 'reinforcement';
    proposerId: string;
    stake: Stake;
    voteDeadline: number;
    now: number;
  },
): StakeProposal {
  const result = db
    .prepare(
      `INSERT INTO stake_proposals
         (invasion_id, side, kind, proposer_id, troops, gold, food, status,
          vote_deadline, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(
      input.invasionId,
      input.side,
      input.kind,
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
  db.prepare('UPDATE stake_proposals SET message_id = ? WHERE id = ?').run(
    messageId,
    id,
  );
}

/** Closes a proposal. A rejected one may be replaced while there is time. */
export function finishProposal(
  db: Database,
  id: number,
  status: Exclude<StakeProposal['status'], 'pending'>,
  now: number,
): void {
  db.prepare(
    `UPDATE stake_proposals SET status = ?, resolved_at = ?
      WHERE id = ? AND status = 'pending'`,
  ).run(status, now, id);
}
