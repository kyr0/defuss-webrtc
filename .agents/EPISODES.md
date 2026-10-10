# Episodes

<!-- Newest last. The gate appends FAIL|DONE|FINDING; past 100 entries it trims only its own oldest DONE|FAIL|learned
FINDING (git keeps them). Leads (LESSON, FINDING learn=none) stay until wrap settles them; doctor fails above 30.
Agents append `<UTC ISO> s=<session> LESSON <VAE-DIALECT>` only for a falsified HYPOTHESIS, a dead end, or a root cause.
Session start injects the 3 newest open entries: LESSON, FINDING learn=none, FAIL without a later DONE.
Wrap: EVERY lead → test | .agents/VERIFY.py rule | one MEMORY line with BC, then delete; OR delete BC evidence. -->

2026-10-10T12:50:18Z s=ff2eba73 FAIL lint,tests.unit,tests.e2e.1,coverage
2026-10-10T13:04:26Z s=ff2eba73 DONE fp=9ac8374a04de cov=82.3% paths=.github/workflows/verify.yml,.oxlintrc.json,AGENTS.md,Makefile(+5)
2026-10-10T13:04:26Z s=ff2eba73 FINDING src/crdt/document.ts:3-4 learn=verifier: make lint (oxlint --deny-warnings) runs on every gate and in CI
2026-10-10T13:04:26Z s=ff2eba73 FINDING docs/app.js:699 rejoin catch learn=verifier: make lint (oxlint --deny-warnings) runs on every gate and in CI
2026-10-10T13:04:26Z s=ff2eba73 FINDING Makefile:COVER learn=none: encoded with its reason at the only call site (Makefile COVER); a rule pinning the flag would only pin config
2026-10-10T13:23:58Z s=ff2eba73 DONE fp=c66f47ae0cb0 cov=82.3% paths=.github/workflows/pages.yml,.github/workflows/verify.yml,.oxlintrc.json,AGENTS.md(+8)
