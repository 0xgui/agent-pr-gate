import { parse } from 'yaml';

export interface CheckRunLite {
  name: string;
  status: string; // queued | in_progress | completed | ...
  conclusion: string | null;
  url?: string | null;
  /** Check suite id; for GitHub Actions jobs it maps to one workflow run. */
  suiteId?: number | null;
}

export interface StatusLite {
  context: string;
  state: string; // success | pending | failure | error
}

export interface CiResult {
  state: 'green' | 'pending' | 'failing' | 'none';
  failing: string[];
  pending: string[];
  passed: string[];
}

export interface CiIgnore {
  /** Check run names or status contexts to skip (this gate's own job and status). */
  names: string[];
  /** Skip check runs from this workflow run id (the run this action is executing in). */
  runId?: string;
  /** The gate's job ID. Check runs with this name are skipped only when they are in `gateSuites`. */
  job?: string;
  /** Check suites of workflow runs whose job of that name runs this action. Unset: skip by name (#2). */
  gateSuites?: number[];
}

const OK = new Set(['success', 'neutral', 'skipped']);

export function evaluateCi(checks: CheckRunLite[], statuses: StatusLite[], ignore: CiIgnore): CiResult {
  const skip = new Set(ignore.names.map((n) => n.toLowerCase()));
  const job = ignore.job?.toLowerCase();
  const gate = ignore.gateSuites ? new Set(ignore.gateSuites) : null;
  const res: CiResult = { state: 'none', failing: [], pending: [], passed: [] };
  for (const c of checks) {
    if (skip.has(c.name.toLowerCase())) continue;
    if (job && c.name.toLowerCase() === job && (!gate || (c.suiteId != null && gate.has(c.suiteId)))) continue;
    if (ignore.runId && c.url && c.url.includes(`/actions/runs/${ignore.runId}/`)) continue;
    if (c.status !== 'completed') res.pending.push(c.name);
    else if (OK.has(c.conclusion ?? '')) res.passed.push(c.name);
    else res.failing.push(`${c.name} (${c.conclusion ?? 'unknown'})`);
  }
  // The statuses API lists newest first; keep the latest per context.
  const seen = new Set<string>();
  for (const s of statuses) {
    if (seen.has(s.context)) continue;
    seen.add(s.context);
    if (skip.has(s.context.toLowerCase())) continue;
    if (s.state === 'success') res.passed.push(s.context);
    else if (s.state === 'pending') res.pending.push(s.context);
    else res.failing.push(`${s.context} (${s.state})`);
  }
  if (res.failing.length) res.state = 'failing';
  else if (res.pending.length) res.state = 'pending';
  else if (res.passed.length) res.state = 'green';
  return res;
}

export interface WorkflowRunLite {
  checkSuiteId: number;
  path: string;
  event: string;
  headSha: string;
}

export interface GateLookup {
  /** Workflow runs for a head SHA. `refresh` skips the cache (a new run showed up). */
  runs(sha: string, refresh: boolean): Promise<WorkflowRunLite[]>;
  /** A workflow file's text at a ref, or null when it is missing. */
  workflow(path: string, ref: string): Promise<string | null>;
}

/** Lowercase check names of the jobs in a workflow file that have a step using this action. */
export function gateJobNames(text: string, uses: (ref: string) => boolean): Set<string> {
  const out = new Set<string>();
  let doc: unknown;
  try {
    doc = parse(text);
  } catch {
    return out;
  }
  const jobs = (doc as { jobs?: unknown } | null)?.jobs;
  if (!jobs || typeof jobs !== 'object') return out;
  for (const [id, job] of Object.entries(jobs as Record<string, { name?: unknown; steps?: unknown }>)) {
    const steps = Array.isArray(job?.steps) ? (job.steps as { uses?: unknown }[]) : [];
    if (!steps.some((s) => typeof s?.uses === 'string' && uses(s.uses))) continue;
    out.add((typeof job.name === 'string' ? job.name : id).toLowerCase());
  }
  return out;
}

/**
 * Check suites of the gate's own job checks (#2): check runs named like the gate's job whose
 * workflow run comes from a workflow file where that job runs this action. A same-name job in
 * another workflow stays CI. No API calls when no other check run has the job's name.
 */
export async function gateSuites(
  checks: CheckRunLite[],
  ignore: { job: string; runId?: string },
  sha: string,
  defaultBranch: string,
  uses: (ref: string) => boolean,
  lookup: GateLookup,
): Promise<number[]> {
  const job = ignore.job.toLowerCase();
  const candidates = checks.filter(
    (c) => c.name.toLowerCase() === job && c.suiteId != null && !(ignore.runId && c.url && c.url.includes(`/actions/runs/${ignore.runId}/`)),
  );
  if (!candidates.length) return [];
  const want = new Set(candidates.map((c) => c.suiteId!));
  let runs = await lookup.runs(sha, false);
  if ([...want].some((id) => !runs.some((r) => r.checkSuiteId === id))) runs = await lookup.runs(sha, true);
  const out: number[] = [];
  for (const r of runs) {
    if (!want.has(r.checkSuiteId)) continue;
    // pull_request_target runs the default branch's file; other events run the file at the run's SHA.
    const ref = r.event === 'pull_request_target' ? defaultBranch : r.headSha;
    const text = await lookup.workflow(r.path.split('@')[0]!, ref);
    if (text !== null && gateJobNames(text, uses).has(job)) out.push(r.checkSuiteId);
  }
  return out;
}
