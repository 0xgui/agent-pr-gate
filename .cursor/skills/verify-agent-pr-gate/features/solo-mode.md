# Solo mode

## Sub-features

- `mode: solo` on the base config.
- High tier with one listed owner passes when evidence and CI pass.
- A second owner, a CODEOWNERS team, a fork author, red CI, or empty evidence still blocks.
- Head config cannot turn solo on.

## How to get to it (user POV)

Add `mode: solo` to `.review-gate.yml` on the default branch. Open a high-tier pull request as that maintainer. The comment says `Solo mode: applied` when the waiver happens.

## Driving it with the solo fixture suite

```sh
bash .cursor/skills/verify-agent-pr-gate/verify-solo.sh
```

Observable end state: vitest prints the passing cases, and `evidence/solo.txt` contains `verify-solo: ok` only if the shell echo ran. The vitest summary in that file shows the case count.

## Gotchas

This repository's own `.review-gate.yml` does not set `mode: solo`. A missing CODEOWNERS file does not block when solo applies and the author is the only maintainer. An incomplete file list still blocks.
