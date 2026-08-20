import {beforeEach, describe, expect, it} from 'vitest';
import type {Database} from 'better-sqlite3';
import {openTestDatabase} from '../src/db/index.js';
import {
  cancelMergesFor,
  castMergeVote,
  createMerge,
  discardPlayerMergeVotes,
  finishMerge,
  getMerge,
  getPendingMergeFor,
  listExpiredMergeVotes,
  listPendingMerges,
  openAcceptVote,
  setMergeMessage,
  tallyMergeVotes,
} from '../src/db/merges.js';
import type {Merge, MergeVoteKind} from '../src/db/merges.js';

const NOW = 1_700_000_000_000;
const G = 'g1';

function offer(
  db: Database,
  fromCode = 'FR',
  intoCode = 'DE',
  offerDeadline = NOW + 1000,
): Merge {
  return createMerge(db, {
    guildId: G,
    fromCode,
    intoCode,
    proposerId: 'u1',
    offerDeadline,
    now: NOW,
  });
}

/** Casts a ballot on one stage of a merge. */
function vote(
  db: Database,
  merge: Merge,
  userId: string,
  choice: 'approve' | 'reject',
  kind: MergeVoteKind = 'offer',
): void {
  castMergeVote(db, {mergeId: merge.id, kind, userId, choice, now: NOW});
}

describe('merges repository', () => {
  let db: Database;
  beforeEach(() => {
    db = openTestDatabase();
  });

  it('opens an offer with the offering country voting first', () => {
    const merge = offer(db);
    expect(merge).toMatchObject({
      guildId: G,
      fromCode: 'FR',
      intoCode: 'DE',
      status: 'offer_vote',
      acceptDeadline: null,
      resolvedAt: null,
    });
    expect(getMerge(db, merge.id)).toEqual(merge);
  });

  it('finds a pending merge from either side', () => {
    const merge = offer(db);
    expect(getPendingMergeFor(db, G, 'FR')?.id).toBe(merge.id);
    expect(getPendingMergeFor(db, G, 'DE')?.id).toBe(merge.id);
    expect(getPendingMergeFor(db, G, 'BE')).toBeUndefined();
    expect(getPendingMergeFor(db, 'other-guild', 'FR')).toBeUndefined();
  });

  it('stops treating a settled merge as pending', () => {
    const merge = offer(db);
    finishMerge(db, merge.id, 'completed', NOW + 5);
    expect(getPendingMergeFor(db, G, 'FR')).toBeUndefined();
    expect(listPendingMerges(db, G)).toEqual([]);
    expect(getMerge(db, merge.id)).toMatchObject({
      status: 'completed',
      resolvedAt: NOW + 5,
    });
  });

  it('moves an approved offer on to the absorbing country', () => {
    const merge = offer(db);
    openAcceptVote(db, merge.id, NOW + 9000);
    expect(getMerge(db, merge.id)).toMatchObject({
      status: 'accept_vote',
      acceptDeadline: NOW + 9000,
    });
  });

  it('remembers each stage’s vote message separately', () => {
    const merge = offer(db);
    setMergeMessage(db, merge.id, 'offer', 'msg-offer');
    setMergeMessage(db, merge.id, 'accept', 'msg-accept');
    expect(getMerge(db, merge.id)).toMatchObject({
      offerMessageId: 'msg-offer',
      acceptMessageId: 'msg-accept',
    });
  });

  it('counts one ballot per voter per stage, and lets a voter change it', () => {
    const merge = offer(db);
    vote(db, merge, 'u1', 'approve');
    vote(db, merge, 'u2', 'reject');
    vote(db, merge, 'u1', 'reject');
    expect(tallyMergeVotes(db, merge.id, 'offer')).toEqual({
      approve: 0,
      reject: 2,
    });
    // The two stages are counted apart.
    expect(tallyMergeVotes(db, merge.id, 'accept')).toEqual({
      approve: 0,
      reject: 0,
    });
  });

  it('discards a departing player’s ballots on every pending merge', () => {
    const merge = offer(db);
    const settled = offer(db, 'BE', 'NL');
    vote(db, merge, 'u1', 'approve');
    vote(db, merge, 'u2', 'approve');
    vote(db, settled, 'u1', 'approve');
    finishMerge(db, settled.id, 'declined', NOW);

    discardPlayerMergeVotes(db, G, 'u1');

    expect(tallyMergeVotes(db, merge.id, 'offer')).toEqual({
      approve: 1,
      reject: 0,
    });
    // A settled merge is history and is left alone.
    expect(tallyMergeVotes(db, settled.id, 'offer')).toEqual({
      approve: 1,
      reject: 0,
    });
  });

  it('finds whichever stage’s deadline has passed', () => {
    const lapsed = offer(db, 'FR', 'DE', NOW - 1);
    const waiting = offer(db, 'BE', 'NL', NOW + 10_000);
    const answering = offer(db, 'ES', 'PT', NOW + 10_000);
    openAcceptVote(db, answering.id, NOW - 1);

    expect(listExpiredMergeVotes(db, NOW).map(merge => merge.id)).toEqual([
      lapsed.id,
      answering.id,
    ]);
    expect(
      listExpiredMergeVotes(db, NOW + 20_000).map(merge => merge.id),
    ).toContain(waiting.id);
  });

  it('calls off every merge a country is part of, and says which', () => {
    const offered = offer(db, 'FR', 'DE');
    const unrelated = offer(db, 'BE', 'NL');

    expect(cancelMergesFor(db, G, 'DE', NOW + 3).map(m => m.id)).toEqual([
      offered.id,
    ]);
    expect(getMerge(db, offered.id)).toMatchObject({
      status: 'cancelled',
      resolvedAt: NOW + 3,
    });
    expect(getMerge(db, unrelated.id)?.status).toBe('offer_vote');
  });

  it('deletes votes with their merge', () => {
    const merge = offer(db);
    vote(db, merge, 'u1', 'approve');
    db.prepare('DELETE FROM merges WHERE id = ?').run(merge.id);
    expect(db.prepare('SELECT count(*) AS n FROM merge_votes').get()).toEqual({
      n: 0,
    });
  });
});
