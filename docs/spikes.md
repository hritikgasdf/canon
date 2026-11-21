# W0 spikes — measured on the Codegeist demo site (21 Nov 2026, IST)

Site: one-atlas-jpxz.atlassian.net (demo site, expires 2027-02-19). App id 12bf2743-b147-41da-9c66-4f171fa7bdfd, environment `development`, installation be903fa3-f9ca-407a-9aef-59e1a675c1dd (Jira required + Confluence connected).

## B1 — Confluence page-update events (item 3)
5 REST edits ~20 s apart on page 3637264 (space OPSCP), trigger `avi:confluence:updated:page`, `updateTrigger` = `edit_page`.

| version | lag from version.when (ms) | lag from eventCreatedDate (ms) |
|---|---|---|
| 2 | 1099 | 978 |
| 3 | 1324 | 1214 |
| 4 | 768 | 670 |
| 5 | 1563 | 1466 |
| 6 | 1032 | 911 |

min 768 · median 1099 · max 1563 ms (all 5 delivered). Docs allow up to 3 min, so the live check in the gate stays.

**Finding:** pages in spaces that existed before install (seeded ITO space) were invisible to the app: no events and `GET /wiki/api/v2/pages/{id}` as app returned 404. A space created after install (OPSCP) worked immediately. Setup docs must tell admins to give Canon access to the procedure space (or create a new one).

## B2 — Canon gate validator (item 4)
`jira:workflowValidator` (function) on CHG "Done" transition (added via `POST /rest/api/3/workflows/update`, rule `forge:expression-validator` + extension ARI). Binding stored in issue property `canon-binding`; live `requestConfluence` page version as app. 10 transitions per case via REST.

| case | result | server totalMs median / p95 | client round trip median / p95 |
|---|---|---|---|
| no binding | allowed 10/10 | 250 / 484 | 2141 / 2553 |
| current (bound v6 = live v6) | allowed 10/10 | 473 / 734 | 2435 / 3317 |
| superseded (bound v3, live v6) | **blocked 10/10** | 445 / 623 | 1847 / 2305 |
| forceError | **blocked 10/10 (fail closed)** | 239 / 267 | 1664 / 2016 |
| missing page (404) | **blocked 10/10 (fail closed)** | 454 / 706 | 1943 / 2125 |
| malformed binding | **blocked 10/10 (fail closed)** | 248 / 273 | 1585 / 1921 |

All 60 server-side runs: median 429 ms, **p95 541 ms**, max 734 ms (target 2.5 s). Confluence call median 210, p95 291 ms. Client round trip = REST from the build box incl. Jira's own transition work (baseline with no external calls is ~2.1 s).

Race test: page edited to v7, Done attempted ~0 s later on an issue bound to v6 → **blocked** ("revised v6 → v7"), 1.9 s round trip.
