import { SectionSpec } from './config';

export interface Section {
  title: string;
  key: string;
  level: number;
  content: string;
  /** Text up to the next heading of any kind. */
  own: string;
}

export type EvidenceStatus = 'ok' | 'missing' | 'empty';

export interface EvidenceItem {
  name: string;
  status: EvidenceStatus;
}

export function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function stripComments(s: string): string {
  return s.replace(/<!--[\s\S]*?(-->|$)/g, '');
}

const ATX = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
// A whole-line bold label ("**Testing**", "**Testing:**", "**Testing**:"), or a bold label that
// ends in a colon followed by text ("**Risk:** low"). Bold prose like "**Testing** was skipped."
// is not a heading.
const BOLD_LINE = /^ {0,3}\*\*([^*]+?)\*\*[ \t]*:?[ \t]*$/;
const BOLD_COLON = /^ {0,3}\*\*([^*]+?)(?::\*\*|\*\*:)[ \t]*(.*)$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const NOT_PARAGRAPH = /^ {0,3}([-*+][ \t]|\d+[.)][ \t]|>|#|`{3,}|~{3,}|\|)/;

interface Head {
  idx: number;
  /** Lines the heading itself occupies (2 for setext). */
  span: number;
  level: number;
  title: string;
  inline: string;
}

interface Parsed {
  lines: string[];
  heads: Head[];
  /** True for lines that open or close a code fence. */
  fenceLine: boolean[];
}

function parse(body: string): Parsed {
  const lines = stripComments(body ?? '').replace(/\r\n?/g, '\n').split('\n');
  const heads: Head[] = [];
  const fenceLine = lines.map(() => false);
  let fence: { ch: string; len: number } | null = null;
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx]!;
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence.ch === '`' ? '`' : '~'}{${fence.len},}[ \\t]*$`);
      if (close.test(line)) {
        fence = null;
        fenceLine[idx] = true;
      }
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open) {
      fence = { ch: open[1]![0]!, len: open[1]!.length };
      fenceLine[idx] = true;
      continue;
    }
    const atx = ATX.exec(line);
    if (atx) {
      heads.push({ idx, span: 1, level: atx[1]!.length, title: atx[2]!, inline: '' });
      continue;
    }
    const boldLine = BOLD_LINE.exec(line);
    if (boldLine) {
      heads.push({ idx, span: 1, level: 7, title: boldLine[1]!, inline: '' });
      continue;
    }
    const boldColon = BOLD_COLON.exec(line);
    if (boldColon) {
      heads.push({ idx, span: 1, level: 7, title: boldColon[1]!, inline: boldColon[2] ?? '' });
      continue;
    }
    const next = lines[idx + 1];
    if (next !== undefined && line.trim() && !NOT_PARAGRAPH.test(line)) {
      const se = SETEXT.exec(next);
      // A paragraph line underlined with === or --- is a setext heading, but only when the line
      // before it is blank or a heading, so multi-line paragraphs above a rule stay prose.
      const prev = idx > 0 ? lines[idx - 1]! : '';
      const prevIsBreak = !prev.trim() || heads.some((h) => h.idx + h.span - 1 === idx - 1);
      if (se && prevIsBreak) {
        heads.push({ idx, span: 2, level: se[1]![0] === '=' ? 1 : 2, title: line.trim(), inline: '' });
        idx++;
      }
    }
  }
  return { lines, heads, fenceLine };
}

/** Text that belongs to heads[i] alone: up to the next heading of any kind, without fence lines. */
function ownText(p: Parsed, i: number): string {
  const h = p.heads[i]!;
  const end = i + 1 < p.heads.length ? p.heads[i + 1]!.idx : p.lines.length;
  const body: string[] = [];
  for (let k = h.idx + h.span; k < end; k++) if (!p.fenceLine[k]) body.push(p.lines[k]!);
  return [h.inline, ...body].join('\n').trim();
}

/**
 * Split a markdown PR body into sections. ATX (#..######) and setext headings, and bold labels
 * ("**Risk:** low"), start a section. `content` runs to the next heading of the same or higher
 * level; `own` stops at the next heading of any kind. Headings inside code fences and HTML
 * comments are ignored.
 */
export function parseSections(body: string): Section[] {
  const p = parse(body);
  return p.heads.map((h, i) => {
    let end = p.lines.length;
    for (let j = i + 1; j < p.heads.length; j++) {
      if (p.heads[j]!.level <= h.level) {
        end = p.heads[j]!.idx;
        break;
      }
    }
    const content = [h.inline, ...p.lines.slice(h.idx + h.span, end).filter((_, k) => !p.fenceLine[h.idx + h.span + k])]
      .join('\n')
      .trim();
    return { title: h.title.trim(), key: normalizeTitle(h.title), level: h.level, content, own: ownText(p, i) };
  });
}

const TABLE_SEPARATOR = /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?$/;
// Block markers at the start of a line: list bullets, ordered items, quotes, task boxes.
const LEAD_MARKER = /^(?:[-*+](?=\s|$)|\d{1,9}[.)](?=\s|$)|>|\[[ xX]\](?=\s|$))\s*/;
const LEAD_NOISE = /^[^\p{L}\p{N}]+/u;
const UNCHECKED_BOX = /^\[ \](?=\s|$)/;
// '-', '...' and '?' need no token: a piece with no letter or digit left is already a placeholder.
// A hyphenated compound ("TBD-free", "TODO-list") is a different word, not a placeholder.
const PLACEHOLDER_FIRST_WORD = /^(?:todo|tbd|tba|wip|fixme|pending|no response|not tested)(?![-\p{L}\p{N}_])/iu;
const PLACEHOLDER_TOKEN = /\b(?:todo|tbd|tba|wip|fixme|n\/?a|pending|no response|not tested|fill (?:this|me) in)\b/giu;
// Cyrillic and Greek letters that look like Latin ones, so "ТОDО" reads as "TODO".
const LOOKALIKES: Record<string, string> = {
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X', У: 'Y', І: 'I', Ј: 'J', Ѕ: 'S', Ԁ: 'D',
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', ԁ: 'd', һ: 'h', ԛ: 'q', ԝ: 'w',
  Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T', Υ: 'Y', Χ: 'X',
  ο: 'o', ν: 'v', ι: 'i', ρ: 'p',
};
const LOOKALIKE_RE = new RegExp(`[${Object.keys(LOOKALIKES).join('')}]`, 'gu');
const CELL = '\u0001';
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
// What turns a placeholder-first line into evidence: a non-zero count with an outcome, an N/N
// score, or an outcome word. Issue numbers, versions and bare counts are not results.
const REPORTED_RESULT = /\b(?:0*[1-9]\d*\s+(?:tests?\s+)?(?:passed|passing|pass|ok|cases)\b|0*([1-9]\d*)\/0*\1\b|(?<!\b0+\s+(?:tests?\s+)?)(?:passed|passes)\b|green\b)/iu;
// A dash separates only with spaces on both sides, so "TBD-free" stays one word.
const SEPARATOR = /:|\s[-\u2013\u2014]\s|\(/u;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  ndash: '\u2013', mdash: '\u2014', hellip: '...', colon: ':', lpar: '(', rpar: ')', vert: '|',
  verbar: '|', lowbar: '_', ast: '*', num: '#', excl: '!', quest: '?', period: '.', comma: ',',
  hyphen: '-', minus: '-', dash: '-', sol: '/', lsqb: '[', rsqb: ']', lbrack: '[', rbrack: ']',
  grave: '`', tilde: '~', zwsp: '', zwj: '', zwnj: '', shy: '',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ' ';
    }
    return NAMED_ENTITIES[e.toLowerCase()] ?? ' ';
  });
}

