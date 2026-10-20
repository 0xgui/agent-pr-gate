// Table-driven: every wrapper crossed with every empty spec row must read as empty, and the same
// wrappers around every filled spec row must read as filled.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULT_SECTIONS } from '../src/config';
import { checkEvidence, sectionTemplate } from '../src/evidence';

const testing = (body: string) => checkEvidence(body, DEFAULT_SECTIONS)[0]!.status;

// Each wrapper turns a value into a full PR body with a Testing section.
const WRAPPERS: Record<string, (v: string) => string> = {
  plain: (v) => `## Testing\n${v}\n`,
  dash: (v) => `## Testing\n- ${v}\n`,
  star: (v) => `## Testing\n* ${v}\n`,
  ordered: (v) => `## Testing\n1. ${v}\n`,
  task: (v) => `## Testing\n- [ ] ${v}\n`,
  'task done': (v) => `## Testing\n- [x] ${v}\n`,
  quote: (v) => `## Testing\n> ${v}\n`,
  tab: (v) => `## Testing\n\t${v}\n`,
  '4-space': (v) => `## Testing\n    ${v}\n`,
  'nested list': (v) => `## Testing\n- **Unit:**\n  - ${v}\n`,
  'table cell': (v) => `## Testing\n| Check | Result |\n| --- | :---: |\n| Unit | ${v} |\n`,
  'bare table cell': (v) => `## Testing\n| ${v} |\n`,
  bold: (v) => `## Testing\n**Unit:** ${v}\n`,
  'bold, value on next line': (v) => `## Testing\n**Unit tests:**\n${v}\n`,
  'underscore bold': (v) => `## Testing\n__Unit:__ ${v}\n`,
  'plain label': (v) => `## Testing\nUnit tests: ${v}\n`,
  'full-width colon': (v) => `## Testing\nUnit tests\uff1a ${v}\n`,
  'dash + bold': (v) => `## Testing\n- **Unit:** ${v}\n`,
  'task + bold': (v) => `## Testing\n- [ ] **Unit:** ${v}\n`,
  'task done + bold': (v) => `## Testing\n- [x] **Unit:** ${v}\n`,
  'ordered + bold': (v) => `## Testing\n1. **Unit:** ${v}\n`,
  'quote + bold': (v) => `## Testing\n> **Unit:** ${v}\n`,
  'tab + bold': (v) => `## Testing\n\t**Unit:** ${v}\n`,
  '4-space + bold': (v) => `## Testing\n    **Unit:** ${v}\n`,
  'bold parent + list': (v) => `**Testing:**\n- **Unit:** ${v}\n`,
  'bold parent + indented list': (v) => `**Testing:**\n  - **Unit:** ${v}\n`,
  'bold parent inline': (v) => `**Testing:** ${v}\n`,
  'html wrapped': (v) => `## Testing\n<p>${v}</p>\n`,
};

