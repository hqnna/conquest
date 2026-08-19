/**
 * Vote thresholds.
 *
 * A vote passes on a strict majority of the country's *current* player count,
 * so the bar moves as players join and leave. It is therefore always
 * recalculated at the moment a vote is counted, never cached with the vote.
 */
import type {Tally} from '../db/votes.js';

/** Ballots needed to pass: more than half the country. */
export function threshold(memberCount: number): number {
  return Math.floor(memberCount / 2) + 1;
}

/** What a tally means right now. */
export type VoteOutcome = 'approved' | 'rejected' | 'pending';

/**
 * Reads a tally against the country it belongs to.
 *
 * A vote is decided the moment the answer is certain: once approvals reach
 * the threshold it passes, and once enough players have rejected that the
 * threshold can no longer be reached it fails, rather than making everyone
 * wait out a window whose outcome is already fixed.
 *
 * A one-player country therefore passes on its own single vote, which is what
 * makes the founder's `/invade` count as their approval.
 */
export function readTally(tally: Tally, memberCount: number): VoteOutcome {
  if (memberCount <= 0) return 'rejected';
  const needed = threshold(memberCount);
  if (tally.approve >= needed) return 'approved';

  const undecided = Math.max(0, memberCount - tally.approve - tally.reject);
  if (tally.approve + undecided < needed) return 'rejected';
  return 'pending';
}

/** How the tally reads in the vote message. */
export function tallyLine(tally: Tally, memberCount: number): string {
  const needed = threshold(memberCount);
  return (
    `✅ **${tally.approve}** approve · ❌ **${tally.reject}** reject — ` +
    `**${needed}** of ${memberCount} needed to pass`
  );
}
