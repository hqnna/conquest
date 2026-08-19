import {describe, expect, it} from 'vitest';
import {readTally, tallyLine, threshold} from '../src/game/voting.js';

describe('threshold', () => {
  it('is a strict majority', () => {
    expect(threshold(1)).toBe(1);
    expect(threshold(2)).toBe(2);
    expect(threshold(3)).toBe(2);
    expect(threshold(4)).toBe(3);
    expect(threshold(5)).toBe(3);
    expect(threshold(10)).toBe(6);
  });

  it('never lets half a country decide for the whole', () => {
    for (let members = 1; members <= 50; members++) {
      expect(threshold(members) * 2).toBeGreaterThan(members);
    }
  });
});

describe('readTally', () => {
  it('passes a one-player country on its own vote', () => {
    expect(readTally({approve: 1, reject: 0}, 1)).toBe('approved');
  });

  it('waits while the outcome is still open', () => {
    expect(readTally({approve: 1, reject: 0}, 3)).toBe('pending');
    expect(readTally({approve: 0, reject: 0}, 5)).toBe('pending');
  });

  it('passes the moment approvals reach the threshold', () => {
    expect(readTally({approve: 2, reject: 0}, 3)).toBe('approved');
    expect(readTally({approve: 3, reject: 2}, 5)).toBe('approved');
  });

  it('fails as soon as the threshold has become unreachable', () => {
    expect(readTally({approve: 0, reject: 2}, 3)).toBe('rejected');
    expect(readTally({approve: 1, reject: 3}, 5)).toBe('rejected');
  });

  it('keeps waiting while the undecided could still carry it', () => {
    expect(readTally({approve: 1, reject: 2}, 5)).toBe('pending');
  });

  it('needs everyone in a two-player country', () => {
    expect(readTally({approve: 1, reject: 0}, 2)).toBe('pending');
    expect(readTally({approve: 2, reject: 0}, 2)).toBe('approved');
    expect(readTally({approve: 1, reject: 1}, 2)).toBe('rejected');
  });

  it('rejects a vote in a country that has emptied', () => {
    expect(readTally({approve: 3, reject: 0}, 0)).toBe('rejected');
  });

  it('copes when more votes exist than players, after a departure', () => {
    expect(readTally({approve: 3, reject: 0}, 2)).toBe('approved');
    expect(readTally({approve: 0, reject: 3}, 2)).toBe('rejected');
  });
});

describe('tallyLine', () => {
  it('shows both sides and the bar they must clear', () => {
    const line = tallyLine({approve: 2, reject: 1}, 5);
    expect(line).toContain('**2** approve');
    expect(line).toContain('**1** reject');
    expect(line).toContain('**3** of 5 needed');
  });
});
