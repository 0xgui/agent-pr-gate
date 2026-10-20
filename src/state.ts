import { createHash } from 'crypto';

/** Hidden data the gate keeps in its own comment, so later runs (and sweeps) can see what it saw. */
export interface GateState {
  v: 1;
  /** When the gate last evaluated this PR. */
  evaluatedAt: string;
  /** Fingerprint of the inputs that verdict was computed from. */
  fingerprint: string;
  /** The commit status write was refused, so the PR stays due until a status is in place (#27). */
  statusPending?: true;
  /** Review rounds could not be counted, so the PR stays due until they can (#32). */
  roundsUnknown?: true;
}

const STATE_RE = /<!-- agent-pr-gate:state (\{[^\n]*?\}) -->/;

export function renderState(st: GateState): string {
  // ISO dates and hex digests cannot contain "-->", so the JSON is safe inside a comment.
  return `<!-- agent-pr-gate:state ${JSON.stringify(st)} -->`;
}

export function parseState(body: string | null | undefined): GateState | null {
  const m = STATE_RE.exec(body ?? '');
  if (!m) return null;
  try {
    const o = JSON.parse(m[1]!) as Partial<GateState>;
    if (o.v !== 1 || typeof o.evaluatedAt !== 'string' || typeof o.fingerprint !== 'string' || Number.isNaN(Date.parse(o.evaluatedAt))) return null;
    return {
      v: 1,
      evaluatedAt: o.evaluatedAt,
      fingerprint: o.fingerprint,
      ...(o.statusPending === true ? { statusPending: true as const } : {}),
      ...(o.roundsUnknown === true ? { roundsUnknown: true as const } : {}),
    };
  } catch {
    return null;
  }
}

/** What a verdict depends on that can change without a push: the PR fields and its reviews. */
export interface PrInputs {
  headSha: string;
  baseSha: string;
  body: string | null;
  draft: boolean;
  reviews: { id: number; state: string }[];
}

export interface KeyReview {
  id?: number;
  state: string;
  user: string;
  isBot: boolean;
  association?: string | null;
}

/**
 * PR inputs from the PR fields and the reviews that can change the verdict: non-bot, not the
 * author, and from a trusted association (an empty list trusts everyone, as approvalsFor does).
 * Other reviews would only force needless re-evaluations (#14).
 */
export function toPrInputs(
  pr: { headSha: string; baseSha: string; body: string | null; draft: boolean },
  reviews: KeyReview[],
  who: { author: string; trustedAssociations: string[] },
): PrInputs {
  const author = who.author.toLowerCase();
  const counted = reviews.filter(
    (r) =>
      !r.isBot &&
      r.user.toLowerCase() !== author &&
      (who.trustedAssociations.length === 0 || who.trustedAssociations.includes((r.association ?? 'NONE').toUpperCase())),
  );
  return { ...pr, reviews: counted.map((r) => ({ id: r.id ?? 0, state: r.state })) };
}

/** Stable key of the PR inputs. Comments and labels are deliberately not part of it. */
export function inputsKey(i: PrInputs): string {
  const reviews = [...i.reviews].sort((a, b) => a.id - b.id).map((r) => `${r.id}:${r.state}`);
  return JSON.stringify([i.headSha, i.baseSha, i.body ?? '', i.draft, reviews]);
}

/** CI part of the fingerprint: the combined verdict and which checks are failing or pending. */
export interface CiSummary {
  state: string;
  failing: string[];
  pending: string[];
}

export function fingerprint(i: PrInputs, ci: CiSummary): string {
  const ciKey = JSON.stringify([ci.state, [...ci.failing].sort(), [...ci.pending].sort()]);
  return createHash('sha256').update(inputsKey(i)).update('\n').update(ciKey).digest('hex').slice(0, 16);
}
