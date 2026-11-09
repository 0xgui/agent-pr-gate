# Fork pull requests

## Sub-features

- The main workflow is enough for same-repository pull requests.
- `examples/review-relay.yml` and `examples/recheck.yml` are optional.

## How to get to it (user POV)

Read the Fork PRs section in the README Quick start. Do not copy those files unless the repository accepts forks.

## Driving it with the solo fixture suite

The fork case is `does not apply solo to a fork author who is not the listed maintainer` in `test/solo.test.ts`. The author is `forkuser` and the maintainer is `0xgui`. The verdict stays blocked.

## Gotchas

A fork can delete the relay. The recheck workflow is the backstop and is not part of the quick start.
