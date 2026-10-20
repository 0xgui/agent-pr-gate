import { describe, expect, it } from 'vitest';
import { approvalsFor, countRounds, ReviewLite, timeToFirstHumanReview } from '../src/reviews';

const rv = (user: string, state: string, at: string, commitId = 'head', extra: Partial<ReviewLite> = {}): ReviewLite => ({
  user,
  state,
  submittedAt: at,
  isBot: /\[bot\]$/.test(user),
  commitId,
  association: 'COLLABORATOR',
  ...extra,
});

describe('round counting (by reviewed commit, no timestamps)', () => {
  const base = { headSha: 'head', author: 'agent', trustedAssociations: ['OWNER', 'MEMBER', 'COLLABORATOR'] };

  it('counts a changes-requested review followed by a new head as one round', () => {
    const r = countRounds([rv('alice', 'CHANGES_REQUESTED', '2026-01-01T10:00:00Z', 'a')], base);
    expect(r.rounds).toBe(1);
    expect(r.openedBy[0]).toEqual({ user: 'alice', at: '2026-01-01T10:00:00Z', commit: 'a' });
  });

  it('does not count a review on the current head yet', () => {
    expect(countRounds([rv('alice', 'CHANGES_REQUESTED', '2026-01-01T10:00:00Z', 'head')], base).rounds).toBe(0);
  });

  it('merges several reviews on the same commit into one round', () => {
    const reviews = [rv('alice', 'CHANGES_REQUESTED', '2026-01-01T10:00:00Z', 'a'), rv('bob', 'CHANGES_REQUESTED', '2026-01-01T10:30:00Z', 'a')];
    expect(countRounds(reviews, base).rounds).toBe(1);
  });

  it('counts three cycles by trusted humans', () => {
    const reviews = [
      rv('alice', 'CHANGES_REQUESTED', '2026-01-01T10:00:00Z', 'a'),
      rv('bob', 'CHANGES_REQUESTED', '2026-01-01T12:00:00Z', 'b'),
      rv('alice', 'CHANGES_REQUESTED', '2026-01-01T14:00:00Z', 'c'),
    ];
    expect(countRounds(reviews, base).rounds).toBe(3);
  });

  it('R2: needs no push timestamps, so spoofed check suites or commit dates change nothing', () => {
    expect(countRounds([rv('alice', 'CHANGES_REQUESTED', '2026-01-03T10:00:00Z', 'old')], base).rounds).toBe(1);
  });

  it('R2: scratch-branch work (several pushes, no reviews in between) is one round', () => {
    // Reviewed a, then the author pushed scratch commits s1, s2 and finally head.
    expect(countRounds([rv('alice', 'CHANGES_REQUESTED', '2026-01-01T10:00:00Z', 'a')], base).rounds).toBe(1);
  });

  it('R2: force-pushing back to the reviewed commit does not erase a round that a later review proves', () => {
    const reviews = [rv('alice', 'CHANGES_REQUESTED', '2026-01-01T10:00:00Z', 'head'), rv('bob', 'COMMENTED', '2026-01-01T11:00:00Z', 'b')];
    // Reviewed "head", moved to b (bob reviewed b), then force-pushed back to "head".
    expect(countRounds(reviews, base).rounds).toBe(1);
    // With no later review on another commit there is no evidence the head moved: not counted.
    expect(countRounds([reviews[0]!], base).rounds).toBe(0);
  });

  it('nit: only a later review from a trusted human proves the head moved', () => {
    const first = rv('alice', 'CHANGES_REQUESTED', '2026-01-01T10:00:00Z', 'head');
    expect(countRounds([first, rv('review-bot[bot]', 'COMMENTED', '2026-01-01T11:00:00Z', 'b')], base).rounds).toBe(0);
    expect(countRounds([first, rv('stranger', 'COMMENTED', '2026-01-01T11:00:00Z', 'b', { association: 'NONE' })], base).rounds).toBe(0);
    expect(countRounds([first, rv('bob', 'COMMENTED', '2026-01-01T11:00:00Z', 'b')], base).rounds).toBe(1);
  });

  it('#15: a later review by the PR author does not prove the head moved', () => {
    const first = rv('alice', 'CHANGES_REQUESTED', '2026-01-01T10:00:00Z', 'head');
    expect(countRounds([first, rv('agent', 'COMMENTED', '2026-01-01T11:00:00Z', 'b')], base).rounds).toBe(0);
    expect(countRounds([first, rv('AGENT', 'COMMENTED', '2026-01-01T11:00:00Z', 'b')], base).rounds).toBe(0);
  });

  it('R3: dismissed changes-requested reviews count; dismissed approvals and unknown originals do not', () => {
    const reviews = [
      rv('alice', 'DISMISSED', '2026-01-01T10:00:00Z', 'a', { id: 1 }),
      rv('alice', 'DISMISSED', '2026-01-01T11:00:00Z', 'b', { id: 2 }),
      rv('alice', 'DISMISSED', '2026-01-01T12:00:00Z', 'c', { id: 3 }),
    ];
    const dismissedOriginal = new Map([
      [1, 'changes_requested'],
      [2, 'approved'],
    ]);
    expect(countRounds(reviews, { ...base, dismissedOriginal }).rounds).toBe(1);
    expect(countRounds(reviews, base).rounds).toBe(0);
  });

  it('A2: COMMENTED is not counted by default, and bots and untrusted reviewers never count', () => {
    const reviews = [
      rv('carol', 'COMMENTED', '2026-01-01T09:00:00Z', 'z'),
      rv('review-bot[bot]', 'CHANGES_REQUESTED', '2026-01-01T10:00:00Z', 'a'),
      rv('stranger', 'CHANGES_REQUESTED', '2026-01-01T11:00:00Z', 'b', { association: 'NONE' }),
      rv('agent', 'CHANGES_REQUESTED', '2026-01-01T12:00:00Z', 'c'),
    ];
    expect(countRounds(reviews, base).rounds).toBe(0);
    expect(countRounds(reviews, { ...base, states: ['CHANGES_REQUESTED', 'COMMENTED'] }).rounds).toBe(1);
  });
});

