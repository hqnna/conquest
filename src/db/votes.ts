import type {Database} from 'better-sqlite3';

/** Which vote a ballot belongs to. */
export type VoteKind = 'attack' | 'defense';

/** How someone voted. */
export type VoteChoice = 'approve' | 'reject';

/** The state of a vote in progress. */
export interface Tally {
  approve: number;
  reject: number;
}

/**
 * Casts or changes a vote.
 *
 * One row per voter per vote, so changing your mind updates your ballot
 * rather than stuffing the box.
 */
export function castVote(
  db: Database,
  input: {
    invasionId: number;
    kind: VoteKind;
    userId: string;
    choice: VoteChoice;
    now: number;
  },
): void {
  db.prepare(
    `INSERT INTO votes (invasion_id, kind, user_id, choice, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (invasion_id, kind, user_id) DO UPDATE SET
       choice = excluded.choice,
       created_at = excluded.created_at`,
  ).run(input.invasionId, input.kind, input.userId, input.choice, input.now);
}

/** How one player voted, if they have. */
export function getVote(
  db: Database,
  invasionId: number,
  kind: VoteKind,
  userId: string,
): VoteChoice | undefined {
  const row = db
    .prepare(
      'SELECT choice FROM votes WHERE invasion_id = ? AND kind = ? AND user_id = ?',
    )
    .get(invasionId, kind, userId) as {choice: VoteChoice} | undefined;
  return row?.choice;
}

/** Counts the ballots cast so far. */
export function tallyVotes(
  db: Database,
  invasionId: number,
  kind: VoteKind,
): Tally {
  const rows = db
    .prepare(
      `SELECT choice, count(*) AS votes FROM votes
        WHERE invasion_id = ? AND kind = ?
        GROUP BY choice`,
    )
    .all(invasionId, kind) as Array<{choice: VoteChoice; votes: number}>;
  const tally: Tally = {approve: 0, reject: 0};
  for (const row of rows) tally[row.choice] = row.votes;
  return tally;
}

/** Everyone who has voted, for showing who is still holding out. */
export function listVoters(
  db: Database,
  invasionId: number,
  kind: VoteKind,
): Map<string, VoteChoice> {
  const rows = db
    .prepare(
      'SELECT user_id, choice FROM votes WHERE invasion_id = ? AND kind = ?',
    )
    .all(invasionId, kind) as Array<{user_id: string; choice: VoteChoice}>;
  return new Map(rows.map(row => [row.user_id, row.choice]));
}

/**
 * Throws away one round of votes, as when a rejected defence proposal is
 * replaced by a new one.
 */
export function clearVotes(
  db: Database,
  invasionId: number,
  kind: VoteKind,
): void {
  db.prepare('DELETE FROM votes WHERE invasion_id = ? AND kind = ?').run(
    invasionId,
    kind,
  );
}

/**
 * Discards a player's pending ballots when they leave their country, so the
 * threshold is recalculated over the players who are actually still there.
 */
export function discardPlayerVotes(
  db: Database,
  guildId: string,
  userId: string,
): void {
  db.prepare(
    `DELETE FROM votes
      WHERE user_id = ?
        AND invasion_id IN (
          SELECT id FROM invasions
           WHERE guild_id = ? AND status IN ('attack_vote', 'defense_window')
        )`,
  ).run(userId, guildId);
}
