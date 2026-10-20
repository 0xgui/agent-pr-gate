import { describe, expect, it } from 'vitest';
import { EVALUATION_CALLS, evaluationReserve, FINGERPRINT_CALLS, isDue, onceByKey, planSweep, positiveInt, rateLimitLow, runEach, STATE_READ_CALLS, sweepReserve } from '../src/sweep';
import { fingerprint, parseState, renderState } from '../src/state';

describe('R6 scheduled sweep', () => {
  const now = new Date('2026-01-01T12:00:00Z');
  const opts = { maxPrs: 20, maxAgeMs: 6 * 3600_000, now };
  const st = (evaluatedAt: string, fp: string) => ({ v: 1 as const, evaluatedAt, fingerprint: fp });

  it('R1: 25 stuck PRs do not starve 1 changed PR', async () => {
    // 25 PRs blocked and unchanged, evaluated 1h ago (oldest first); 1 PR changed, evaluated 30m ago.
    const stuck = Array.from({ length: 25 }, (_, i) => ({ number: i + 1, stored: st(`2026-01-01T10:${String(i).padStart(2, '0')}:00Z`, 'same') }));
    const changed = { number: 99, stored: st('2026-01-01T11:30:00Z', 'old') };
    const plan = await planSweep([...stuck, changed], async (n) => (n === 99 ? 'new' : 'same'), { ...opts, maxPrs: 5 });
    expect(plan.run).toEqual([99]);
    expect(plan.skipped).toHaveLength(25);
  });

  it('R2: re-checks unchanged PRs after the max age, oldest evaluation first, capped', async () => {
    const cands = [
      { number: 1, stored: st('2026-01-01T05:00:00Z', 'fp') }, // 7h old: due
      { number: 2, stored: st('2026-01-01T04:00:00Z', 'fp') }, // 8h old: due, older
      { number: 3, stored: st('2026-01-01T11:00:00Z', 'fp') }, // fresh: skip
      { number: 4, stored: null }, // never evaluated: first
    ];
    const plan = await planSweep(cands, async () => 'fp', { ...opts, maxPrs: 2 });
    expect(plan.run).toEqual([4, 2]);
    expect(plan.deferred).toEqual([1, 3]);
  });

  it('R2: a CI change alone changes the fingerprint', () => {
    const inputs = { headSha: 'h', baseSha: 'b', body: '', draft: false, reviews: [] };
    const pending = fingerprint(inputs, { state: 'pending', failing: [], pending: ['test'] });
    const green = fingerprint(inputs, { state: 'green', failing: [], pending: [] });
    expect(pending).not.toBe(green);
    expect(isDue(st('2026-01-01T11:59:00Z', pending), green, opts)).toBe(true);
  });

  it('R3: planning stops at max-prs due PRs, on a low rate limit, and survives a failed lookup', async () => {
    const cands = Array.from({ length: 10 }, (_, i) => ({ number: i + 1, stored: null }));
    let lookups = 0;
    const capped = await planSweep(cands, async () => {
      lookups++;
      return 'x';
    }, { ...opts, maxPrs: 3 });
    expect(capped.run).toEqual([1, 2, 3]);
    expect(lookups).toBe(3);

    let budget = 3;
    const stopped = await planSweep(cands, async () => 'x', opts, async () => (budget-- > 0 ? null : 'rate limit low'));
    expect(stopped.run).toEqual([1, 2, 3]);
    expect(stopped.stoppedEarly).toBe('rate limit low');

    const errs: number[] = [];
    const faulty = await planSweep(cands.slice(0, 3), async (n) => {
      if (n === 2) throw new Error('boom');
      return 'x';
    }, opts, undefined, (n) => errs.push(n));
    expect(faulty).toMatchObject({ run: [1, 3], failed: [2] });
    expect(errs).toEqual([2]);
  });

  it('stored state survives a round trip through the comment and rejects garbage', () => {
    const s = st('2026-01-01T10:00:00Z', 'abc123');
    expect(parseState(`<!-- agent-pr-gate:report -->\n${renderState(s)}\n## body`)).toEqual(s);
    expect(parseState('<!-- agent-pr-gate:state {"v":1,"evaluatedAt":"nope","fingerprint":"x"} -->')).toBeNull();
    expect(parseState('no state')).toBeNull();
  });

  it('keeps going when one PR fails, and stops gracefully when the rate limit is low', async () => {
    const errors: string[] = [];
    const notices: string[] = [];
    const log = { error: (m: string) => errors.push(m), notice: (m: string) => notices.push(m) };
    const res = await runEach([1, 2, 3], async (n) => {
      if (n === 2) throw new Error('boom');
      return 'pass';
    }, log);
    expect([...res.outcomes.entries()]).toEqual([[1, 'pass'], [2, 'error'], [3, 'pass']]);
    expect(errors).toEqual(['PR #2: boom']);

    let remaining = 250;
    const stopped = await runEach([1, 2, 3], async () => {
      remaining -= 60;
      return 'blocked';
    }, log, async () => (rateLimitLow(remaining, 200) ? `rate limit low (${remaining})` : null));
    expect(stopped.outcomes.size).toBe(1);
    expect(stopped.stoppedEarly).toBe('rate limit low (190)');
    expect(notices[0]).toMatch(/Stopping early.*2 PR\(s\) left/);
  });

  it('looks up reverts once per key for the whole run', async () => {
    let calls = 0;
    const get = onceByKey(async (k) => {
      calls++;
      return k.length;
    });
    await Promise.all([get('main\n30'), get('main\n30'), get('main\n30')]);
    expect(calls).toBe(1);
    await get('dev\n30');
    expect(calls).toBe(2);
  });
});

