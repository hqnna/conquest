import {describe, expect, it} from 'vitest';
import type {ContainerBuilder} from 'discord.js';
import type {Invasion, Stake} from '../src/db/invasions.js';
import {
  attackVoteCard,
  battleReportCard,
  closedVoteCard,
  declarationCard,
  parseVoteCustomId,
  stakeLine,
  voteButtons,
  voteCustomId,
} from '../src/discord/invasion-ui.js';
import {resolveBattle} from '../src/game/resolution.js';
import type {ResolutionReport} from '../src/game/invasions.js';

const NOW = 1_700_000_000_000;

function stake(troops: number, gold = 0, food = 0): Stake {
  return {troops, gold, food};
}

function invasion(overrides: Partial<Invasion> = {}): Invasion {
  return {
    id: 7,
    guildId: 'g1',
    attackerCode: 'FR',
    defenderCode: 'DE',
    attack: stake(20, 10, 10),
    defense: null,
    status: 'attack_vote',
    attackVoteDeadline: NOW + 1_000,
    defenseDeadline: null,
    attackMessageId: null,
    createdAt: NOW,
    resolvedAt: null,
    ...overrides,
  };
}

function textOf(container: ContainerBuilder): string {
  const json = container.toJSON() as {
    components: Array<{type: number; content?: string}>;
  };
  return json.components.map(component => component.content ?? '').join('\n');
}

function buttonsOf(container: ContainerBuilder) {
  const json = container.toJSON() as {
    components: Array<{
      type: number;
      components?: Array<{
        custom_id?: string;
        disabled?: boolean;
        label?: string;
      }>;
    }>;
  };
  return json.components.flatMap(component => component.components ?? []);
}

describe('vote customIds', () => {
  it('round-trips every action', () => {
    for (const kind of ['attack', 'defense'] as const) {
      for (const choice of ['approve', 'reject'] as const) {
        const action = {invasionId: 42, kind, choice};
        expect(parseVoteCustomId(voteCustomId(action))).toEqual(action);
      }
    }
  });

  it('carries everything the click needs, so nothing is remembered', () => {
    expect(
      voteCustomId({invasionId: 7, kind: 'attack', choice: 'approve'}),
    ).toBe('vote:7:attack:approve');
  });

  it('rejects ids that are not Conquest votes', () => {
    for (const bad of [
      'help:about:1',
      'vote:7:attack',
      'vote:7:attack:approve:extra',
      'vote:abc:attack:approve',
      'vote:0:attack:approve',
      'vote:-1:attack:approve',
      'vote:7:sideways:approve',
      'vote:7:attack:maybe',
      '',
    ]) {
      expect(parseVoteCustomId(bad)).toBeUndefined();
    }
  });
});

describe('voteButtons', () => {
  it('offers approve and reject', () => {
    const buttons = (
      voteButtons(7, 'attack').toJSON().components as Array<{
        custom_id?: string;
      }>
    ).map(component => component.custom_id);
    expect(buttons).toEqual(['vote:7:attack:approve', 'vote:7:attack:reject']);
  });

  it('can be drawn dead, for a vote that is over', () => {
    const disabled = (
      voteButtons(7, 'attack', true).toJSON().components as Array<{
        disabled?: boolean;
      }>
    ).map(component => component.disabled);
    expect(disabled).toEqual([true, true]);
  });
});

describe('stakeLine', () => {
  it('always names the troops', () => {
    expect(stakeLine(stake(5))).toBe('⚔️ **5** troops');
  });

  it('mentions supplies only when some were committed', () => {
    expect(stakeLine(stake(5, 3, 0))).toContain('**3** gold');
    expect(stakeLine(stake(5, 0, 0))).not.toContain('gold');
    expect(stakeLine(stake(5, 3, 2))).toContain('**2** food');
  });
});

describe('attackVoteCard', () => {
  const card = attackVoteCard({
    invasion: invasion(),
    proposerId: 'u1',
    tally: {approve: 1, reject: 0},
    memberCount: 3,
  });

  it('names the target, the stake, and the deadline', () => {
    const text = textOf(card);
    expect(text).toContain('🇩🇪 Germany');
    expect(text).toContain('**20** troops');
    expect(text).toMatch(/<t:\d+:R>/);
  });

  it('shows the tally against the bar it must clear', () => {
    expect(textOf(card)).toContain('**2** of 3 needed');
  });

  it('warns that approving commits the stake', () => {
    expect(textOf(card)).toContain('leaves the stockpile');
  });

  it('carries live buttons', () => {
    expect(buttonsOf(card).every(button => button.disabled)).toBe(false);
  });
});

describe('closedVoteCard', () => {
  it('kills the buttons', () => {
    const card = closedVoteCard({
      invasionId: 7,
      kind: 'attack',
      heading: 'Done',
      detail: 'Over.',
      approved: true,
    });
    expect(buttonsOf(card).every(button => button.disabled)).toBe(true);
  });
});

describe('declarationCard', () => {
  it('publishes the stake, because big stakes are the drama', () => {
    const text = textOf(declarationCard(invasion(), NOW + 5_000));
    expect(text).toContain('🇫🇷 France');
    expect(text).toContain('🇩🇪 Germany');
    expect(text).toContain('**20** troops');
    expect(text).toContain('**10** gold');
  });
});

describe('battleReportCard', () => {
  function report(attack: Stake, defense: Stake): ResolutionReport {
    const outcome = resolveBattle(attack, defense, {attacker: 1, defender: 1});
    return {
      invasion: invasion({attack, defense, status: 'defense_window'}),
      outcome,
      defense,
      loot: outcome.attackerWins ? {food: 5, gold: 6, troops: 7} : null,
      transferredPlayers: outcome.attackerWins ? ['d1', 'd2'] : [],
      capturedTerritories: [],
      defeatedRoleId: null,
      defeatedChannelId: null,
      winnerRoleId: null,
    };
  }

  it('reports a conquest with its spoils', () => {
    const text = textOf(battleReportCard(report(stake(50), stake(1))));
    expect(text).toContain('has conquered');
    expect(text).toContain('Looted');
    expect(text).toContain('**2** players now serve');
  });

  it('reports a repelled invasion with the captured haul', () => {
    const text = textOf(battleReportCard(report(stake(5, 4, 4), stake(50))));
    expect(text).toContain('holds against');
    expect(text).toContain('captured the entire invading force');
    expect(text).toContain('**5** troops');
    expect(text).toContain('**4** gold');
  });

  it('says plainly when nobody turned up to defend', () => {
    const text = textOf(battleReportCard(report(stake(10), stake(0))));
    expect(text).toContain('no defence at all');
  });

  it('shows both sides of the arithmetic', () => {
    const text = textOf(battleReportCard(report(stake(50), stake(1))));
    expect(text).toMatch(/\d+\.\d power/);
  });
});
