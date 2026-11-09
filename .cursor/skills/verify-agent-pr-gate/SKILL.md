---
name: verify-agent-pr-gate
description: Drive agent-pr-gate the way a maintainer checks a verdict. Use after changing solo mode, the decision, or the PR comment. Builds the action and runs the solo fixture suite.
---

# Verify agent-pr-gate

The user-facing surface is the `agent-pr-gate check` CLI and the PR comment. This repo has no GitHub token in local verification, so the proof drives `decide` and `renderComment` through `test/solo.test.ts`. That is the same code the action and the CLI call.

## Launch

From the repository root, with dependencies installed (`npm ci`):

```sh
npm run build
bash .cursor/skills/verify-agent-pr-gate/verify-solo.sh
```

Ready means the script prints `verify-solo: ok` and exits 0. There is no long-running server.

## Doctor

```sh
node -v
test -f dist/index.js && test -f dist/cli.js && echo 'bundles present'
```

Run doctor when a check fails before you trust the suite. The bundles must exist. The script does not need `GH_TOKEN`.

## Drive

`verify-solo.sh` runs:

```sh
npx vitest run test/solo.test.ts
```

The suite is the fixture payload. It covers team default, solo with one owner, missing evidence, red CI, a second maintainer, `routing.owners`, a CODEOWNERS team, a missing CODEOWNERS file, a fork author, a cut-off file list, an unknown `mode`, and head config that must not override the base `mode`.

## Evidence

The script writes `.cursor/skills/verify-agent-pr-gate/evidence/solo.txt`. That file is the vitest transcript. A pass is `verify-solo: ok` at the end and exit code 0. A failure leaves the vitest output in the same file and a non-zero exit.

## Cleanup

The script does not start a process that stays up. Do not delete `evidence/solo.txt` after a run. That file is the proof.

## Helpers

`.cursor/skills/verify-agent-pr-gate/verify-solo.sh` is the only helper. Run it from the repository root after `npm run build`.
