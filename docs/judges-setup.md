# Canon: setup notes for judges and admins (draft)

Canon runs entirely on Atlassian (Forge). It needs Jira (required) and Confluence (connected during install).

## 1. Install
1. Open the installation link and install Canon on your site for **Jira**, then add **Confluence** when prompted (both products on the same site).
2. Approve the scopes. Reads: `read:page:confluence`, `read:confluence-content.summary`, `read:space:confluence`, `read:jira-work`, `read:jira-user`. Writes: `write:jira-work` (the `canon.gate` issue property for JQL, evidence attachments, sample work items), `write:page:confluence` (used **only** by *Load sample data* / *Publish sample v4* to create the sample page), `storage:app`.
3. Open **Jira settings → Marketplace apps → Canon setup**. The setup checklist (section 7) tells you what is still missing.

*Installing from the command line instead of the link:* run `forge install -e production --site <site> --product jira`, then the same with `--product confluence`; Canon needs scopes in both products. (Checked on a clean site on 28 Nov 2026.)

## 2. Give Canon access to your procedure space (important)
Canon reads Confluence **as the app**. In our testing the app could **not** see spaces that already existed before it was installed: page reads returned 404 and no page events arrived. Spaces created **after** install worked at once.

Pick one:
- **Recommended for judging:** create a new Confluence space (after installing Canon; **any new space works at once**, no permissions step needed) and a **company-managed** Jira Software project (when you create the project, choose a Kanban or Scrum template and make sure its type is *company-managed*, not team-managed; the sample loader and the workflow steps below assume it). Then open **Jira settings → Apps → Canon setup → Sample data**, enter the two keys and click **Load sample data**. It creates *SOP-PAY-014 … [Sample data]* v1–v3 (approved), 4 `[Sample]` work items with bindings, and an auto-bind mapping for `<PROJECT>/Task` (only if you have none). Rerunning it is safe. If it ever answers *Something went wrong. Try again.*, wait a few seconds and click it once more; a failed attempt can leave a few extra `[Sample]` work items and an extra sample page (harmless; delete them). If the page title is already taken, the loader adds a UTC timestamp to the title, so it may read, for example, *… [Sample data] (2026-11-28 11:48 UTC)*.
- **Use an existing space:** in Confluence, open *Space settings → Users → Add people and agents* for the procedure space. Search for "Canon": it lists **canon** and **Canon Procedure Guard** (type: App). Add both apps, each with a role of at least *view* access, then click *Add*. (Verified in the browser on 22 Nov 2026 (IST); Confluence now uses roles, not the older *Permissions → Apps* page.) Then open a procedure page: the Canon byline should show "not controlled", not "Canon can't read this page".

If Canon can't read a page, the byline says *"Canon can't read this page. Ask an admin to give the Canon app access to this space."*, and the Jira gate **blocks** (fails closed). It never silently allows.

## 3. Add the gate to a workflow
**Jira settings → Work items → Workflows** → find the project's workflow (a new software project uses *Software Simplified Workflow for Project <KEY>*) → **Actions → Edit** → click the **Any** badge on the **Done** transition (in a new software project it is a single global transition into Done) → **Rules → Validate details → Canon gate** → *Update*, then **Publish** the workflow if Jira shows a draft banner. (Checked in the browser on a fresh site, 28 Nov 2026.) Do this for every transition into Done that you want guarded. Leave the validator's configuration empty.

Forge apps can't read workflow configuration without an admin-level scope, so the setup checklist instead reports when the gate **last ran** (it records a heartbeat on each Done attempt, at most every 10 minutes). After adding the validator, try one Done transition on any work item and re-run the checks. A work item that is **not bound** to a procedure is allowed through Done **by design** (Canon gates bound work only); if Canon can't verify a bound item, Done is blocked.

## 4. Open the Canon panel on a work item
Forge issue panels are **not shown by default**. On a work item, click the **apps icon** just under the work item title (next to the **+** button), then choose **Canon**. Do this on any work item where you don't see the panel; the ••• menu has no Canon option. (Checked in the browser on a fresh site, 28 Nov 2026.)

