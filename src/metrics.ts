export interface Metrics {
  pr: number;
  tier: string;
  gate: 'pass' | 'blocked';
  time_to_first_human_review_seconds: number | null;
  human_approvals: number;
  human_approvers: string[];
  rounds: number;
  reverts: {
    lookback_days: number;
    revert_commits: { sha: string; title: string; date: string }[];
    revert_prs: { number: number; title: string; merged_at: string }[];
  };
  generated_at: string;
}

const REVERT = /^revert\b/i;

export function isRevertTitle(title: string): boolean {
  return REVERT.test(title.trim());
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null) return 'no human review yet';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

export function metricsMarkdown(m: Metrics): string {
  const rows = [
    ['PR', `#${m.pr}`],
    ['Gate', m.gate],
    ['Risk tier', m.tier],
    ['Time to first human review', formatDuration(m.time_to_first_human_review_seconds)],
    ['Human approvals', `${m.human_approvals}${m.human_approvers.length ? ` (${m.human_approvers.join(', ')})` : ''}`],
    ['Review/fix rounds', String(m.rounds)],
    [`Revert commits on default branch (last ${m.reverts.lookback_days}d)`, String(m.reverts.revert_commits.length)],
    [`Merged revert PRs (last ${m.reverts.lookback_days}d)`, String(m.reverts.revert_prs.length)],
  ];
  return ['| Metric | Value |', '| --- | --- |', ...rows.map(([k, v]) => `| ${k} | ${v} |`)].join('\n');
}
