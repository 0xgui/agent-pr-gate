#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
mkdir -p .cursor/skills/verify-agent-pr-gate/evidence
npx vitest run test/solo.test.ts | tee .cursor/skills/verify-agent-pr-gate/evidence/solo.txt
echo 'verify-solo: ok'
