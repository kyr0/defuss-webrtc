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
2026-10-10T16:42:07Z s=870f0a59 FAIL env.example,package
2026-10-10T17:02:48Z s=870f0a59 DONE fp=2edd79cd0c78 cov=82.3% paths=.oxlintrc.json,README.md,ROADMAP.md,docs/README.md(+15)
2026-10-10T17:02:48Z s=870f0a59 FINDING docs/index.html:#playground (Teaser) learn=memory: external release gap, recorded in .agents/MEMORY.md and ROADMAP.md; not checkable in this repo
2026-10-10T17:02:48Z s=870f0a59 FINDING serve.json:1 learn=memory: config of a dev convenience, fixed at its only site; the stop-by-port lesson is in .agents/CLI_GIST.md
2026-10-10T17:02:48Z s=870f0a59 FINDING docs/index.html:#flow-manual createOffer edge learn=none: prose accuracy of one sentence; no mechanical check distinguishes it
2026-10-10T17:02:48Z s=870f0a59 FINDING docs/README.md:62 P09 learn=none: page wording; the prose checker covers the catalog
2026-10-10T17:02:48Z s=870f0a59 FINDING e2e/browser/site.spec.mjs two-peer test learn=test: the spec's problem tracker catches any recurrence
2026-10-10T17:02:48Z s=870f0a59 FINDING docs/demo/app.js:connectPeer / MANUAL_DOC_ID learn=test: chat.spec.mjs 'two peers connect by swapping PEER.json files, then chat without a server' fails if manual peers cannot chat
2026-10-10T17:02:48Z s=870f0a59 FINDING docs/demo/index.html:ol.steps first item learn=test: site.spec asserts aria-current on the Mode step at load in both frames
2026-10-10T17:02:48Z s=870f0a59 FINDING docs/demo/app.js:applyNickname learn=test: chat.spec reload test waits for 'Nickname set to' after the reload
2026-10-10T17:09:46Z s=870f0a59 DONE fp=a857b34348e1 cov=82.3% paths=.oxlintrc.json,README.md,ROADMAP.md,docs/README.md(+15)
2026-10-10T17:21:13Z s=870f0a59 DONE fp=9d74f8a8c05b cov=82.3% paths=.oxlintrc.json,README.md,ROADMAP.md,docs/README.md(+15)
2026-10-10T17:21:13Z s=870f0a59 FINDING README.md:How it works T07 learn=none: diagram legibility is judged on the rendered image; no mechanical check
2026-10-10T18:29:15Z s=870f0a59 DONE fp=3644ebb5b013 cov=82.3% paths=.oxlintrc.json,README.md,ROADMAP.md,docs/README.md(+16)
