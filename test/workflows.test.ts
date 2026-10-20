import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// The gate skips its own check run by job ID (and by its status context). A scheduled re-check
// must use the same job ID as the event workflow, or it would count the event job's failed check
// as failing CI. The job ID must also differ from the status context, so requiring the status
// context in branch protection cannot match the job check, which passes on stale runs.
const gateJobs = (file: string): string[] => jobsIn(readFileSync(file, 'utf8'));
const jobsIn = (text: string): string[] => {
  const wf = parse(text) as { jobs: Record<string, { steps: { uses?: string }[] }> };
  return Object.entries(wf.jobs)
    .filter(([, job]) => job.steps.some((s) => /agent-pr-gate@|^\.\/?$/.test(s.uses ?? '')))
    .map(([id]) => id);
};

describe('gate workflows', () => {
  it.each(['examples/workflow.yml', 'examples/recheck.yml', '.github/workflows/gate.yml'])('%s runs the gate in a job named "agent-pr-gate-job"', (file) => {
    expect(gateJobs(file)).toEqual(['agent-pr-gate-job']);
  });

  it('the README setup example uses the same job ID', () => {
    const readme = readFileSync('README.md', 'utf8');
    const block = /```yaml\n([\s\S]*?pull_request_target[\s\S]*?)```/.exec(readme.replace(/^\t/gm, ''))![1]!;
    expect(jobsIn(block)).toEqual(['agent-pr-gate-job']);
  });
});

