import { describe, expect, it } from 'vitest';
import { ciWaitFor, evaluateUntilStable, stateAfterStatus, statusState, statusWriteNeeded, stepShouldFail, tryWrite } from '../src/writes';
import { GateState, inputsKey, toPrInputs } from '../src/state';
import { isDue } from '../src/sweep';

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

describe('N3 writes are non-fatal on a read-only token', () => {
  it('logs and returns null on 403 so the gate can still report', async () => {
    const warnings: string[] = [];
    const res = await tryWrite('setting the label', () => Promise.reject(httpError(403)), { warning: (m) => warnings.push(m) });
    expect(res).toBeNull();
    expect(warnings[0]).toMatch(/Skipped setting the label.*HTTP 403.*Branch protection must enforce reviews/);
  });
  it('also tolerates 404, returns the value on success, and rethrows other errors', async () => {
    const log = { warning: () => undefined };
    expect(await tryWrite('x', () => Promise.reject(httpError(404)), log)).toBeNull();
    expect(await tryWrite('x', () => Promise.resolve(42), log)).toBe(42);
    await expect(tryWrite('x', () => Promise.reject(httpError(500)), log)).rejects.toThrow('HTTP 500');
  });
});

describe('R4 stability: compare real inputs, retry, then give up as stale', () => {
  const base = { headSha: 'h1', baseSha: 'b1', body: 'body', draft: false, reviews: [{ id: 1, state: 'COMMENTED' }] };

  it('the inputs key ignores comments and labels, but sees head, body, base, draft and reviews', () => {
    const k = inputsKey(base);
    // Comment spam or labels are not inputs: nothing in PrInputs changes, so the key is equal.
    expect(inputsKey({ ...base, reviews: [...base.reviews] })).toBe(k);
    expect(inputsKey({ ...base, headSha: 'h2' })).not.toBe(k);
    expect(inputsKey({ ...base, body: 'edited' })).not.toBe(k);
    expect(inputsKey({ ...base, baseSha: 'b2' })).not.toBe(k);
    expect(inputsKey({ ...base, draft: true })).not.toBe(k);
    expect(inputsKey({ ...base, reviews: [{ id: 1, state: 'DISMISSED' }] })).not.toBe(k);
    expect(inputsKey({ ...base, reviews: [...base.reviews, { id: 2, state: 'APPROVED' }] })).not.toBe(k);
  });

  it('writes on the first attempt when inputs are unchanged (comment spam does not make it stale)', async () => {
    let evals = 0;
    const res = await evaluateUntilStable(async () => ({ key: 'k', n: ++evals }), (v) => v.key, async () => 'k');
    expect(res).toEqual({ stale: false, value: { key: 'k', n: 1 }, attempts: 1 });
  });

  it('re-evaluates when inputs changed, and accepts once they settle', async () => {
    const keys = ['k1', 'k2', 'k2'];
    let evals = 0;
    const res = await evaluateUntilStable(async () => ({ key: keys[evals++]! }), (v) => v.key, async () => 'k2');
    expect(res).toMatchObject({ stale: false, attempts: 2 });
  });

  it('gives up as stale after 2 retries if inputs keep changing', async () => {
    let evals = 0;
    let n = 0;
    const res = await evaluateUntilStable(async () => ({ key: `e${evals++}` }), (v) => v.key, async () => `c${n++}`);
    expect(res).toMatchObject({ stale: true, attempts: 3 });
    expect(evals).toBe(3);
  });

  it('stops when the PR closed', async () => {
    expect(await evaluateUntilStable(async () => null, () => '', async () => 'k')).toBeNull();
    expect(await evaluateUntilStable(async () => ({ key: 'k' }), (v) => v.key, async () => null)).toMatchObject({ stale: true, reason: 'PR is no longer open' });
  });
});

describe('R5 commit status writes are deduplicated and a 422 is tolerated', () => {
  it('writes only when state or description changes', () => {
    expect(statusWriteNeeded(null, { state: 'success', description: 'ok' })).toBe(true);
    expect(statusWriteNeeded({ state: 'success', description: 'ok' }, { state: 'success', description: 'ok' })).toBe(false);
    expect(statusWriteNeeded({ state: 'failure', description: 'ok' }, { state: 'success', description: 'ok' })).toBe(true);
    expect(statusWriteNeeded({ state: 'success', description: 'old' }, { state: 'success', description: 'ok' })).toBe(true);
  });
  it('tolerates 422 (status limit) only when asked', async () => {
    const warnings: string[] = [];
    const log = { warning: (m: string) => warnings.push(m) };
    expect(await tryWrite('setting the status', () => Promise.reject(httpError(422)), log, [403, 404, 422])).toBeNull();
    expect(warnings[0]).toMatch(/HTTP 422/);
    await expect(tryWrite('x', () => Promise.reject(httpError(422)), log)).rejects.toThrow('HTTP 422');
  });
});