// The worked examples in docs/evidence-rule.md are the spec. Each row's value is a JSON string in
// a code span; its verdict is `empty` or `filled`.
function specRows(): { value: string; verdict: 'empty' | 'filled' }[] {
  const doc = readFileSync(new URL('../docs/evidence-rule.md', import.meta.url), 'utf8');
  const table = doc.slice(doc.indexOf('## Worked examples'));
  return table
    .split('\n')
    .filter((l) => /^\| `/.test(l))
    .map((l) => {
      const cells = l.split(' | ');
      const value = cells[0]!.replace(/^\|\s*/, '').replace(/^`+ ?|`+$/g, '').replace(/ $/, '');
      const verdict = cells[cells.length - 1]!.replace(/\s*\|\s*$/, '');
      if (verdict !== 'empty' && verdict !== 'filled') throw new Error(`bad verdict in spec row: ${l}`);
      return { value: JSON.parse(value) as string, verdict };
    });
}

const SPEC = specRows();
const PLACEHOLDERS = Object.fromEntries(SPEC.filter((r) => r.verdict === 'empty').map((r) => [JSON.stringify(r.value), r.value]));
const REAL = SPEC.filter((r) => r.verdict === 'filled').map((r) => r.value);

describe('the spec table', () => {
  it('covers every case from the B1 and final reviews, in the direction the review gives', () => {
    const empty = ['\u{1F6A7} TODO', '\u26a0\ufe0f TODO', 'Unit tests \u2014 TODO', 'Unit tests - TODO', 'Tests (TODO)', 'Unit and integration test suites: TODO', 'Unit: Integration: TODO', 'Unit: - [ ] TODO', '[TODO](x)', '![TODO](x)'];
    empty.push('TODO add tests in a follow-up (#42)', 'TODO add tests (see #12)', 'TODO add tests (follow-up #123)', 'TODO add tests - follow-up in #12', 'TODO add tests (v2)', 'TODO add e2e tests (Node 20)', 'TODO add tests: 0 so far', 'TODO add tests - PR 2');
    empty.push('TODO add tests (follow-up PR)', 'TODO add tests (later)', 'TODO add tests - later', 'TODO add tests: later', 'Unit: TODO add tests (later)');
    empty.push('TODO add tests later', 'TODO add tests', 'Unit tests: TODO add tests', 'TBD once CI is set up', 'WIP, tests coming', 'No response yet');
    const filled = ['TODO list feature tested: 12 passed', 'Todo app e2e: 4 passed', 'FIXME parser tests: 8 passed', 'Todo app e2e: npm test passed; manually verified add/remove flows', 'WIP flag tests pass: 3/3', 'TBD-free: all 10 cases pass'];
    for (const v of empty) expect(SPEC).toContainEqual({ value: v, verdict: 'empty' });
    for (const v of filled) expect(SPEC).toContainEqual({ value: v, verdict: 'filled' });
  });
});

describe('placeholder matrix: every wrapper x every placeholder is empty', () => {
  const cases = Object.entries(WRAPPERS).flatMap(([w, wrap]) => Object.entries(PLACEHOLDERS).map(([p, v]) => [w, p, wrap(v)] as const));
  it.each(cases)('%s / %s', (_w, _p, body) => {
    expect(testing(body)).toBe('empty');
  });
});

// An unchecked task box means "not done" (docs/evidence-rule.md, step 1), so it empties any text.
const UNCHECKED = new Set(['task', 'task + bold']);

describe('real-content matrix: every wrapper around real text is filled', () => {
  const cases = Object.entries(WRAPPERS)
    .filter(([w]) => !UNCHECKED.has(w))
    .flatMap(([w, wrap]) => REAL.map((v) => [w, v, wrap(v)] as const));
  it.each(cases)('%s / %s', (_w, _v, body) => {
    expect(testing(body)).toBe('ok');
  });
});

describe('unchecked task boxes: real text behind an unchecked box is empty', () => {
  const cases = [...UNCHECKED].flatMap((w) => REAL.map((v) => [w, v, WRAPPERS[w]!(v)] as const));
  it.each(cases)('%s / %s', (_w, _v, body) => {
    expect(testing(body)).toBe('empty');
  });
});

describe('normalizer edge cases', () => {
  it('a section with only a zero-width space or format characters is empty', () => {
    expect(testing('## Testing\n\u200b\n')).toBe('empty');
    expect(testing('## Testing\n\u200b\u200d\u2060\ufeff\n')).toBe('empty');
  });
  it('a table with only a header and separator is empty', () => {
    expect(testing('## Testing\n| Unit | Integration |\n|---|---|\n')).toBe('empty');
  });
  it('a label of any length followed only by a placeholder is empty (B1: labels over 4 words)', () => {
    expect(testing('## Testing\nWe ran the full suite on staging and checked: TODO\n')).toBe('empty');
  });
  it('a table row whose cells after the label are all placeholders is empty', () => {
    expect(testing('## Testing\n| Unit | N/A | - |\n')).toBe('empty');
    expect(testing('## Testing\n| Check | Result | Notes |\n|---|---|---|\n| Unit | N/A | - |\n')).toBe('empty');
    expect(testing('## Testing\n| Unit | N/A | 12 passed |\n')).toBe('ok');
  });
  it('the template hints read as empty until replaced', () => {
    expect(testing(`${sectionTemplate(DEFAULT_SECTIONS)}\n`)).toBe('empty');
  });
  it('a placeholder label stays a placeholder even with text after it', () => {
    expect(testing('## Testing\n**TODO:** describe tests\n')).toBe('empty');
    expect(testing('## Testing\nTBD: will add\n')).toBe('empty');
  });
});
