import { describe, expect, it } from 'vitest';
import { CheckRunLite, evaluateCi, gateJobNames, gateSuites, GateLookup, WorkflowRunLite } from '../src/ci';

// Issue #2: the gate finds its own job checks by workflow + job, not by bare job name.
const JOB = 'agent-pr-gate-job';
const uses = (u: string) => u.toLowerCase().startsWith('0xgui/agent-pr-gate@');

const gateYml = `on: pull_request_target\njobs:\n  ${JOB}:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: 0xgui/agent-pr-gate@9f827e71c7e6374073cb718989e166ff69c6561c\n`;
const recheckYml = `on:\n  schedule: [{cron: '*/30 * * * *'}]\njobs:\n  ${JOB}:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: 0xgui/agent-pr-gate@9f827e71c7e6374073cb718989e166ff69c6561c\n        with: {pr-number: open}\n`;
// A user's CI that happens to reuse the gate's job ID.
const ciYml = `on: pull_request\njobs:\n  ${JOB}:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n`;

const files: Record<string, string> = {
  '.github/workflows/agent-pr-gate.yml@main': gateYml,
  '.github/workflows/agent-pr-gate-recheck.yml@head': recheckYml,
  '.github/workflows/ci.yml@head': ciYml,
};

function lookup(runs: WorkflowRunLite[]) {
  const calls = { runs: 0, workflow: 0 };
  const l: GateLookup = {
    runs: async () => (calls.runs++, runs),
    workflow: async (path, ref) => (calls.workflow++, files[`${path}@${ref}`] ?? null),
  };
  return { l, calls };
}

const run = (checkSuiteId: number, path: string, event: string): WorkflowRunLite => ({ checkSuiteId, path: `.github/workflows/${path}`, event, headSha: 'head' });
const check = (suiteId: number, runId: number, conclusion: string | null, name = JOB): CheckRunLite => ({
  name,
  status: conclusion === null ? 'in_progress' : 'completed',
  conclusion,
  suiteId,
  url: `https://github.com/o/r/actions/runs/${runId}/job/1`,
});

async function verdict(checks: CheckRunLite[], runs: WorkflowRunLite[], runId = '999') {
  const { l, calls } = lookup(runs);
  const suites = await gateSuites(checks, { job: JOB, runId }, 'head', 'main', uses, l);
  return { ci: evaluateCi(checks, [], { names: [], runId, job: JOB, gateSuites: suites }), calls };
}

describe('own gate checks (#2)', () => {
  it('counts a failing same-name job from another workflow as CI', async () => {
    const { ci } = await verdict([check(1, 10, 'success', 'test'), check(2, 20, 'failure')], [run(1, 'ci.yml', 'pull_request'), run(2, 'ci.yml', 'pull_request')]);
    expect(ci.state).toBe('failing');
    expect(ci.failing).toEqual([`${JOB} (failure)`]);
  });

  it('skips the gate job from the event workflow and from the recheck workflow', async () => {
    const { ci } = await verdict(
      [check(1, 10, 'success', 'test'), check(3, 30, 'failure'), check(4, 40, null)],
      [run(1, 'ci.yml', 'pull_request'), run(3, 'agent-pr-gate.yml', 'pull_request_target'), run(4, 'agent-pr-gate-recheck.yml', 'schedule')],
    );
    expect(ci).toMatchObject({ state: 'green', passed: ['test'], failing: [], pending: [] });
  });

  it('skips cancelled and failed checks from earlier gate runs, but not a same-name CI job', async () => {
    const { ci, calls } = await verdict(
      [check(1, 10, 'success', 'test'), check(5, 50, 'cancelled'), check(6, 60, 'failure'), check(7, 70, 'failure')],
      [run(1, 'ci.yml', 'pull_request'), run(5, 'agent-pr-gate.yml', 'pull_request_target'), run(6, 'agent-pr-gate.yml', 'pull_request_target'), run(7, 'ci.yml', 'pull_request')],
    );
    expect(ci.failing).toEqual([`${JOB} (failure)`]);
    expect(calls.runs).toBe(1);
  });

  it('makes no API calls when no other check has the job name', async () => {
    const { ci, calls } = await verdict([check(1, 10, 'success', 'test'), check(9, 999, null)], []);
    expect(ci.state).toBe('green');
    expect(calls).toEqual({ runs: 0, workflow: 0 });
  });

  it('re-reads the runs once when a check suite is not in the cached list', async () => {
    let n = 0;
    const l: GateLookup = {
      runs: async (_sha, refresh) => (n++, refresh ? [run(3, 'agent-pr-gate.yml', 'pull_request_target')] : []),
      workflow: async (path, ref) => files[`${path}@${ref}`] ?? null,
    };
    expect(await gateSuites([check(3, 30, 'failure')], { job: JOB }, 'head', 'main', uses, l)).toEqual([3]);
    expect(n).toBe(2);
  });

  it('falls back to skipping by name when suites are unknown', () => {
    expect(evaluateCi([check(2, 20, 'failure')], [], { names: [], job: JOB }).state).toBe('none');
  });

  it('reads job names, honoring a job name: override', () => {
    expect([...gateJobNames(`jobs:\n  a:\n    name: Gate\n    steps: [{uses: '0xgui/agent-pr-gate@v1'}]\n  b:\n    steps: [{run: x}]\n`, uses)]).toEqual(['gate']);
    expect(gateJobNames(': not yaml [', uses).size).toBe(0);
  });
});
