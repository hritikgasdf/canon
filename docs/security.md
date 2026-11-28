# Canon: security and privacy checklist (plan item 39)

Every line below is checked against the code in this repository. Items tagged **[test]** are enforced by a unit
test (so this page cannot drift from the manifest or code); **[docs]** means we rely on documented Atlassian
behaviour and did not re-test it; **[manual]** means it was checked on the demo site by hand.

## 1. Egress and hosting
- [x] **No egress.** `manifest.yml` has no `permissions.external` block and no `remotes`. The only network calls are
      `@forge/api` `requestJira` / `requestConfluence` to the host site. No `fetch(`, no absolute URLs in `src/`. **[test]** (`manifest.test.ts`)
- [x] **No webtrigger, no dev harness in the submitted build.** `npm run release:check` fails if one is present, and the
      production manifest test fails too. See `docs/release.md`. **[test]**
- [x] **Runs on Atlassian.** Hosting, storage and compute are all Forge; verified with `forge eligibility` at release time (see `docs/release.md`).
- [x] **No secrets in the repo.** There are no API keys, tokens or passwords in the tree. The only variable the dev build used
      (`CANON_DEV_SECRET`, an encrypted Forge variable) belongs to the dev overlay, which is not in the repo, and the release check
      fails on any reference to it. **[test]**

## 2. Scopes (least privilege)
The manifest requests exactly these scopes. `manifest.test.ts` pins the list and checks each one is explained here. **[test]**

| Scope | Why Canon needs it | Used as |
|---|---|---|
| `read:page:confluence` | Read the procedure page, its versions and its storage-format body to diff versions | app (gate, events, Rovo) and user (view check) |
| `read:confluence-content.summary` | Required by Atlassian for the page created/updated/archived events Canon subscribes to | events |
| `read:space:confluence` | Find the space id for Load sample data; setup page connectivity check | app |
| `read:jira-work` | Read the work item, its permissions (`mypermissions`, visibility search), attachments and the `canon.gate` property | app and user |
| `read:jira-user` | Display names for account ids; the "can this account browse the work item" check for checker assignment | app |
| `write:jira-work` | Write the `canon.gate` issue property (JQL search), attach evidence files, and create/transition the four **sample** work items | app |
| `write:page:confluence` | **Only** Load sample data / Publish sample v4 (create and update the sample procedure page). Never used on a page the admin controls | app |
| `storage:app` | Forge KVS: procedures, bindings, snapshots, deltas, attestations, audit chain, settings | app |

Not requested: `manage:jira-configuration`, `read:jira-configuration`, any admin scope, `write:confluence-content`, any `delete:*`.
Trade-off: because Canon cannot read workflow configuration, the setup page reports when the gate last ran (heartbeat) instead of reading the workflow.

## 3. Authentication and authorisation
- [x] **The acting user never comes from user input.** Resolvers use `context.accountId`; Rovo actions use
      `context.principal.accountId` (`actorFromContext`). The work item key for Rovo comes only from `payload.context.jira.issueKey`
      and must match a Jira key pattern. Action inputs such as `checkerAccountId` or `bindingId` are data, never identity. **[test]** (`invocationContext.test.ts`, `rovo.test.ts`)
- [x] **Page access is checked as the viewer.** Byline, panel, delta, Rovo explain and evidence only show a procedure if the *user* can view
      the Confluence page (`canUserView`, `asUser`). Titles and text of hidden pages are never listed or returned. **[test]** (`visibility.test.ts`, `rovo.test.ts`, `issueView.test.ts`)
- [x] **Work item visibility** for the register uses the user's own search (issue security aware) and fails closed to "hidden". **[test]** (`visibility.test.ts`)
- [x] **Admin-only actions** (break-glass override, attach evidence, setup page) check `ADMINISTER_PROJECTS` / `ADMINISTER` as the user and fail closed on any error. Break-glass also needs a 20 to 1000 character reason and is audited before it takes effect. **[test]** (`override.test.ts`, `overrideResolver.test.ts`, `adminResolver.test.ts`)
- [x] **Separation of duties** is enforced in the domain code, not the UI (default **on**; an admin can switch the independent-approver requirement off in Canon setup, and the setup page shows its state): the person who last edited a page cannot approve that version, the implementer cannot be their own checker, cannot sign, and cannot mark items not material, and only the assigned checker can sign (who must also not have completed any item). **[test]** (`attest.test.ts`, `approve.test.ts`, `attestService.test.ts`)

