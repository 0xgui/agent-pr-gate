# Quick start

## Sub-features

- Copy one workflow.
- Pin the action to the v1.0.5 commit.
- Require the `agent-pr-gate` status.

## How to get to it (user POV)

Open the README. The first section after the opening sentence is Quick start. No `.review-gate.yml` is required.

## Driving it with the solo fixture suite

The workflow file is documentation. The behavior it turns on is the default team verdict. `test/solo.test.ts` asserts that a config with no `mode` still blocks a high-tier pull request that has no approvals.

## Gotchas

The pin comment says `v1.0.5`. The SHA is the release commit `2a781f1a0018f01e121f292951432c7ea84168c2`. `@v1` is mentioned as a shorter option and is not the recommended pin.
