export interface CheckRunLite {
  name: string;
  status: string; // queued | in_progress | completed | ...
  conclusion: string | null;
  url?: string | null;
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
}

const OK = new Set(['success', 'neutral', 'skipped']);

export function evaluateCi(checks: CheckRunLite[], statuses: StatusLite[], ignore: CiIgnore): CiResult {
  const skip = new Set(ignore.names.map((n) => n.toLowerCase()));
  const res: CiResult = { state: 'none', failing: [], pending: [], passed: [] };
  for (const c of checks) {
    if (skip.has(c.name.toLowerCase())) continue;
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