describe('#10: a future evaluatedAt', () => {
  const now = new Date('2026-01-01T12:00:00Z');
  const opts = { maxPrs: 20, maxAgeMs: 6 * 3600_000, now };
  const at = (evaluatedAt: string) => ({ v: 1 as const, evaluatedAt, fingerprint: 'fp' });
  it('is due, so it cannot suppress the max-age backstop', () => {
    expect(isDue(at('2026-01-01T13:00:00Z'), 'fp', opts)).toBe(true);
    expect(isDue(at('2099-01-01T00:00:00Z'), 'fp', opts)).toBe(true);
    expect(isDue(at('2026-01-01T11:00:00Z'), 'fp', opts)).toBe(false);
  });
  it('allows a minute of clock skew', () => {
    expect(isDue(at('2026-01-01T12:00:30Z'), 'fp', opts)).toBe(false);
  });
  it('is visited first, with the never-evaluated PRs', async () => {
    const cands = [
      { number: 1, stored: at('2026-01-01T11:00:00Z') },
      { number: 2, stored: at('2099-01-01T00:00:00Z') },
      { number: 3, stored: null },
    ];
    const plan = await planSweep(cands, async () => 'fp', { ...opts, maxPrs: 2 });
    expect(plan.run).toEqual([2, 3]);
  });
});

describe('#13: rate budget is reserved for evaluations', () => {
  it('counts the reserve against the remaining budget', () => {
    expect(rateLimitLow(300, 200)).toBe(false);
    expect(rateLimitLow(300, 200, 50)).toBe(false);
    expect(rateLimitLow(300, 200, 101)).toBe(true);
    expect(evaluationReserve(3)).toBe(3 * EVALUATION_CALLS);
  });
  it('stops fingerprinting once the budget only covers the PRs already planned', async () => {
    let remaining = 200 + 2 * EVALUATION_CALLS + 10;
    const cands = Array.from({ length: 6 }, (_, i) => ({ number: i + 1, stored: null }));
    const plan = await planSweep(
      cands,
      async () => ((remaining -= 5), 'fp'),
      { maxPrs: 6, maxAgeMs: 6 * 3600_000, now: new Date('2026-01-01T12:00:00Z') },
      async (planned) => (rateLimitLow(remaining, 200, evaluationReserve(planned + 1)) ? 'low' : null),
    );
    expect(plan.run).toEqual([1, 2]);
    expect(plan.stoppedEarly).toBe('low');
    expect(remaining - 200).toBeGreaterThanOrEqual(evaluationReserve(plan.run.length));
  });
});

describe('#28 and #29: sweep reserve and max-prs', () => {
  it('reserves the next state read, fingerprints and evaluations', () => {
    expect(sweepReserve({ stateReads: 1, fingerprints: 2, evaluations: 3 })).toBe(STATE_READ_CALLS + 2 * FINGERPRINT_CALLS + 3 * EVALUATION_CALLS);
    expect(sweepReserve({})).toBe(0);
    // #34: state reads and fingerprints cost one call per page seen so far.
    expect(sweepReserve({ stateReads: 1, fingerprints: 2, evaluations: 0, pages: 3 })).toBe(3 * (STATE_READ_CALLS + 2 * FINGERPRINT_CALLS));
  });
  it('parses max-prs as a positive integer, falling back to 20', () => {
    expect(positiveInt('5', 20)).toBe(5);
    for (const bad of ['', 'twenty', '0', '-3', '2.5', 'NaN', 'Infinity']) expect(positiveInt(bad, 20)).toBe(20);
    // #33: only plain decimal integers.
    for (const bad of ['1e3', '0x10', '01', '+5', '5 0']) expect(positiveInt(bad, 20)).toBe(20);
    expect(positiveInt(' 7 ', 20)).toBe(7);
  });
});

describe('#27 and #32: pending flags in the state marker', () => {
  const opts = { maxAgeMs: 6 * 3600_000, now: new Date('2026-01-01T12:01:00Z') };
  const st = { v: 1 as const, evaluatedAt: '2026-01-01T12:00:00Z', fingerprint: 'fp' };
  it('round-trips the flags, and isDue honours them', () => {
    for (const flag of ['statusPending', 'roundsUnknown'] as const) {
      const parsed = parseState(renderState({ ...st, [flag]: true }));
      expect(parsed).toEqual({ ...st, [flag]: true });
      expect(isDue(parsed, 'fp', opts)).toBe(true);
    }
    expect(parseState(renderState(st))).toEqual(st);
    expect(isDue(st, 'fp', opts)).toBe(false);
  });
  it('keeps sweep order fair: a pending PR keeps its real time and does not jump the queue', async () => {
    const cands = [
      { number: 1, stored: { ...st, evaluatedAt: '2026-01-01T11:00:00Z', statusPending: true as const } },
      { number: 2, stored: { ...st, evaluatedAt: '2026-01-01T05:00:00Z' } },
    ];
    const plan = await planSweep(cands, async () => 'fp', { ...opts, maxPrs: 1 });
    expect(plan.run).toEqual([2]);
  });
});
