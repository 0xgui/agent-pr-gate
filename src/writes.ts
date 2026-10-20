import type { GateState } from './state';
export interface WriteLog {
  warning(message: string): void;
}

function statusOf(e: unknown): number | undefined {
  return typeof e === 'object' && e !== null ? (e as { status?: number }).status : undefined;
}

/**
 * Run a write (label, comment, review request, status). A 403 (read-only token, e.g. a fork PR's
 * pull_request_review run) or 404 is logged and skipped so the gate still computes and reports
 * its result. Any other error is rethrown.
 */
export async function tryWrite<T>(what: string, fn: () => Promise<T>, log: WriteLog, tolerate: number[] = [403, 404]): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    const status = statusOf(e);
    if (status === 422 && tolerate.includes(422)) {
      log.warning(`Skipped ${what}: GitHub rejected it (HTTP 422), e.g. the per-commit status limit. Continuing.`);
      return null;
    }
    if (status !== undefined && status !== 422 && tolerate.includes(status)) {
      log.warning(
        `Skipped ${what}: the token cannot write here (HTTP ${status}). This is expected for fork PRs on read-only events; ` +
          'the gate result is still reported through the step outcome. Branch protection must enforce reviews.',
      );
      return null;
    }
    throw e;
  }
}

export type Stable<T> = { stale: false; value: T; attempts: number } | { stale: true; attempts: number; reason: string };

/**
 * Evaluate, then re-read the real inputs (PR fields and reviews, see inputsKey) and only accept
 * the result if they did not change meanwhile. If they did, evaluate again, up to `retries` more
 * times, before giving up as stale. Comments and labels are not inputs, so comment spam does not
 * make a run stale.
 */
export async function evaluateUntilStable<T>(
  evaluate: (attempt: number) => Promise<T | null>,
  keyOf: (value: T) => string,
  currentKey: (value: T) => Promise<string | null>,
  retries = 2,
): Promise<Stable<T> | null> {
  let reason = '';
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    const value = await evaluate(attempt);
    if (value === null) return null;
    const now = await currentKey(value);
    if (now === null) return { stale: true, attempts: attempt, reason: 'PR is no longer open' };
    if (now === keyOf(value)) return { stale: false, value, attempts: attempt };
    reason = `PR head, description, base, draft state or reviews changed while evaluating (${attempt} attempt(s))`;
  }
  return { stale: true, attempts: retries + 1, reason };
}

/** CI wait for an attempt: only the first evaluation waits; retries re-read CI once (#14). */
export function ciWaitFor(seconds: number): (attempt: number) => number {
  return (attempt) => (attempt === 1 ? seconds : 0);
}

/**
 * State to keep in the gate comment after the status write. If the status is not in place (the
 * write was refused), the PR is made due at once, so the next sweep does not skip it while its
 * commit status is missing or stale (#12).
 */
export function stateAfterStatus(st: GateState, statusInPlace: boolean, roundsUnknown = false): GateState {
  // Keep the real evaluatedAt so a due PR keeps its place in the sweep order (#27).
  return { ...st, ...(statusInPlace ? {} : { statusPending: true as const }), ...(roundsUnknown ? { roundsUnknown: true as const } : {}) };
}

export interface StatusLike {
  state: string;
  description?: string | null;
}

/** GitHub keeps at most 1000 statuses per commit and context, so only write when it changes. */
export function statusWriteNeeded(latest: StatusLike | null | undefined, want: StatusLike): boolean {
  return !latest || latest.state !== want.state || (latest.description ?? '') !== (want.description ?? '');
}

export type Outcome = 'pass' | 'blocked' | 'stale' | 'error';

/** Commit status to write for an outcome. A stale run writes nothing, so it never reports success. */
export function statusState(outcome: Outcome): 'success' | 'failure' | null {
  return outcome === 'pass' ? 'success' : outcome === 'blocked' ? 'failure' : null;
}

/** Only a blocked verdict fails the step; stale runs are neutral. */
export function stepShouldFail(outcomes: Outcome[], failOnBlock: boolean): boolean {
  return failOnBlock && outcomes.includes('blocked');
}

