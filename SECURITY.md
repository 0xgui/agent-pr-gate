# Security policy

## Report a vulnerability

Report vulnerabilities through GitHub private vulnerability reporting: open the repository's **Security** tab and select **Report a vulnerability**. Don't open a public issue, PR, or discussion for a vulnerability.

Include:

- what an attacker can do, for example pass the gate without the required approvals, or get a write token to run PR code,
- the steps or the PR description and config that show it,
- the version or commit SHA of the action you tested.

## What counts

These are in scope:

- A way for a PR or its author to pass the gate without meeting its rules, or to raise its own tier of trust.
- A way to make the gate run untrusted code, or leak its token.
- A way to make the gate edit or post comments as another identity.

A wrong verdict on an unusual PR description is usually a bug, not a vulnerability. Open a normal issue for it.

## Supported versions

Only the latest commit on `main` gets fixes. There are no tagged releases yet.
