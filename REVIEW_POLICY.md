# Review policy

This policy says how PRs to this repository are reviewed, by people and by review agents.

## Review rounds

- A PR gets at most 2 review rounds. The limit covers human reviews and agent reviews alike. A round is one full review pass and the fixes that answer it.
- After round 2, the PR fixes only blockers. A blocker is one of two kinds:
  1. Main-path correctness: the gate gives a wrong verdict, or fails, on an ordinary PR. An ordinary PR has a normal description, ordinary files, normal CI, and normal reviews.
  2. Security: a way for a PR or its author to bypass the gate's rules, raise its own trust, leak a token, or run untrusted code with write access.
- Every other finding becomes a follow-up issue. Examples are hardening against adversarial input, edge cases off the main path, performance, rate-limit tuning, refactors, docs, and style. File each one with the `follow-up` label, the file and line, what is wrong, and the proposed fix. Link the issue to the PR it came from. The PR description lists the open follow-ups.
- A real finding is never dropped. Either the PR fixes it, or an issue records it.
- After round 2, the PR is either approved or explicitly re-scoped. It doesn't get a third round of new findings.

The gate counts rounds only from GitHub reviews: a `CHANGES_REQUESTED` review by a trusted human, after which the head moved. A review posted as a plain comment doesn't count, so this policy, not the gate, keeps the limit for reviews that arrive as comments. The round cap never changes pass or fail on its own.

## This repository's dogfood setup

The rest of this file is specific to this repository. Other repositories don't need it.

### The dogfood gate job is not a required check

`.github/workflows/gate.yml` runs this repository's own action from the PR checkout (`uses: ./`), so a PR's own code judges that PR. The job is a smoke test, not a trustworthy gate, so it is not a required check. A red gate status doesn't block a merge on its own. The merge criterion is a green `CI` workflow (`.github/workflows/ci.yml`) plus this policy. If branch protection is turned on, make `CI` required. Leave the dogfood job out until it runs a reviewed commit from `main`.

### Single maintainer

The repository has one maintainer, so `.review-gate.yml` sets `rounds.cap: 2` to match the limit above, and turns on `routing.owner_override` for the maintainer, limited to the low and medium tiers. Agents open PRs under the maintainer's account, so the limits matter:

- The maintainer's own low-tier and medium-tier PRs need no approving review.
- High-tier PRs, and PRs that change gate-control files, are never waived. Gate-control files include the gate config, CODEOWNERS, workflows, `action.yml`, and `dist/`. Those PRs need approvals like any other PR, which on this repository means an admin merge after a manual review.
- Evidence, green CI, and the round cap always apply.
- PRs from anyone else need approvals as usual.

The gate reads its config from the base branch. A PR that changes the config is judged by the config on `main`, not by its own.
