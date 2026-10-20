import { describe, expect, it } from 'vitest';
import { DEFAULT_SECTIONS } from '../src/config';
import { checkEvidence, hasContent, parseSections, sectionTemplate } from '../src/evidence';

const status = (body: string) => Object.fromEntries(checkEvidence(body, DEFAULT_SECTIONS).map((e) => [e.name, e.status]));

describe('evidence parser', () => {
  it('accepts a complete body', () => {
    const body = '## Summary\nStuff\n\n## Testing\nnpm test: 12 passed\n\n## Risk\nLow, docs only\n\n## How to revert\ngit revert abc123\n';
    expect(status(body)).toEqual({ Testing: 'ok', Risk: 'ok', 'How to revert': 'ok' });
  });

  it('matches headings case-insensitively and ignores punctuation', () => {
    const body = '### TESTING\nran it\n# risk:\nnone\n## How-To-Revert\nrevert the merge\n';
    expect(status(body)).toEqual({ Testing: 'ok', Risk: 'ok', 'How to revert': 'ok' });
  });

  it('accepts aliases and longer titles', () => {
    const body = '## Test plan\nunit tests\n## Risk assessment\nsmall\n## Rollback\nflip the flag\n';
    expect(status(body)).toEqual({ Testing: 'ok', Risk: 'ok', 'How to revert': 'ok' });
  });

  it('reports missing sections', () => {
    expect(status('## Testing\nran tests\n')).toEqual({ Testing: 'ok', Risk: 'missing', 'How to revert': 'missing' });
  });

  it('treats empty, comment-only and TODO sections as empty', () => {
    const body = '## Testing\n<!-- describe tests -->\n\n## Risk\nTODO: fill in\n\n## How to revert\n- [ ]\n';
    expect(status(body)).toEqual({ Testing: 'empty', Risk: 'empty', 'How to revert': 'empty' });
  });

  it('ends a section at the next heading of the same or higher level only', () => {
    const body = '## Testing\n### Unit\nnpm test passed\n## Risk\n';
    expect(status(body).Testing).toBe('ok');
    expect(status(body).Risk).toBe('empty');
  });

  it('ignores headings inside code fences and HTML comments', () => {
    const body = '```md\n## Testing\nfake\n```\n<!--\n## Risk\nfake\n-->\n';
    expect(status(body)).toEqual({ Testing: 'missing', Risk: 'missing', 'How to revert': 'missing' });
  });

  it('supports bold lead-ins with inline content', () => {
    const body = '**Testing:** ran `npm test`\n**Risk**\nlow\n**How to revert:** git revert\n';
    expect(status(body)).toEqual({ Testing: 'ok', Risk: 'ok', 'How to revert': 'ok' });
  });

  it('handles null and CRLF bodies', () => {
    expect(checkEvidence(null, DEFAULT_SECTIONS).every((e) => e.status === 'missing')).toBe(true);
    expect(status('## Testing\r\nok\r\n## Risk\r\nok\r\n## How to revert\r\nok\r\n').Risk).toBe('ok');
  });

  it('does not match a heading that merely starts with the same letters', () => {
    expect(status('## Riskless refactor\nyes\n').Risk).toBe('missing');
  });

  it('keeps every section from parseSections', () => {
    expect(parseSections('# A\nx\n## B\ny').map((s) => [s.key, s.content])).toEqual([
      ['a', 'x\n## B\ny'],
      ['b', 'y'],
    ]);
  });

  it('template sections are TODO, so pasting it unedited still fails', () => {
    const t = sectionTemplate(DEFAULT_SECTIONS);
    expect(t).toContain('## How to revert');
    expect(status(t)).toEqual({ Testing: 'empty', Risk: 'empty', 'How to revert': 'empty' });
    expect(hasContent('N/A, no runtime change')).toBe(true);
  });
});
