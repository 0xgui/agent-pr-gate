import { GateState } from './state';
import { Outcome } from './writes';

export interface SweepCandidate {
  number: number;
  /** State from the gate comment, or null if the gate never evaluated this PR. */
  stored: GateState | null;
}

export interface SweepOptions {
  maxPrs: number;
  /** Re-check a PR at least this often even if nothing changed. */
  maxAgeMs: number;
  now: Date;
}

export interface SweepPlan {
  run: number[];
  /** Same fingerprint as the last evaluation, and evaluated recently. */
  skipped: number[];
  /** Not looked at because the batch was full or planning stopped. */
  deferred: number[];
  /** Fingerprint lookups that failed. */
  failed: number[];
  stoppedEarly: string | null;
}

/** Never-evaluated PRs first, then oldest evaluation first. */
// Clock skew between runners that is still trusted. A later evaluatedAt (skew, or a hand-edited
// marker) would otherwise suppress the max-age backstop forever.
const MAX_CLOCK_SKEW_MS = 60_000;

function evaluatedInFuture(stored: GateState, now: Date): boolean {
  return Date.parse(stored.evaluatedAt) > now.getTime() + MAX_CLOCK_SKEW_MS;
}

export function sweepOrder(cands: SweepCandidate[], now = new Date()): SweepCandidate[] {
  const t = (c: SweepCandidate) => (c.stored && !evaluatedInFuture(c.stored, now) ? Date.parse(c.stored.evaluatedAt) : -Infinity);
  return [...cands].sort((a, b) => t(a) - t(b) || a.number - b.number);
}

/** A PR is due when the gate never saw it, its inputs or CI changed, or the last check is too old. */
export function isDue(stored: GateState | null, currentFingerprint: string, opts: Pick<SweepOptions, 'maxAgeMs' | 'now'>): boolean {
  if (!stored) return true;
  if (stored.fingerprint !== currentFingerprint) return true;
  if (stored.statusPending || stored.roundsUnknown) return true;
  if (evaluatedInFuture(stored, opts.now)) return true;
  return opts.now.getTime() - Date.parse(stored.evaluatedAt) >= opts.maxAgeMs;
}

/**
 * Plan a scheduled re-check. Candidates are visited oldest-evaluated first; for each, the current
 * fingerprint is computed (the expensive part) and compared with the one stored in the gate
 * comment. Planning stops once maxPrs due PRs are found, when `guard` says so (rate limit), and
 * a failed lookup only skips that PR. Because every evaluation rewrites evaluatedAt, PRs that
 * stay blocked move to the back instead of starving the rest.
 */
export async function planSweep(
  cands: SweepCandidate[],
  currentFingerprint: (pr: number) => Promise<string>,
  opts: SweepOptions,
  guard?: (planned: number) => Promise<string | null>,
  onError?: (pr: number, e: unknown) => void,
): Promise<SweepPlan> {
  const plan: SweepPlan = { run: [], skipped: [], deferred: [], failed: [], stoppedEarly: null };
  const ordered = sweepOrder(cands, opts.now);
  for (let i = 0; i < ordered.length; i++) {
    const c = ordered[i]!;
    if (plan.run.length >= Math.max(0, opts.maxPrs)) {
      plan.deferred.push(...ordered.slice(i).map((x) => x.number));
      break;
    }
    const stop = guard ? await guard(plan.run.length) : null;
    if (stop) {
      plan.stoppedEarly = stop;
      plan.deferred.push(...ordered.slice(i).map((x) => x.number));
      break;
    }
    try {
      if (isDue(c.stored, await currentFingerprint(c.number), opts)) plan.run.push(c.number);
      else plan.skipped.push(c.number);
    } catch (e) {
      plan.failed.push(c.number);
      onError?.(c.number, e);
    }
  }
  return plan;
}

/**
 * Rough core-API cost of one evaluation and its writes (PR, config, files, reviews, timeline,
 * CODEOWNERS, CI polls, workflow runs, labels, comment, status). Used to reserve budget during discovery (#13).
 */
export const EVALUATION_CALLS = 21;

/**
 * Core calls for one fingerprint (PR, config, reviews, checks, statuses, workflow runs) and one state read, at
 * one page each. sweepReserve scales them by the most pages a state read has used so far (#34).
 */
export const FINGERPRINT_CALLS = 6;
export const STATE_READ_CALLS = 1;

/** Calls to keep for discovery still to come and the evaluations it may plan (#28). */
export function sweepReserve(n: { stateReads?: number; fingerprints?: number; evaluations?: number; pages?: number }): number {
  const pages = Math.max(1, n.pages ?? 1);
  return pages * ((n.stateReads ?? 0) * STATE_READ_CALLS + (n.fingerprints ?? 0) * FINGERPRINT_CALLS) + evaluationReserve(n.evaluations ?? 0);
}

/** A positive integer input, or the fallback for anything else (#29: NaN would remove the cap). */
export function positiveInt(raw: string, fallback: number): number {
  // Plain decimal only: Number() would also read 1e3, 0x10 and 01 (#33).
  const t = raw.trim();
  const n = Number(t);
  return /^[1-9]\d*$/.test(t) && Number.isSafeInteger(n) ? n : fallback;
}

export function evaluationReserve(evaluations: number): number {
  return Math.max(0, evaluations) * EVALUATION_CALLS;
}

/** Stop before the API budget, minus what is reserved for later work, drops below the floor. */
export function rateLimitLow(remaining: number, minRemaining: number, reserve = 0): boolean {
  return remaining - reserve < minRemaining;
}

/** Fetch once per key for the whole run (e.g. reverts for the default branch). */
export function onceByKey<T>(fetch: (key: string) => Promise<T>): (key: string) => Promise<T> {
  const cache = new Map<string, Promise<T>>();
  return (key) => {
    let p = cache.get(key);
    if (!p) {
      p = fetch(key);
      cache.set(key, p);
    }
    return p;
  };
}

export interface SweepLog {
  error(message: string): void;
  notice(message: string): void;
}

/**
 * Evaluate PRs one by one. A failure on one PR is logged and recorded as 'error' without
 * stopping the others. `beforeEach` can stop the batch (e.g. low rate limit) by returning a reason.
 */
export async function runEach(
  prs: number[],
  fn: (pr: number) => Promise<Outcome>,
  log: SweepLog,
  beforeEach?: () => Promise<string | null>,
): Promise<{ outcomes: Map<number, Outcome>; stoppedEarly: string | null }> {
  const outcomes = new Map<number, Outcome>();
  for (const pr of prs) {
    const stop = beforeEach ? await beforeEach() : null;
    if (stop) {
      log.notice(`Stopping early: ${stop}. ${prs.length - outcomes.size} PR(s) left for the next run.`);
      return { outcomes, stoppedEarly: stop };
    }
    try {
      outcomes.set(pr, await fn(pr));
    } catch (e) {
      log.error(`PR #${pr}: ${e instanceof Error ? e.message : String(e)}`);
      outcomes.set(pr, 'error');
    }
  }
  return { outcomes, stoppedEarly: null };
}