## 4. Fail-closed gate
- [x] The workflow validator (`canon-gate`) returns `result: true` only when every binding is current, the work item has no binding, or policy is warn-only.
- [x] Any exception, missing issue key, **5 s timeout**, or unreadable procedure returns `result: false` with a fixed message (`GATE_FAIL_CLOSED`) that names no procedure. **[test]** (`forgeGate.test.ts`, `gateEval.test.ts`, `gateRun.test.ts`)
- [x] The gate checks the live version **as the app**, so a user who cannot see the page cannot dodge it, and learns nothing from the block message.
- [x] The heartbeat (setup page) is best-effort and bounded to 300 ms; it can never change the gate outcome. **[test]** (`gateHeartbeat.test.ts`)
- [x] Under *approved-only* (the default policy) a newer live version that is still a draft never blocks or supersedes; it counts only once approved, and with independent approval on, the approver cannot be the page's last editor. **[test]** (`approve.test.ts`, `supersede.test.ts`)
- [x] Uninstall: Atlassian documents that a workflow validator whose app is uninstalled **evaluates to false**, i.e. it blocks, rather than silently allowing. Admins should remove the Canon rule from the workflow before uninstalling. **[docs]** (documented for validators in the Forge module reference; not re-tested on a second site). Canon leaves nothing else in Jira configuration: the `canon.gate` issue properties and attached evidence files remain as ordinary Jira data.

## 5. Rovo agent: reads and confirmed writes only
- [x] The agent can **never attest, sign, approve, override or mark Done**. No action exposes those operations. **[test]** (`manifest.test.ts`)
- [x] The two write actions (`canon-create-reattest-checklist`, `canon-assign-checker`) are declared `CREATE` / `UPDATE`, so Rovo shows its **Confirm card** and runs them only after a click. A typed "yes" never runs an action. **[test]** (`manifest.test.ts`), **[manual]** (browser check, `docs/judges-setup.md` section 10).
- [x] Even after confirmation the domain re-checks everything. Creating the checklist writes only suggested task text plus an audit event (the confirming user becomes the implementer if re-attestation had not started; it needs the procedure to be visible to that user and every item id to exist in the delta). Only the implementer can assign a checker; the checker must differ from the implementer and be able to browse the work item; an existing checklist's suggestions are never overwritten. **[test]** (`rovo.test.ts`)
- [x] The MCP server (`rovo:mcp`) exposes only the two `GET` actions. **[test]**
- [x] Error text from KVS or Confluence is never passed to the model: failures return a fixed "UNVERIFIED" message and the detail goes to the log (`rovoActions.ts`; code-reviewed, not separately tested).
- [x] The approved-procedure tool returns **approved** text only, never a draft or superseded version, capped at 200 nodes. **[test]**

## 6. Data stored, privacy and PII
- [x] All data lives in Forge KVS on the customer's site (`storage:app`); nothing leaves Atlassian.
- [x] **People are stored as Atlassian account ids only.** No emails, no names. Display names are looked up at render time and are not stored. Sample-data personas use `sample:` ids that match no real account.
- [x] The audit log is an append-only SHA-256 hash chain; the evidence export verifies it. **[test]** (`audit.test.ts`, `evidence.test.ts`)
- [x] **Evidence files attached to a work item are redacted**: every issue viewer can read an attachment, so the attached JSON and HTML keep only ids, numbers and hashes (a fixed allow-list of payload keys) and drop procedure text, titles, notes and override reasons. The full detail is only shown in the panel to viewers who can see the procedure, and attaching is admin-only. **[test]** (`evidence.test.ts`)
- [x] Logs contain issue keys, outcome codes, counts, timings and error messages, not procedure text, notes, or user names.
- [x] KVS keys are validated against a strict pattern and ids may not contain `:` (no prefix collisions). **[test]** (`kvsRepos.test.ts`)
- [x] Requests that put ids in URLs use the `route` template (escaping) and `encodeURIComponent`.
- [x] The UI uses only Forge UI Kit components (no raw HTML, no `dangerouslySetInnerHTML`), so procedure text from Confluence cannot inject markup.
- [x] **Data deletion.** Uninstalling the app deletes its Forge storage (per Atlassian) **[docs]**. See README for what remains in Jira (properties, attachments).

## 7. Known limits (stated plainly)
- The gate relies on the Canon app being able to read the procedure space; spaces that existed before the install need the Canon app added (see `docs/judges-setup.md` section 2). If it cannot read the page, Done is blocked.
- `write:page:confluence` is requested solely for the optional sample-data helper. A production customer could decline sample data, but the scope is still part of the install consent.
- Scopes and the gate were verified on one demo site and one installation (plus the clean-install test described in `docs/release.md` when run). No third-party penetration test was done.