describe('approvals', () => {
  const opts = { headSha: 'head', trustedAssociations: ['OWNER', 'MEMBER', 'COLLABORATOR'] };

  it('uses each human reviewer latest decision and skips bots and the author', () => {
    const reviews = [
      rv('alice', 'CHANGES_REQUESTED', '2026-01-01T10:00:00Z'),
      rv('alice', 'APPROVED', '2026-01-01T12:00:00Z'),
      rv('alice', 'COMMENTED', '2026-01-01T13:00:00Z'),
      rv('bob', 'APPROVED', '2026-01-01T10:00:00Z'),
      rv('bob', 'DISMISSED', '2026-01-01T11:00:00Z'),
      rv('ci-bot[bot]', 'APPROVED', '2026-01-01T10:00:00Z'),
      rv('agent', 'APPROVED', '2026-01-01T10:00:00Z'),
    ];
    expect(approvalsFor(reviews, 'agent', opts).approvers).toEqual(['alice']);
  });

  it('regression: approvals on an older commit are stale unless allowed', () => {
    const reviews = [rv('alice', 'APPROVED', '2026-01-01T10:00:00Z', 'old')];
    expect(approvalsFor(reviews, 'agent', opts)).toEqual({ approvers: [], stale: ['alice'], untrusted: [] });
    expect(approvalsFor(reviews, 'agent', { ...opts, allowStale: true }).approvers).toEqual(['alice']);
  });

  it('regression: approvals from people without repo access do not count', () => {
    const reviews = [
      rv('drive-by', 'APPROVED', '2026-01-01T10:00:00Z', 'head', { association: 'CONTRIBUTOR' }),
      rv('stranger', 'APPROVED', '2026-01-01T10:00:00Z', 'head', { association: 'NONE' }),
      rv('owner', 'APPROVED', '2026-01-01T10:00:00Z', 'head', { association: 'OWNER' }),
    ];
    expect(approvalsFor(reviews, 'agent', opts)).toEqual({ approvers: ['owner'], stale: [], untrusted: ['drive-by', 'stranger'] });
  });

  it('measures time to the first human review', () => {
    const reviews = [rv('ci-bot[bot]', 'COMMENTED', '2026-01-01T09:05:00Z'), rv('alice', 'COMMENTED', '2026-01-01T10:30:00Z')];
    expect(timeToFirstHumanReview('2026-01-01T09:00:00Z', reviews, 'agent')).toBe(90 * 60 * 1000);
    expect(timeToFirstHumanReview('2026-01-01T09:00:00Z', [], 'agent')).toBeNull();
  });
});

describe('#16: dismissed reviews when the timeline is unreadable (fail closed)', () => {
  const base = { headSha: 'head', author: 'agent', trustedAssociations: ['OWNER', 'MEMBER', 'COLLABORATOR'] };
  const dismissed = rv('alice', 'DISMISSED', '2026-01-01T10:00:00Z', 'a', { id: 1 });
  it('marks rounds unknown when a trusted dismissed review cannot be resolved', () => {
    expect(countRounds([dismissed], { ...base, dismissedOriginal: null }).unknown).toBe(true);
  });
  it('#31: a dismissed review on the current head with no later move cannot be a round, so rounds stay known', () => {
    const onHead = rv('alice', 'DISMISSED', '2026-01-01T10:00:00Z', 'head', { id: 5 });
    expect(countRounds([onHead], { ...base, dismissedOriginal: null }).unknown).toBeFalsy();
    const movedLater = [onHead, rv('bob', 'COMMENTED', '2026-01-01T11:00:00Z', 'other', { id: 6 })];
    expect(countRounds(movedLater, { ...base, dismissedOriginal: null }).unknown).toBe(true);
  });
  it('stays known when the timeline was read, or when no dismissed review could count', () => {
    expect(countRounds([dismissed], { ...base, dismissedOriginal: new Map() }).unknown).toBeFalsy();
    expect(countRounds([rv('alice', 'CHANGES_REQUESTED', '2026-01-01T10:00:00Z', 'a')], { ...base, dismissedOriginal: null }).unknown).toBeFalsy();
    const ignored = [rv('ci[bot]', 'DISMISSED', '2026-01-01T10:00:00Z', 'a', { id: 2, isBot: true }), rv('agent', 'DISMISSED', '2026-01-01T10:00:00Z', 'a', { id: 3 }), rv('x', 'DISMISSED', '2026-01-01T10:00:00Z', 'a', { id: 4, association: 'NONE' })];
    expect(countRounds(ignored, { ...base, dismissedOriginal: null }).unknown).toBeFalsy();
  });
});
