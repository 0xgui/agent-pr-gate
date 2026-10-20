import { minimatch } from 'minimatch';
import { GateConfig, Tier, TIERS } from './config';

export interface TierTrigger {
  file: string;
  tier: Tier;
  /** Glob that matched, or undefined when the file fell back to the default tier. */
  glob?: string;
  /** Line of the glob in the config file. */
  line?: number;
}

export interface TierResult {
  tier: Tier;
  /** Files that put the PR in its final tier. */
  triggers: TierTrigger[];
  perFile: TierTrigger[];
  /** Set when the tier was forced instead of computed from globs. */
  forced?: string;
}

export interface FileListInfo {
  /** pr.changed_files from the API. */
  total: number;
  /** Paths the files API actually returned (it stops at 3000). */
  seen: number;
}

export function tierRank(t: Tier): number {
  return TIERS.indexOf(t);
}

/** Slash-less, unanchored globs ("*.md") match at any depth; everything else matches from the root. */
export function matchGlob(file: string, glob: string, anchored = glob.includes('/')): boolean {
  return minimatch(file, glob, { dot: true, matchBase: !anchored });
}

/** Tier for a single file: the highest tier with a matching glob, else the default tier. */
export function classifyFile(file: string, cfg: GateConfig): TierTrigger {
  for (const tier of [...TIERS].reverse()) {
    for (const g of cfg.tiers[tier]) {
      if (matchGlob(file, g.glob, g.anchored)) return { file, tier, glob: g.glob, line: g.line };
    }
  }
  return { file, tier: cfg.defaultTier };
}

/** Highest tier across all changed files wins. No files means the default tier. */
export function classify(files: string[], cfg: GateConfig, info?: FileListInfo): TierResult {
  const perFile = [...new Set(files)].map((f) => classifyFile(f, cfg));
  if (info && info.total > info.seen) {
    return {
      tier: 'high',
      triggers: [],
      perFile,
      forced: `The PR changes ${info.total} files but the GitHub API only listed ${info.seen}, so unseen files could be high risk. Tier forced to high.`,
    };
  }
  if (perFile.length === 0) return { tier: cfg.defaultTier, triggers: [], perFile };
  let tier: Tier = 'low';
  for (const p of perFile) if (tierRank(p.tier) > tierRank(tier)) tier = p.tier;
  return { tier, triggers: perFile.filter((p) => p.tier === tier), perFile };
}
