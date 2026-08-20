import {describe, expect, it} from 'vitest';
import type {Merge} from '../src/db/merges.js';
import {
  acceptVoteCard,
  closedMergeCard,
  dowryLine,
  isMergeComponent,
  mergeAnnouncementCard,
  mergeVoteButtons,
  mergeVoteCustomId,
  offerCarriedCard,
  offerVoteCard,
  parseMergeVoteCustomId,
} from '../src/discord/merge-ui.js';
import type {MergeReport} from '../src/game/merges.js';

const NOW = 1_700_000_000_000;

const merge: Merge = {
  id: 12,
  guildId: 'g1',
  fromCode: 'FR',
  intoCode: 'DE',
  proposerId: 'u1',
  status: 'offer_vote',
  offerDeadline: NOW + 60_000,
  acceptDeadline: null,
  offerMessageId: null,
  acceptMessageId: null,
  createdAt: NOW,
  resolvedAt: null,
};

/** The buttons in one action row, without the API type gymnastics. */
function buttonsOf(row: {toJSON(): unknown}) {
  return (
    row.toJSON() as {
      components: Array<{custom_id?: string; disabled?: boolean}>;
    }
  ).components;
}

/** Every piece of text in a card, however deeply it is nested. */
function text(card: {toJSON(): unknown}): string {
  return JSON.stringify(card.toJSON());
}

describe('merge vote customIds', () => {
  it('round-trips every side and choice', () => {
    for (const kind of ['offer', 'accept'] as const) {
      for (const choice of ['approve', 'reject'] as const) {
        const action = {mergeId: 3, kind, choice};
        expect(parseMergeVoteCustomId(mergeVoteCustomId(action))).toEqual(
          action,
        );
      }
    }
  });

  it('recognises its own components and nobody else’s', () => {
    expect(isMergeComponent('merge:3:offer:approve')).toBe(true);
    expect(isMergeComponent('vote:3:attack:approve')).toBe(false);
    expect(isMergeComponent('help:rules:0')).toBe(false);
  });

  it('refuses ids it did not write', () => {
    for (const id of [
      'vote:3:attack:approve',
      'merge:3:offer',
      'merge:3:offer:approve:extra',
      'merge:0:offer:approve',
      'merge:-1:offer:approve',
      'merge:abc:offer:approve',
      'merge:3:sideways:approve',
      'merge:3:offer:maybe',
    ]) {
      expect(parseMergeVoteCustomId(id)).toBeUndefined();
    }
  });

  it('builds live buttons, and dead ones for a closed vote', () => {
    const live = buttonsOf(mergeVoteButtons(3, 'offer'));
    expect(live.map(button => button.custom_id)).toEqual([
      'merge:3:offer:approve',
      'merge:3:offer:reject',
    ]);
    expect(live.every(button => button.disabled)).toBe(false);
    expect(
      buttonsOf(mergeVoteButtons(3, 'accept', true)).every(
        button => button.disabled,
      ),
    ).toBe(true);
  });
});

describe('merge cards', () => {
  it('tells the offering country what approving costs them', () => {
    const card = text(
      offerVoteCard({merge, tally: {approve: 1, reject: 0}, memberCount: 3}),
    );
    expect(card).toContain('France');
    expect(card).toContain('Germany');
    expect(card).toContain('<@u1>');
    expect(card).toContain('2** of 3 needed to pass');
    expect(card).toContain('merge:12:offer:approve');
  });

  it('shows the absorbing country what it is being offered', () => {
    const card = text(
      acceptVoteCard({
        merge: {...merge, status: 'accept_vote', acceptDeadline: NOW + 90_000},
        tally: {approve: 0, reject: 0},
        memberCount: 2,
        offeredMembers: 4,
        offeredTerritories: 3,
        offeredStockpile: {troops: 30, gold: 20, food: 10},
        roleId: 'role-DE',
      }),
    );
    expect(card).toContain('<@&role-DE>');
    expect(card).toContain('4 players');
    expect(card).toContain('3 territories');
    expect(card).toContain('30 troops');
    expect(card).toContain('merge:12:accept:reject');
  });

  it('warns that a big country joining a small one takes it over', () => {
    const card = text(
      acceptVoteCard({
        merge,
        tally: {approve: 0, reject: 0},
        memberCount: 1,
        offeredMembers: 9,
        offeredTerritories: 1,
        offeredStockpile: {troops: 0, gold: 0, food: 0},
        roleId: null,
      }),
    );
    expect(card).toContain('changes who decides things here');
  });

  it('renders singulars for a country of one', () => {
    expect(
      dowryLine({
        members: 1,
        territories: 1,
        stockpile: {troops: 1, gold: 0, food: 0},
      }),
    ).toContain('1 player · 1 territory');
  });

  it('closes a vote with its buttons dead', () => {
    const card = closedMergeCard({
      mergeId: 12,
      kind: 'offer',
      heading: 'The offer was voted down',
      detail: 'Nothing was moved.',
      approved: false,
    }).toJSON();
    const buttons = JSON.stringify(card);
    expect(buttons).toContain('The offer was voted down');
    expect(buttons).toContain('"disabled":true');
  });

  it('tells the offering country their answer is pending', () => {
    expect(
      text(offerCarriedCard({...merge, acceptDeadline: NOW + 90_000})),
    ).toContain('Germany');
  });

  it('announces the union with what moved', () => {
    const report = {
      merge,
      stockpile: {troops: 30, gold: 20, food: 10},
      transferredPlayers: ['f1', 'f2'],
      capturedTerritories: [{code: 'FR'}, {code: 'BE'}],
      absorbedRoleId: 'role-FR',
      absorbedChannelId: 'chan-FR',
      absorberRoleId: 'role-DE',
    } as unknown as MergeReport;
    const card = text(mergeAnnouncementCard(report));
    expect(card).toContain('France');
    expect(card).toContain('has joined');
    expect(card).toContain('**Territories gained:** 2');
    expect(card).toContain('**Players moved:** 2');
  });
});