describe('E stale runs are neutral', () => {
  it('writes no commit status for a stale run and does not fail the step', () => {
    expect(statusState('stale')).toBeNull();
    expect(statusState('pass')).toBe('success');
    expect(statusState('blocked')).toBe('failure');
    expect(stepShouldFail(['stale'], true)).toBe(false);
    expect(stepShouldFail(['pass', 'stale'], true)).toBe(false);
    expect(stepShouldFail(['pass', 'blocked'], true)).toBe(true);
    expect(stepShouldFail(['blocked'], false)).toBe(false);
  });
});

describe('#14 stability: trusted reviews only, CI waited for once', () => {
  const pr = { headSha: 'h', baseSha: 'b', body: 'x', draft: false };
  const trusted = ['OWNER', 'MEMBER', 'COLLABORATOR'];
  const rv = (id: number, user: string, association: string, isBot = false) => ({ id, user, state: 'COMMENTED', isBot, association });
  const key = (reviews: ReturnType<typeof rv>[]) => inputsKey(toPrInputs(pr, reviews, { author: 'agent', trustedAssociations: trusted }));

  it('an untrusted, bot or author review does not change the inputs key', () => {
    const k = key([rv(1, 'alice', 'MEMBER')]);
    expect(key([rv(1, 'alice', 'MEMBER'), rv(2, 'stranger', 'NONE')])).toBe(k);
    expect(key([rv(1, 'alice', 'MEMBER'), rv(3, 'ci[bot]', 'MEMBER', true)])).toBe(k);
    expect(key([rv(1, 'alice', 'MEMBER'), rv(4, 'Agent', 'OWNER')])).toBe(k);
    expect(key([rv(1, 'alice', 'MEMBER'), rv(5, 'bob', 'COLLABORATOR')])).not.toBe(k);
  });
  it('an empty trusted list trusts every non-bot reviewer, as the approval logic does', () => {
    const k = (reviews: ReturnType<typeof rv>[]) => inputsKey(toPrInputs(pr, reviews, { author: 'agent', trustedAssociations: [] }));
    expect(k([rv(2, 'stranger', 'NONE')])).not.toBe(k([]));
  });
  it('an untrusted review during evaluation does not cause a retry', async () => {
    let evals = 0;
    const res = await evaluateUntilStable(
      async () => ({ key: key([rv(1, 'alice', 'MEMBER')]), n: ++evals }),
      (v) => v.key,
      async () => key([rv(1, 'alice', 'MEMBER'), rv(2, 'stranger', 'NONE')]),
    );
    expect(res).toMatchObject({ stale: false, attempts: 1 });
    expect(evals).toBe(1);
  });
  it('tells each evaluation its attempt number, so only the first one waits for CI', async () => {
    const attempts: number[] = [];
    let n = 0;
    await evaluateUntilStable(async (attempt) => (attempts.push(attempt), { key: `e${n}` }), (v) => v.key, async () => `c${n++}`);
    expect(attempts).toEqual([1, 2, 3]);
    expect(attempts.map(ciWaitFor(120))).toEqual([120, 0, 0]);
  });
  it('re-reads the current key with the evaluation it checks, so it can filter with that config', async () => {
    const seen: unknown[] = [];
    await evaluateUntilStable(async () => ({ key: 'k', cfg: 'c' }), (v) => v.key, async (v) => (seen.push(v.cfg), 'k'));
    expect(seen).toEqual(['c']);
  });
});

describe('#12 the state marker is only trusted once the status is in place', () => {
  const st: GateState = { v: 1, evaluatedAt: '2026-01-01T12:00:00Z', fingerprint: 'fp' };
  const opts = { maxAgeMs: 6 * 3600_000, now: new Date('2026-01-01T12:01:00Z') };
  it('keeps the state when the status was written or already matched', () => {
    expect(isDue(stateAfterStatus(st, true), 'fp', opts)).toBe(false);
  });
  it('makes the PR due at once when the status write failed', () => {
    expect(stateAfterStatus(st, false).fingerprint).toBe('fp');
    expect(isDue(stateAfterStatus(st, false), 'fp', opts)).toBe(true);
  });
  it('#27: keeps the real evaluatedAt and sets statusPending instead', () => {
    expect(stateAfterStatus(st, false)).toEqual({ ...st, statusPending: true });
    expect(stateAfterStatus(st, true)).toEqual(st);
  });
  it('#32: makes the PR due at once when rounds are unknown', () => {
    expect(stateAfterStatus(st, true, true)).toEqual({ ...st, roundsUnknown: true });
    expect(isDue(stateAfterStatus(st, true, true), 'fp', opts)).toBe(true);
  });
});
