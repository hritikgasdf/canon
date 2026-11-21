# Releasing the submitted build (plan item 39)

The repository never contains the dev harness. `src/forge/devHarness.ts` is gitignored, and the
DEV-ONLY webtrigger is added only by the local `deploy-dev.sh` overlay, in a throwaway copy, for the
**development** environment. The submitted build is deployed from a clean checkout:

```bash
rm -rf /tmp/canon-release && mkdir /tmp/canon-release
git archive main | tar -x -C /tmp/canon-release
cd /tmp/canon-release && npm ci
npm run release:check          # fails if a webtrigger, harness export or harness file is present
npm test && npm run typecheck && npm run lint
forge lint
forge deploy -e production --non-interactive
forge install -e production --site <judging site> --product jira     # then add Confluence
forge eligibility -e production   # expect: eligible for Runs on Atlassian (no webtrigger, no egress)
```

`test/manifest.test.ts` also asserts that the production manifest has no webtrigger, so CI fails if one is
ever committed. The development environment keeps the harness (and its encrypted `CANON_DEV_SECRET`
variable); the production environment has neither.
