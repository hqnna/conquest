import {describe, expect, it} from 'vitest';
import type {ContainerBuilder} from 'discord.js';
import type {Invasion, Stake} from '../src/db/invasions.js';
import {
  attackVoteCard,
  closedVoteCard,
  declarationCard,
  parseVoteCustomId,
  reinforceOrSurrenderCard,
  roundReportCard,
  stakeLine,
  voteButtons,
  voteCustomId,
  warReportCard,
} from '../src/discord/invasion-ui.js';
import {fightRound} from '../src/game/resolution.js';
import type {ConclusionReport, RoundReport} from '../src/game/invasions.js';

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
    attackField: stake(20, 10, 10),
    defenseField: stake(0),
    status: 'attack_vote',
    attackVoteDeadline: NOW + 1_000,
    defenseDeadline: null,
    nextTickAt: null,
    reinforcingSide: null,
    reinforceDeadline: null,
    rounds: 0,
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

describe('roundReportCard', () => {
  function round(attack: Stake, defense: Stake, rounds = 3): RoundReport {
    const tick = fightRound(attack, defense, () => 0.5);
    return {
      invasion: invasion({
        attack,
        defense,
        attackField: tick.attackerRemaining,
        defenseField: tick.defenderRemaining,
        status: 'war',
        rounds,
        nextTickAt: NOW + 5_000,
      }),
      tick,
      spentSide: tick.attackerSpent
        ? 'attacker'
        : tick.defenderSpent
          ? 'defender'
          : null,
      exhausted: false,
    };
  }

  it('numbers the round and names both sides', () => {
    const text = textOf(roundReportCard(round(stake(50), stake(40))));
    expect(text).toContain('Round 3');
    expect(text).toContain('🇫🇷 France');
    expect(text).toContain('🇩🇪 Germany');
  });

  it('shows what each side lost and what it still fields', () => {
    const text = textOf(roundReportCard(round(stake(50), stake(40))));
    expect(text).toContain('lost');
    expect(text).toContain('still fields');
    expect(text).toMatch(/\d+\.\d power/);
  });

  it('counts down to the next blow while the war goes on', () => {
    const text = textOf(roundReportCard(round(stake(50), stake(40))));
    expect(text).toMatch(/<t:\d+:R>/);
  });

  it('says a spent force fields nothing, and stops promising more rounds', () => {
    const report = round(stake(1), stake(400));
    const text = textOf(roundReportCard(report));
    expect(report.spentSide).toBe('attacker');
    expect(text).toContain('nothing');
    expect(text).not.toContain('next blow');
  });
});

describe('reinforceOrSurrenderCard', () => {
  const card = reinforceOrSurrenderCard({
    invasion: invasion({status: 'reinforcing'}),
    side: 'defender',
    deadline: NOW + 9_000,
    roleId: 'role-de',
  });

  it('pings the country whose force is gone', () => {
    expect(textOf(card)).toContain('<@&role-de>');
    expect(textOf(card)).toContain('🇩🇪 Germany');
  });

  it('offers both ways out and says which one silence is', () => {
    const text = textOf(card);
    expect(text).toContain('/reinforce');
    expect(text).toContain('/surrender');
    expect(text).toContain('Saying nothing is surrender');
    expect(text).toMatch(/<t:\d+:R>/);
  });
});

describe('warReportCard', () => {
  function conclusion(
    winner: 'attacker' | 'defender',
    reason: ConclusionReport['reason'],
    rounds = 4,
  ): ConclusionReport {
    return {
      invasion: invasion({
        attack: stake(60, 20, 20),
        defense: stake(50, 10, 10),
        status: 'war',
        rounds,
      }),
      winner,
      reason,
      attackerReturns: stake(5),
      defenderReturns: winner === 'defender' ? stake(8) : stake(0),
      captured: winner === 'attacker' ? stake(3, 2, 2) : stake(0),
      loot: winner === 'attacker' ? {food: 5, gold: 6, troops: 7} : null,
      transferredPlayers: winner === 'attacker' ? ['d1', 'd2'] : [],
      capturedTerritories: [],
      defeatedRoleId: null,
      defeatedChannelId: null,
      winnerRoleId: null,
    };
  }

  it('reports a conquest with its spoils', () => {
    const text = textOf(warReportCard(conclusion('attacker', 'surrender')));
    expect(text).toContain('has conquered');
    expect(text).toContain('gave up after 4 rounds');
    expect(text).toContain('Looted');
    expect(text).toContain('**2** players now serve');
  });

  it('reports a country fought dry rather than one that quit', () => {
    const text = textOf(warReportCard(conclusion('attacker', 'exhausted')));
    expect(text).toContain('fought dry');
  });

  it('reports a voluntary merge as the walkover it is', () => {
    const text = textOf(warReportCard(conclusion('attacker', 'unanswered', 0)));
    expect(text).toContain('never answered');
    expect(text).toContain('came home');
  });

  it('reports a defence that held, and what it cost both sides', () => {
    const text = textOf(warReportCard(conclusion('defender', 'surrender')));
    expect(text).toContain('holds against');
    expect(text).toContain('Committed in all');
    expect(text).toContain('went home to both sides');
  });

  it('singularises a one-round war', () => {
    const text = textOf(warReportCard(conclusion('defender', 'surrender', 1)));
    expect(text).toContain('1 round of fighting');
  });
});
