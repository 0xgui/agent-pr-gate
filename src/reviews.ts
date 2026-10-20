export interface ReviewLite {
  id?: number;
  user: string;
  isBot: boolean;
  state: string; // APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING
  submittedAt: string | null;
  /** Head commit the review was left on. */
  commitId?: string | null;
  /** OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE, ... */
  association?: string;
}

export function isBotLogin(login: string, type?: string): boolean {
  return type === 'Bot' || /\[bot\]$/i.test(login);
}

export interface ApprovalOptions {
  /** Current head SHA. Approvals on other commits are stale. */
  headSha: string;
  allowStale?: boolean;
  /** author_association values that may approve. Empty means anyone. */
  trustedAssociations?: string[];
}

export interface ApprovalResult {
  approvers: string[];
  /** Latest decision was an approval, but on an older commit. */
  stale: string[];
  /** Approved, but without repo access (author_association not trusted). */
  untrusted: string[];
}

/**
 * Users whose latest decisive review is APPROVED. Bots and the PR author never count.
 * COMMENTED reviews do not change a user's decision; DISMISSED clears it. By default the
 * approval must be on the current head commit and come from an OWNER, MEMBER or COLLABORATOR.
 */
export function approvalsFor(reviews: ReviewLite[], author: string, opts: ApprovalOptions): ApprovalResult {
  const latest = new Map<string, ReviewLite>();
  const sorted = reviews
    .filter((r) => r.submittedAt && !r.isBot && r.user.toLowerCase() !== author.toLowerCase())
    .sort((a, b) => Date.parse(a.submittedAt!) - Date.parse(b.submittedAt!));
  for (const r of sorted) {
    if (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED' || r.state === 'DISMISSED') latest.set(r.user, r);
  }
  const trusted = (opts.trustedAssociations ?? []).map((a) => a.toUpperCase());
  const res: ApprovalResult = { approvers: [], stale: [], untrusted: [] };
  for (const [user, r] of latest) {
    if (r.state !== 'APPROVED') continue;
    if (trusted.length && !trusted.includes((r.association ?? 'NONE').toUpperCase())) res.untrusted.push(user);
    else if (!opts.allowStale && r.commitId !== opts.headSha) res.stale.push(user);
    else res.approvers.push(user);
  }
  res.approvers.sort();
  res.stale.sort();
  res.untrusted.sort();
  return res;
}

export interface RoundResult {
  rounds: number;
  /** Each reviewed commit that the author has since moved past. */
  openedBy: { user: string; at: string; commit: string }[];
  /** True when a dismissed review that could count was not resolvable (timeline unreadable). */
  unknown?: boolean;
}

export interface RoundOptions {
  headSha: string;
  author: string;
  /** Review states that open a round. Default CHANGES_REQUESTED. */
  states?: string[];
  /** author_association values whose reviews count. Empty means anyone. */
  trustedAssociations?: string[];
  /**
   * Original state of dismissed reviews, by review id, from the timeline's review_dismissed
   * events (dismissed_review.state). A DISMISSED review counts only if its original state is
   * a counted state, so dismissed approvals never count. Null means the timeline could not be
   * read: rounds are then unknown if any dismissed review could have counted (fail closed, #16).
   */
  dismissedOriginal?: Map<number, string> | null;
}

/**
 * A review/fix round is a counted review left on commit X by a trusted human (not a bot, not the
 * PR author, author_association in trustedAssociations), after which the head moved off X.
 * "Moved off X" means X is not the current head, or a later review by a trusted human was left on a
 * different commit, which proves the head changed after it even if it was later force-pushed
 * back to X. Several reviews on one commit are one round. Only review commit ids and review
 * order are used, never commit dates or check-suite times, which authors can influence.
 */
export function countRounds(reviews: ReviewLite[], opts: RoundOptions): RoundResult {
  const states = new Set((opts.states ?? ['CHANGES_REQUESTED']).map((s) => s.toUpperCase()));
  const trusted = (opts.trustedAssociations ?? []).map((a) => a.toUpperCase());
  const effectiveState = (r: ReviewLite): string => {
    if (r.state !== 'DISMISSED') return r.state;
    const orig = r.id !== undefined ? opts.dismissedOriginal?.get(r.id) : undefined;
    return orig ? `DISMISSED:${orig.toUpperCase()}` : 'DISMISSED';
  };
  const isCounted = (r: ReviewLite): boolean => {
    const st = effectiveState(r);
    const base = st.startsWith('DISMISSED:') ? st.slice('DISMISSED:'.length) : st;
    if (base === 'DISMISSED' || base === 'APPROVED') return false;
    return states.has(base);
  };
  const timeline = reviews
    .filter((r) => r.submittedAt && r.commitId)
    .sort((a, b) => Date.parse(a.submittedAt!) - Date.parse(b.submittedAt!));
  const byCommit = new Map<string, ReviewLite>();
  let unknown = false;
  timeline.forEach((r, i) => {
    if (r.isBot || r.user.toLowerCase() === opts.author.toLowerCase()) return;
    if (trusted.length && !trusted.includes((r.association ?? 'NONE').toUpperCase())) return;
    // Only a later review from a trusted human proves the head moved; a bot or outsider could
    // submit a review on any commit id through the API.
    const movedLater = timeline
      .slice(i + 1)
      .some((later) => later.commitId !== r.commitId && !later.isBot && later.user.toLowerCase() !== opts.author.toLowerCase() && (trusted.length === 0 || trusted.includes((later.association ?? 'NONE').toUpperCase())));
    const headMoved = r.commitId !== opts.headSha || movedLater;
    // A dismissed review whose head never moved can't be a round, whatever its original state (#31).
    if (r.state === 'DISMISSED' && opts.dismissedOriginal === null && headMoved) unknown = true;
    if (!isCounted(r)) return;
    if (!headMoved) return;
    if (!byCommit.has(r.commitId!)) byCommit.set(r.commitId!, r);
  });
  const openedBy = [...byCommit.entries()].map(([commit, r]) => ({ user: r.user, at: r.submittedAt!, commit }));
  return { rounds: openedBy.length, openedBy, ...(unknown ? { unknown } : {}) };
}

/** Milliseconds from PR creation to the first review by a human who is not the author. */
export function timeToFirstHumanReview(prCreatedAt: string, reviews: ReviewLite[], author: string): number | null {
  const times = reviews
    .filter((r) => r.submittedAt && !r.isBot && r.user.toLowerCase() !== author.toLowerCase() && r.state !== 'PENDING')
    .map((r) => Date.parse(r.submittedAt!));
  if (times.length === 0) return null;
  return Math.max(0, Math.min(...times) - Date.parse(prCreatedAt));
}
