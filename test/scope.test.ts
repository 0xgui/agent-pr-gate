import { describe, expect, it } from 'vitest';
import { configRefs, parseConfig } from '../src/config';
import { forcedIntoScope, inScope, renderOutOfScope } from '../src/scope';
import { MARKER } from '../src/gate';
import { parseState } from '../src/state';

const pr = (author: string, opts: { isBot?: boolean; labels?: string[] } = {}) => ({ author, isBot: opts.isBot ?? false, labels: opts.labels ?? [] });

describe('scope: which PRs the gate enforces', () => {
  it('defaults to every PR, so current behaviour is unchanged', () => {
    const cfg = parseConfig('');
    expect(cfg.scope).toEqual({ authors: [], bots: false, labels: [] });
    expect(inScope(cfg.scope, pr('alice'))).toEqual({ inScope: true });
    expect(inScope(parseConfig('scope: {}\n').scope, pr('alice'))).toEqual({ inScope: true });
  });
  it('limits the gate to listed authors, bot authors and labelled PRs', () => {
    const scope = parseConfig('scope:\n  authors: ["@Agent-One"]\n  bots: true\n  labels: [agent]\n').scope;
    expect(inScope(scope, pr('agent-one')).inScope).toBe(true);
    expect(inScope(scope, pr('renovate[bot]', { isBot: true })).inScope).toBe(true);
    expect(inScope(scope, pr('alice', { labels: ['Agent'] })).inScope).toBe(true);
    const out = inScope(scope, pr('alice', { labels: ['docs'] }));
    expect(out).toEqual({ inScope: false, reason: expect.stringMatching(/scope/) });
  });
  it('bots: false does not pull in bots, and authors alone leaves everyone else out', () => {
    const scope = parseConfig('scope:\n  authors: [agent-one]\n').scope;
    expect(inScope(scope, pr('dependabot[bot]', { isBot: true })).inScope).toBe(false);
    expect(inScope(scope, pr('alice')).inScope).toBe(false);
  });
  it('rejects malformed scope keys', () => {
    expect(() => parseConfig('scope:\n  bots: yes please\n')).toThrow(/scope.bots/);
    expect(() => parseConfig('scope:\n  authors: agent\n')).toThrow(/scope.authors/);
    expect(() => parseConfig('scope: [agent]\n')).toThrow(/scope/);
  });
});

describe('scope is read from the base commit, so a PR cannot scope itself out', () => {
  const p = { base: { sha: 'base-sha' }, head: { sha: 'head-sha' } };
  it('uses the base commit for scope even with config-ref: head', () => {
    expect(configRefs('head', p)).toEqual({ rules: 'head-sha', scope: 'base-sha' });
    expect(configRefs('base', p)).toEqual({ rules: 'base-sha', scope: 'base-sha' });
    expect(configRefs('', p)).toEqual({ rules: 'base-sha', scope: 'base-sha' });
  });
});

describe('out-of-scope note', () => {
  it('is a gate comment with the reason and no state marker', () => {
    const body = renderOutOfScope('author @alice is not in scope');
    expect(body.startsWith(MARKER)).toBe(true);
    expect(body).toMatch(/not in scope/);
    expect(parseState(body)).toBeNull();
  });
});

describe('#38: trusted_associations', () => {
  it('rejects an empty list instead of trusting every reviewer', () => {
    expect(() => parseConfig('routing:\n  trusted_associations: []\n')).toThrow(/trusted_associations/);
  });
  it('still accepts a non-empty list', () => {
    expect(parseConfig('routing:\n  trusted_associations: [owner]\n').trustedAssociations).toEqual(['OWNER']);
  });
});

describe('forcedIntoScope', () => {
  const cfg = parseConfig('tiers:\n  high: ["infra/**"]\n', 'config/gate.yml');
  it('names gate-control files, including the configured config path and both sides of a rename', () => {
    expect(forcedIntoScope(cfg, [{ filename: '.review-gate.yml' }], 1)).toMatch(/^changes gate-control files \(`\.review-gate\.yml`\)/);
    expect(forcedIntoScope(cfg, [{ filename: 'config/gate.yml' }], 1)).toMatch(/gate-control/);
    expect(forcedIntoScope(cfg, [{ filename: 'x.yml', previous_filename: 'action.yml' }], 1)).toMatch(/action\.yml/);
  });
  it('names a high tier, also when the file list was cut off', () => {
    expect(forcedIntoScope(cfg, [{ filename: 'infra/a.tf' }], 1)).toMatch(/^high tier/);
    expect(forcedIntoScope(cfg, [{ filename: 'docs/a.md' }], 5000)).toMatch(/^high tier/);
  });
  it('is null for other changes', () => {
    expect(forcedIntoScope(cfg, [{ filename: 'src/a.ts' }, { filename: 'docs/a.md' }], 2)).toBeNull();
  });
});
