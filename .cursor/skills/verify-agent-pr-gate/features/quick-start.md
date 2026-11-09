# Quick start

## Sub-features

- Copy one workflow.
- Pin the action to the v1.0.4 commit.
- Require the `agent-pr-gate` status.

## How to get to it (user POV)

Open the README. The first section after the opening sentence is Quick start. No `.review-gate.yml` is required.

## Driving it with the solo fixture suite

The workflow file is documentation. The behavior it turns on is the default team verdict. `test/solo.test.ts` asserts that a config with no `mode` still blocks a high-tier pull request that has no approvals.

## Gotchas

The pin comment says `v1.0.4`. The SHA is the release commit `1cbe48bc4c397dd4f23ba6f47fdd6db6774f34de`. `@v1` is mentioned as a shorter option and is not the recommended pin.
