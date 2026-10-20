import type { GateConfig } from './config';
import { gateControlTouched, MARKER } from './gate';
import { classify } from './tiers';

/**
 * Which PRs the gate enforces. Empty lists and `bots: false` mean every PR. Otherwise a PR is in
 * scope when its author is listed, its author is a bot and `bots` is true, or it has a listed label.
 */
export interface ScopeConfig {
  authors: string[];
  bots: boolean;
  labels: string[];
}

export interface ScopePr {
  author: string;
  isBot: boolean;
  labels: string[];
}

export type ScopeResult = { inScope: true } | { inScope: false; reason: string };

export function scopeIsAll(s: ScopeConfig): boolean {
  return s.authors.length === 0 && !s.bots && s.labels.length === 0;
}

export function inScope(s: ScopeConfig, pr: ScopePr): ScopeResult {
  if (scopeIsAll(s)) return { inScope: true };
  const lower = (x: string) => x.toLowerCase();
  if (s.authors.map(lower).includes(lower(pr.author))) return { inScope: true };
  if (s.bots && pr.isBot) return { inScope: true };
  const labels = new Set(pr.labels.map(lower));
  if (s.labels.some((l) => labels.has(lower(l)))) return { inScope: true };
  return { inScope: false, reason: `@${pr.author} is not in scope (scope in the base branch's gate config)` };
}

/** The gate comment for a PR the gate does not enforce. It carries no state, so the sweep skips it. */
export function renderOutOfScope(reason: string): string {
  return [MARKER, '## ➖ agent-pr-gate: not in scope', '', `This PR is not checked: ${reason}. The \`agent-pr-gate\` status passes.`].join('\n');
}

/**
 * Why an out-of-scope PR must still be gated, or null. Scope never skips a PR that changes a
 * gate-control file or reaches the high tier, including a tier forced high because the API did not
 * list every file. Renames count on both paths.
 */
export function forcedIntoScope(cfg: GateConfig, fileObjs: { filename: string; previous_filename?: string | null }[], changedFiles: number): string | null {
  const files = fileObjs.flatMap((f) => (f.previous_filename ? [f.filename, f.previous_filename] : [f.filename]));
  const touched = gateControlTouched(cfg, files);
  if (touched.length) return `changes gate-control files (${touched.slice(0, 5).map((f) => '`' + f + '`').join(', ')}${touched.length > 5 ? ', ...' : ''})`;
  const tier = classify(files, cfg, { total: changedFiles, seen: fileObjs.length });
  if (tier.tier === 'high') return tier.forced ? 'high tier (the API did not list every file)' : `high tier (${tier.triggers.slice(0, 3).map((t) => '`' + t.file + '`').join(', ')})`;
  return null;
}
