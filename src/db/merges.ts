import type {Database} from 'better-sqlite3';

/** Where a merge is in its life. */
export type MergeStatus =
  | 'offer_vote'
  | 'accept_vote'
  | 'completed'
  | 'declined'
  | 'expired'
  | 'cancelled';

/** Which of a merge's two votes a ballot belongs to. */
export type MergeVoteKind = 'offer' | 'accept';

/** How someone voted on a merge. */
export type MergeVoteChoice = 'approve' | 'reject';

/** The state of a merge vote in progress. */
export interface MergeTally {
  approve: number;
  reject: number;
}

/** One merge, from the offer to the union. */
export interface Merge {
  id: number;
  guildId: string;
  /** The country offering to give itself up. */
  fromCode: string;
  /** The country asked to absorb it. */
  intoCode: string;
  proposerId: string;
  status: MergeStatus;
  /** When the offering country's vote lapses. */
  offerDeadline: number;
  /** When the absorbing country's vote lapses, once it is being asked. */
  acceptDeadline: number | null;
  offerMessageId: string | null;
  acceptMessageId: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

interface MergeRow {
  id: number;
  guild_id: string;
  from_code: string;
  into_code: string;
  proposer_id: string;
  status: MergeStatus;
  offer_deadline: number;
  accept_deadline: number | null;
  offer_message_id: string | null;
  accept_message_id: string | null;
  created_at: number;
  resolved_at: number | null;
}

function toMerge(row: MergeRow): Merge {
  return {
    id: row.id,
    guildId: row.guild_id,
    fromCode: row.from_code,
    intoCode: row.into_code,
    proposerId: row.proposer_id,
    status: row.status,
    offerDeadline: row.offer_deadline,
    acceptDeadline: row.accept_deadline,
    offerMessageId: row.offer_message_id,
    acceptMessageId: row.accept_message_id,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

/** Opens a merge offer, with the offering country's vote already running. */
export function createMerge(
  db: Database,
  input: {
    guildId: string;
    fromCode: string;
    intoCode: string;
    proposerId: string;
    offerDeadline: number;
    now: number;
  },
): Merge {
  const result = db
    .prepare(
      `INSERT INTO merges
         (guild_id, from_code, into_code, proposer_id, status,
          offer_deadline, created_at)
       VALUES (?, ?, ?, ?, 'offer_vote', ?, ?)`,
    )
    .run(
      input.guildId,
      input.fromCode,
      input.intoCode,
      input.proposerId,
      input.offerDeadline,
      input.now,
    );
  return getMerge(db, Number(result.lastInsertRowid))!;
}

/** Reads one merge. */
export function getMerge(db: Database, id: number): Merge | undefined {
  const row = db.prepare('SELECT * FROM merges WHERE id = ?').get(id) as
    MergeRow | undefined;
  return row && toMerge(row);
}

/**
 * The merge a country is caught up in, on either side.
 *
 * A country may be in at most one at a time, which is what makes a second
 * offer rejectable while one is still on the table.
 */
export function getPendingMergeFor(
  db: Database,
  guildId: string,
  code: string,
): Merge | undefined {
  const row = db
    .prepare(
      `SELECT * FROM merges
        WHERE guild_id = ?
          AND (from_code = ? OR into_code = ?)
          AND status IN ('offer_vote', 'accept_vote')
        ORDER BY id
        LIMIT 1`,
    )
    .get(guildId, code, code) as MergeRow | undefined;
  return row && toMerge(row);
}

/** Every merge still being decided in a guild. */
export function listPendingMerges(db: Database, guildId: string): Merge[] {
  return (
    db
      .prepare(
        `SELECT * FROM merges
          WHERE guild_id = ? AND status IN ('offer_vote', 'accept_vote')
          ORDER BY id`,
      )
      .all(guildId) as MergeRow[]
  ).map(toMerge);
}

/**
 * Merge votes whose window has closed, across every guild.
 *
 * The sweeper works globally because deadlines are absolute timestamps, not
 * per-guild timers.
 */
export function listExpiredMergeVotes(db: Database, now: number): Merge[] {
  return (
    db
      .prepare(
        `SELECT * FROM merges
          WHERE (status = 'offer_vote' AND offer_deadline <= ?)
             OR (status = 'accept_vote' AND accept_deadline <= ?)
          ORDER BY id`,
      )
      .all(now, now) as MergeRow[]
  ).map(toMerge);
}

/** Passes an approved offer to the country asked to absorb it. */
export function openAcceptVote(
  db: Database,
  id: number,
  acceptDeadline: number,
): void {
  db.prepare(
    `UPDATE merges SET status = 'accept_vote', accept_deadline = ?
      WHERE id = ?`,
  ).run(acceptDeadline, id);
}

/** Records the message a vote is being held on, so it can be closed later. */
export function setMergeMessage(
  db: Database,
  id: number,
  kind: MergeVoteKind,
  messageId: string,
): void {
  const column = kind === 'offer' ? 'offer_message_id' : 'accept_message_id';
  db.prepare(`UPDATE merges SET ${column} = ? WHERE id = ?`).run(messageId, id);
}

/** Settles a merge, however it ended. */
export function finishMerge(
  db: Database,
  id: number,
  status: MergeStatus,
  now: number,
): void {
  db.prepare('UPDATE merges SET status = ?, resolved_at = ? WHERE id = ?').run(
    status,
    now,
    id,
  );
}

/**
 * Casts or changes a merge vote.
 *
 * One row per voter per vote, so changing your mind updates your ballot
 * rather than stuffing the box.
 */
export function castMergeVote(
  db: Database,
  input: {
    mergeId: number;
    kind: MergeVoteKind;
    userId: string;
    choice: MergeVoteChoice;
    now: number;
  },
): void {
  db.prepare(
    `INSERT INTO merge_votes (merge_id, kind, user_id, choice, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (merge_id, kind, user_id) DO UPDATE SET
       choice = excluded.choice,
       created_at = excluded.created_at`,
  ).run(input.mergeId, input.kind, input.userId, input.choice, input.now);
}

/** Counts the ballots cast on one side of a merge. */
export function tallyMergeVotes(
  db: Database,
  mergeId: number,
  kind: MergeVoteKind,
): MergeTally {
  const rows = db
    .prepare(
      `SELECT choice, count(*) AS votes FROM merge_votes
        WHERE merge_id = ? AND kind = ?
        GROUP BY choice`,
    )
    .all(mergeId, kind) as Array<{choice: MergeVoteChoice; votes: number}>;
  const tally: MergeTally = {approve: 0, reject: 0};
  for (const row of rows) tally[row.choice] = row.votes;
  return tally;
}

/**
 * Discards a player's pending merge ballots when they leave their country, so
 * the threshold is recalculated over the players who are actually still there.
 */
export function discardPlayerMergeVotes(
  db: Database,
  guildId: string,
  userId: string,
): void {
  db.prepare(
    `DELETE FROM merge_votes
      WHERE user_id = ?
        AND merge_id IN (
          SELECT id FROM merges
           WHERE guild_id = ? AND status IN ('offer_vote', 'accept_vote')
        )`,
  ).run(userId, guildId);
}

/**
 * Calls off every merge a country is part of, as when it is disbanded,
 * conquered, or marched to war.
 *
 * @returns the merges that were called off, so both sides can be told.
 */
export function cancelMergesFor(
  db: Database,
  guildId: string,
  code: string,
  now: number,
): Merge[] {
  return db.transaction(() => {
    const affected = (
      db
        .prepare(
          `SELECT * FROM merges
            WHERE guild_id = ?
              AND (from_code = ? OR into_code = ?)
              AND status IN ('offer_vote', 'accept_vote')
            ORDER BY id`,
        )
        .all(guildId, code, code) as MergeRow[]
    ).map(toMerge);
    for (const merge of affected) finishMerge(db, merge.id, 'cancelled', now);
    return affected;
  })();
}
