# CLI gist

<!-- Commands future agents need that the Makefile verbs do not cover (setup, env, data, deploy):
- VERIFIED[purpose] `cmd`: only after an observed success
- UNKNOWN[purpose] BC gap
Budget 2 KiB (`vae.py doctor --repo .`); entries are injected at session start. -->
- VERIFIED[serve the site] `bun run dev`: bunx serve of docs/ on :3000, else the free port it prints; stop it by port (`lsof -t -iTCP:<port> -sTCP:LISTEN | xargs kill`), since pkill on "serve@14.2.6" misses its node child