(Demo site only: the panel is already pinned for project **CHG** through Jira's issue-panel pin API, so no action is needed for CHG work items.)

## 5. Approvals and sign-off need a second person
- **Approve vN** is refused for the person who last edited the page (separation of duties). On a single-user trial site, use the sample-data helper **Publish sample v4**. It publishes as the Canon app, so you can approve it yourself.
- **Sign-off on the re-attestation also needs a different person.** The implementer completes the changed items, and a *checker* signs. The checker must be another Jira user who can browse the work item, and **a one-person site cannot complete a sign-off** (the independent-approver rule can't be switched off in the UI). Before the demo, invite a second user to the site and give them access to the project (*Project settings → Access/People → Add people*). Without a second user you can still see everything up to the blocked Done, the Rovo explanation, the checklist and the evidence tab, and a project admin can close the work with **Break-glass override** (reason of at least 20 characters, audited).

## 6. Known platform behaviour
Confluence Cloud does not keep the "minor edit / don't notify watchers" flag on saved versions; it always reads back as `false`. Under the `every-major` policy, Canon therefore decides with its own diff: typo-only edits are **not** auto-approved and do not supersede tickets.

## 7. Setup checklist (Jira settings → Marketplace apps → Canon setup)
Jira admins only. Each check is OK, CHECK or FIX, with the fix shown inline:
| Check | OK when | Fix |
|---|---|---|
| Confluence connected | Canon can reach Confluence as the app | Install Canon in Confluence on the same site |
| Procedure space access | Every controlled procedure is readable by Canon | Space settings → Users → Add people and agents → "Canon" → role → Add, or load sample data into a new space |
| Canon gate | The gate has run on a Done transition | Add the **Canon gate** validator to Done, then try one Done |
| Policy | Shows revision policy, Block/Warn mode, independent approver | Switch Warn to Block to enforce |
| Auto-bind | Every mapping points at a controlled procedure | Mark the page controlled or change the mapping |
| Procedures | Count of controlled procedures and open bindings | — |

The same page edits gate settings (Block/Warn, revision policy, auto-bind mappings) and holds **Load sample data** / **Publish sample v4**.

## 8. Roles, and where things are
- **Canon setup** (Jira settings → Marketplace apps → Canon setup): Jira administrators only.
- **Break-glass override** and **Attach evidence pack**: project admins, meaning the user has *Administer Projects* on the project (normally through the project's **Administrators** role: Project settings → Access / People → add the user with role *Administrators*). Jira admins are accepted too. In Jira Cloud, being a Jira admin does not by itself grant *Administer Projects*.
- **Canon register:** open the project, then the top tab bar → **More → Canon register** (it is not in the sidebar).
- **Reset sample data** (Canon setup → Sample data): retires the current sample work items (their bindings are closed with a `SAMPLE_RESET` audit event), renames the old sample page, and loads a fresh v1–v3 page with new work items, so the v3 → v4 demo can be replayed.

## 9. Restricted procedures (by design)
The gate checks **the procedure version**, not whether the person clicking Done can open the page. It runs as the Canon app:
- Work bound to the **current** approved version may move to Done even if the user can't open the procedure. The panel shows *Procedure restricted* (no title, versions or changes).
- If a **newer approved version** exists, Done is **blocked** for everyone. The message names no procedure, and re-attestation needs someone who can read the changes.
- If **Canon itself** can't read the page (no space access, deleted page, Confluence error), Done **fails closed**.
Page restrictions decide who may *read* the procedure. They don't decide who may close work that already follows the approved version.

## 10. Rovo: how write actions are confirmed
Creating the re-attestation checklist and assigning a checker are write actions. Rovo always shows a **confirmation card** for them, and they run only when you click **Confirm** on that card. Typing "yes" in the chat isn't enough; this is Rovo's own safety step for app actions that change data, and Canon keeps it. The agent tells you to click Confirm. Asking again after creation returns "already created" and doesn't duplicate anything. The Canon panel picks up the new checklist by itself: it re-reads when you select the Attest or Evidence tab, checks every few seconds after *Ask Canon* (up to 5 minutes) and while a work item waits for re-attestation, and refreshes when you come back to the page. If the items still aren't shown, click the Attest tab again or reload the page.

## 11. Clean-install verification log
Run on a fresh developer site on 28 Nov 2026 (IST) with the **production** deployment (Forge app version 2.0.0; the repository's package.json version is unrelated), following these notes as far as the CLI and REST allowed:
- Install into Jira and Confluence: OK.
- A Confluence space created after install: Forge function logs show the `avi:confluence:created:page` event reaching Canon about 2 s after the page was created (no permissions step).
- A company-managed project with the **Canon gate** validator on Done: a Done move on an unbound work item was allowed (Forge log: `canon-gate … result:true, reason:no-binding, totalMs:535`).
- The steps that only work in the browser (Canon setup page, Load sample data, Publish sample v4, byline Approve, panel) are the ones listed in sections 1 to 5.