function decodeAllEntities(s: string): string {
  let out = s;
  for (let i = 0; i < 8; i++) {
    const next = decodeEntities(out);
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Strip block markers; an unchecked task box means not done, so it empties the text. */
function stripMarkers(text: string): string {
  let l = text;
  let prev = '';
  while (prev !== l) {
    if (UNCHECKED_BOX.test(l)) return '';
    prev = l;
    l = l.replace(LEAD_MARKER, '').trim();
  }
  return l;
}

function normalizeOnce(line: string): string {
  let l = decodeAllEntities(line)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(LOOKALIKE_RE, (c) => LOOKALIKES[c]!)
    .replace(/\p{Cf}/gu, '')
    .replace(/\u00a0/g, ' ')
    .replace(/<summary\b[^>]*>[\s\S]*?<\/summary\s*>/gi, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .trim();
  l = stripMarkers(l);
  if (l.startsWith('|') || (l.includes('|') && /\|\s*$/.test(l))) {
    if (TABLE_SEPARATOR.test(l)) return '';
    // Table cells are kept apart with a control character (not whitespace, so trims keep it),
    // so the splitter can tell cells from prose.
    l = l.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => stripMarkers(c.trim())).join(CELL);
  }
  if (/^\[[^\]]*\]$/.test(l)) return '';
  return l
    .replace(/[*_~`]+/g, '')
    .replace(LEAD_NOISE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Step 1 of docs/evidence-rule.md, repeated until nothing changes. */
function normalizeLine(line: string): string {
  let l = line;
  let prev: string | null = null;
  while (prev !== l) {
    prev = l;
    l = normalizeOnce(l);
  }
  return l;
}

function onlyPlaceholderTokens(piece: string): boolean {
  return !LETTER_OR_DIGIT.test(piece.replace(PLACEHOLDER_TOKEN, ' '));
}

function splitLabel(l: string): { label: string; rest: string[] } | null {
  if (l.includes(CELL)) {
    const [label, ...rest] = l.split(CELL);
    return { label: label!, rest };
  }
  const m = SEPARATOR.exec(l);
  if (!m) return null;
  const label = l.slice(0, m.index);
  const after = l.slice(m.index + m[0].length);
  if (m[0] !== '(') return { label, rest: [after] };
  const close = after.indexOf(')');
  return close < 0 ? { label, rest: [after] } : { label, rest: [after.slice(0, close), after.slice(close + 1)] };
}

/** The rule in docs/evidence-rule.md, steps 2 and 3. */
function isEmptyText(text: string, depth = 0): boolean {
  const l = normalizeLine(text);
  if (!LETTER_OR_DIGIT.test(l)) return true;
  const split = depth < 32 ? splitLabel(l) : null;
  if (PLACEHOLDER_FIRST_WORD.test(l) && !split?.rest.some((p) => REPORTED_RESULT.test(p))) return true;
  if (!split) return onlyPlaceholderTokens(l);
  const label = normalizeLine(split.label);
  if (LETTER_OR_DIGIT.test(label) && onlyPlaceholderTokens(label)) return true;
  return split.rest.every((p) => isEmptyText(p, depth + 1));
}

/** Indices of table header rows (a row directly followed by a separator row). Headers are not content. */
function tableHeaderRows(lines: string[]): Set<number> {
  const out = new Set<number>();
  lines.forEach((l, i) => {
    const next = lines[i + 1];
    if (next !== undefined && l.includes('|') && TABLE_SEPARATOR.test(next.trim().replace(/^(>\s*)+/, ''))) out.add(i);
  });
  return out;
}

/** True when some line, other than a table header row, has content. HTML comments never count. */
export function hasContent(content: string): boolean {
  const lines = stripComments(content).split('\n');
  const headers = tableHeaderRows(lines);
  return lines.some((l, i) => !headers.has(i) && !isEmptyText(l));
}

function titleMatches(key: string, spec: SectionSpec): boolean {
  return [spec.name, ...spec.aliases].some((n) => {
    const want = normalizeTitle(n);
    return want.length > 0 && (key === want || key.startsWith(want + ' '));
  });
}

/**
 * Check that every required section exists (by heading, case-insensitive) and is filled in.
 * A section is filled by its own text, up to the next heading of any kind. Under a markdown
 * heading, non-required subsections ("### Unit" or "**Unit:** 42 passed" under "## Testing")
 * also count, judged as the line "Label: text" by the same rule. A required section never counts,
 * and a bold-label section is only filled by its own text (bold siblings do not count).
 */
export function checkEvidence(body: string | null | undefined, specs: SectionSpec[]): EvidenceItem[] {
  const sections = parseSections(body ?? '');
  const isRequired = (s: Section) => specs.some((spec) => titleMatches(s.key, spec));
  const filled = (i: number): boolean => {
    const h = sections[i]!;
    // Only the text after a heading or label is checked, never the label itself, so
    // "**Unit tests:** TODO" is a placeholder and "**Unit:** 42 passed" is real content.
    if (hasContent(h.own)) return true;
    // A bold-label section ends at the next label or heading. A bold sibling does not fill it;
    // nested detail has to be indented (e.g. a list item), which is part of its own text.
    if (h.level > 6) return false;
    // Under a markdown heading, non-required subsections fill the parent: deeper markdown
    // headings and bold labels. A required section, or a markdown heading at the same or a
    // higher level, ends the parent.
    for (let j = i + 1; j < sections.length; j++) {
      const sub = sections[j]!;
      if (isRequired(sub)) break;
      if (sub.level <= h.level) break;
      // A bold label is judged as the line it is, "Label: text", by the same normalizer, so
      // "**Unit:** TODO" and "**TODO:** describe tests" are placeholders like any other line.
      const text = sub.level > 6 && sub.own ? `${sub.title.replace(/:+\s*$/, '')}: ${sub.own}` : sub.own;
      if (hasContent(text)) return true;
    }
    return false;
  };
  return specs.map((spec) => {
    const found = sections.map((s, i) => ({ s, i })).filter(({ s }) => titleMatches(s.key, spec));
    if (found.length === 0) return { name: spec.name, status: 'missing' };
    return { name: spec.name, status: found.some(({ i }) => filled(i)) ? 'ok' : 'empty' };
  });
}

const HINTS: Record<string, string> = {
  testing: 'TODO: commands you ran and their result, e.g. `npm test` (42 passed)',
  risk: 'TODO: what could break, who is affected, and how you would notice',
  'how to revert': 'TODO: exact steps, e.g. `git revert <merge sha>`, plus any config or data rollback',
};

/** A pasteable PR body template for the given sections. TODO lines count as empty until replaced. */
export function sectionTemplate(specs: SectionSpec[]): string {
  return specs
    .map((s) => `## ${s.name}\n${HINTS[normalizeTitle(s.name)] ?? `TODO: describe ${s.name.toLowerCase()}`}`)
    .join('\n\n');
}
