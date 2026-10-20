import { minimatch } from 'minimatch';

export interface OwnerRule {
  pattern: string;
  owners: string[];
  line: number;
}

export function parseCodeowners(text: string): OwnerRule[] {
  const rules: OwnerRule[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) return;
    const [pattern, ...owners] = line.split(/\s+/);
    if (pattern) rules.push({ pattern, owners: owners.filter((o) => o.startsWith('@') || o.includes('@')), line: i + 1 });
  });
  return rules;
}

/**
 * GitHub CODEOWNERS matching. A pattern with a "/" at the start or in the middle is anchored to
 * the repo root; otherwise it matches at any depth. A trailing "/" means a directory and
 * everything under it. A pattern whose last segment has no wildcard also covers a directory of
 * that name ("/build/logs", "**\/logs"). A last segment with "*" only matches one level, so
 * "docs/*" matches docs/a.md but not docs/sub/b.md, as GitHub documents.
 */
export function codeownersMatch(file: string, pattern: string): boolean {
  let p = pattern;
  const dirOnly = p.endsWith('/');
  p = p.replace(/\/+$/, '');
  const anchored = p.startsWith('/') || p.includes('/');
  p = p.replace(/^\/+/, '');
  if (!p) return false;
  const opts = { dot: true };
  const glob = anchored || p.startsWith('**') ? p : `**/${p}`;
  const last = p.split('/').pop() ?? '';
  if (dirOnly) return minimatch(file, `${glob}/**`, opts);
  if (minimatch(file, glob, opts)) return true;
  return !last.includes('*') && minimatch(file, `${glob}/**`, opts);
}

/** Owners for a file. As in GitHub, the last matching rule wins. */
export function ownersFor(file: string, rules: OwnerRule[]): string[] {
  let owners: string[] = [];
  for (const r of rules) if (codeownersMatch(file, r.pattern)) owners = r.owners;
  return owners;
}

export interface OwnerSplit {
  users: string[];
  teams: string[]; // "org/team"
}

export function splitOwners(owners: string[]): OwnerSplit {
  const users = new Set<string>();
  const teams = new Set<string>();
  for (const o of owners) {
    if (!o.startsWith('@')) continue; // email owners cannot be requested through the API
    const name = o.slice(1);
    if (name.includes('/')) teams.add(name);
    else users.add(name);
  }
  return { users: [...users].sort(), teams: [...teams].sort() };
}

/** true = member, false = not a member, null = could not tell (e.g. 404 or no org access). */
export type TeamLookup = (team: string, user: string) => boolean | null;

export interface FileCoverage {
  file: string;
  owners: string[];
  approvedBy: string[];
  status: 'approved' | 'pending' | 'no-owner' | 'author-only' | 'team-unknown';
}

/**
 * Every high-tier file needs an approval from one of ITS OWN code owners. One owner's approval
 * does not cover files owned by someone else.
 */
export function codeownerCoverage(
  files: string[],
  rules: OwnerRule[],
  approvers: string[],
  author: string,
  isMember: TeamLookup,
): FileCoverage[] {
  const lower = (s: string) => s.toLowerCase();
  return [...new Set(files)].map((file) => {
    const owners = ownersFor(file, rules);
    const { users, teams } = splitOwners(owners);
    if (users.length === 0 && teams.length === 0) return { file, owners, approvedBy: [], status: 'no-owner' };
    const approvedBy = new Set(approvers.filter((a) => users.map(lower).includes(lower(a))));
    let unknown = false;
    for (const t of teams) {
      for (const a of approvers) {
        const m = isMember(t, a);
        if (m === true) approvedBy.add(a);
        else if (m === null) unknown = true;
      }
    }
    if (approvedBy.size) return { file, owners, approvedBy: [...approvedBy].sort(), status: 'approved' };
    // Every entry, emails included, must be the author's login. An email co-owner cannot be
    // requested through the API, but it still means the author is not the only owner.
    if (owners.every((o) => lower(o) === `@${lower(author)}`)) {
      return { file, owners, approvedBy: [], status: 'author-only' };
    }
    return { file, owners, approvedBy: [], status: unknown ? 'team-unknown' : 'pending' };
  });
}
