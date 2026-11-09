# Fork pull requests

## Sub-features

- The main workflow is enough for same-repository pull requests.
- `examples/review-relay.yml` and `examples/recheck.yml` are optional.

## How to get to it (user POV)

Read the Fork PRs section in the README Quick start. Do not copy those files unless the repository accepts forks.

## Driving it with the solo fixture suite

Two fork cases stay blocked. One lists `0xgui` as maintainer while the author is `forkuser`. The other has no CODEOWNERS file and empty owner lists, and the author is not the repository owner. The verdict stays blocked with `author is not a listed owner`.

## Gotchas

A fork can delete the relay. The recheck workflow is the backstop and is not part of the quick start.
