## Summary

- what changed
- why it changed

## Verification

- [ ] `node scripts/check-workflow-terminology.mjs`
- [ ] `cd api && npm run lint`
- [ ] `cd api && npm test` (needs `AGENT_HQ_TEST_PG_URL`)
- [ ] `cd api && npm run build`
- [ ] `cd ui && npm run verify`
- [ ] `cd ui && npm run build`
- [ ] `npm run test:cli`
- [ ] docs-only change

## Risks

- user-facing impact
- migration or compatibility concerns
- follow-up work, if any
