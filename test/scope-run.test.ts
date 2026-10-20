import { afterEach, describe, expect, it, vi } from 'vitest';
import { runForPr } from '../src/main';
import { MARKER } from '../src/gate';

// A fake GitHub client with just the calls an out-of-scope run makes.
function fakeOctokit(opts: { base: string; head: string; comments?: { id: number; body: string; user: { login: string } }[]; author: string; files?: { filename: string; previous_filename?: string }[]; changedFiles?: number; listFilesFails?: boolean }) {
  const refs: string[] = [];
  const writes = { refs, statuses: [] as Record<string, unknown>[], created: 0, updated: [] as string[], evaluated: false };
  const pr = {
    number: 7,
    state: 'open',
    html_url: 'https://example.test/pr/7',
    user: { login: opts.author, type: 'User' },
    labels: [],
    base: { sha: 'base-sha', ref: 'main' },
    head: { sha: 'head-sha' },
    changed_files: opts.changedFiles ?? (opts.files ?? []).length,
  };
  const content = (text: string) => ({ data: { type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64') } });
  const octokit = {
    paginate: async (fn: (p: unknown) => Promise<{ data: unknown[] }>, p: unknown) => (await fn(p)).data,
    rest: {
      pulls: {
        get: async () => ({ data: pr }),
        listFiles: async () => {
          if (opts.listFilesFails) throw Object.assign(new Error('boom'), { status: 500 });
          return { data: opts.files ?? [] };
        },
        // Only the full gate reads reviews, so this marks a full evaluation.
        listReviews: async () => {
          writes.evaluated = true;
          throw new Error('full gate reached');
        },
      },
      repos: {
        getContent: async ({ ref }: { ref: string }) => (refs.push(ref), content(ref === 'base-sha' ? opts.base : opts.head)),
        listCommitStatusesForRef: async () => ({ data: [] }),
        createCommitStatus: async (p: Record<string, unknown>) => writes.statuses.push(p),
      },
      issues: {
        listComments: async () => ({ data: opts.comments ?? [] }),
        createComment: async () => writes.created++,
        updateComment: async ({ body }: { body: string }) => writes.updated.push(body),
      },
      users: { getAuthenticated: async () => ({ data: { login: 'github-actions[bot]' } }) },
    },
  };
  (octokit.paginate as unknown as { iterator: unknown }).iterator = async function* (fn: (p: unknown) => Promise<{ data: unknown[] }>, p: unknown) {
    yield await fn(p);
  };
  return { octokit: octokit as never, writes };
}

const repo = { owner: 'o', repo: 'r' };

describe('scope in a real run', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('reads scope from the base commit even with config-ref: head, so a PR cannot scope itself out', async () => {
    vi.stubEnv('INPUT_CONFIG-REF', 'head');
    vi.stubEnv('INPUT_STATUS-CONTEXT', 'agent-pr-gate');
    // The head tries to take its own author out of scope. The base says every PR is in scope.
    const { octokit, writes } = fakeOctokit({ author: 'alice', base: 'tiers: {}\n', head: 'scope:\n  authors: [someone-else]\n' });
    await runForPr(octokit, repo, 7).catch(() => undefined);
    expect(writes.evaluated).toBe(true);
    expect(writes.statuses.some((s) => s.description === 'not in scope')).toBe(false);
  });

  it('passes an out-of-scope PR with a success status and creates no comment', async () => {
    vi.stubEnv('INPUT_STATUS-CONTEXT', 'agent-pr-gate');
    const { octokit, writes } = fakeOctokit({ author: 'alice', base: 'scope:\n  authors: [agent-one]\n', head: '' });
    expect(await runForPr(octokit, repo, 7)).toBe('pass');
    expect(writes.evaluated).toBe(false);
    expect(writes.statuses).toEqual([expect.objectContaining({ sha: 'head-sha', state: 'success', context: 'agent-pr-gate', description: 'not in scope' })]);
    expect(writes.created).toBe(0);
    expect(writes.updated).toEqual([]);
  });

  it('rewrites an earlier gate comment so it does not show an old verdict', async () => {
    const old = { id: 1, body: `${MARKER}\n## ⛔ blocked`, user: { login: 'github-actions[bot]' } };
    const { octokit, writes } = fakeOctokit({ author: 'alice', base: 'scope:\n  bots: true\n', head: '', comments: [old] });
    expect(await runForPr(octokit, repo, 7)).toBe('pass');
    expect(writes.updated).toHaveLength(1);
    expect(writes.updated[0]).toMatch(/not in scope/);
  });
});

describe('scope never exempts high-risk changes', () => {
  afterEach(() => vi.unstubAllEnvs());
  const outOfScope = 'scope:\n  authors: [agent-one]\ntiers:\n  high: ["infra/**"]\n';
  const gated = async (files: { filename: string; previous_filename?: string }[], changedFiles?: number) => {
    vi.stubEnv('INPUT_STATUS-CONTEXT', 'agent-pr-gate');
    const { octokit, writes } = fakeOctokit({ author: 'alice', base: outOfScope, head: '', files, changedFiles });
    await runForPr(octokit, repo, 7).catch(() => undefined);
    return writes;
  };

  it.each([
    ['.review-gate.yml'],
    ['.github/workflows/ci.yml'],
    ['dist/index.js'],
    ['CODEOWNERS'],
    ['action.yml'],
  ])('an out-of-scope PR changing %s is fully gated', async (file) => {
    const writes = await gated([{ filename: 'docs/a.md' }, { filename: file }]);
    expect(writes.evaluated).toBe(true);
    expect(writes.statuses).toEqual([]);
  });

  it('a rename away from a gate-control file is fully gated', async () => {
    const writes = await gated([{ filename: 'old.yml', previous_filename: '.review-gate.yml' }]);
    expect(writes.evaluated).toBe(true);
  });

  it('an out-of-scope PR with a high-tier file is fully gated', async () => {
    const writes = await gated([{ filename: 'infra/main.tf' }]);
    expect(writes.evaluated).toBe(true);
    expect(writes.statuses).toEqual([]);
  });

  it('an out-of-scope PR with more files than the API lists is fully gated', async () => {
    const writes = await gated([{ filename: 'docs/a.md' }], 5000);
    expect(writes.evaluated).toBe(true);
  });

  it('an out-of-scope PR with only low-risk files still passes as out of scope', async () => {
    const writes = await gated([{ filename: 'src/a.ts' }]);
    expect(writes.evaluated).toBe(false);
    expect(writes.statuses).toEqual([expect.objectContaining({ state: 'success', description: 'not in scope' })]);
  });
});

describe('#39 follow-ups', () => {
  afterEach(() => vi.unstubAllEnvs());
  const outOfScope = 'scope:\n  authors: [agent-one]\n';

  it('a PR forced into scope is judged by the base rules, also with config-ref: head', async () => {
    vi.stubEnv('INPUT_CONFIG-REF', 'head');
    const { octokit, writes } = fakeOctokit({ author: 'alice', base: outOfScope, head: 'routing:\n  approvals: { high: 0 }\n', files: [{ filename: '.review-gate.yml' }] });
    await runForPr(octokit, repo, 7).catch(() => undefined);
    expect(writes.evaluated).toBe(true);
    expect(writes.refs).not.toContain('head-sha');
  });

  it('fails without a pass when the file list cannot be read', async () => {
    vi.stubEnv('INPUT_STATUS-CONTEXT', 'agent-pr-gate');
    const { octokit, writes } = fakeOctokit({ author: 'alice', base: outOfScope, head: '', listFilesFails: true });
    await expect(runForPr(octokit, repo, 7)).rejects.toThrow(/boom/);
    expect(writes.statuses).toEqual([]);
  });
});
