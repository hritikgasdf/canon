# Canon: setup notes for judges and admins (draft)

Canon runs entirely on Atlassian (Forge). It needs Jira (required) and Confluence (connected during install).

## 1. Install
1. Open the installation link and install Canon on your site for **Jira**, then add **Confluence** when prompted (both products on the same site).
2. Approve the read-only scopes: `read:page:confluence`, `read:confluence-content.summary`, `read:jira-work`, `storage:app`.

## 2. Give Canon access to your procedure space (important)
Canon reads Confluence **as the app**. In our testing the app could **not** see spaces that already existed before it was installed: page reads returned 404 and no page events arrived. Spaces created **after** install worked at once.

Pick one:
- **Recommended for judging:** use **Canon settings → Load sample data** and let it create a new space and project. Everything is pre-wired.
- **Use an existing space:** in Confluence, open *Space settings → Permissions → Apps* for the procedure space and add **Canon** with *View* permission (exact menu path still to be confirmed in the browser check). Then open a procedure page: the Canon byline should show "not controlled", not "Canon can't read this page".

If Canon can't read a page, the byline says *"Canon can't read this page. Ask an admin to give the Canon app access to this space."*, and the Jira gate **blocks** (fails closed). It never silently allows.

## 3. Add the gate to a workflow
Canon's setup page checks this for you. To do it by hand: Jira workflow editor → the transition to Done → **Rules → Validate details → Canon gate**.

## 4. Approvals need a second person
"Approve vN" is refused for the person who last edited the page (separation of duties). On a single-user trial site, use the sample-data helper **Publish sample v4**. It publishes as the Canon app, so you can approve it yourself.

## 5. Known platform behaviour
Confluence Cloud does not keep the "minor edit / don't notify watchers" flag on saved versions; it always reads back as `false`. Under the `every-major` policy, Canon therefore decides with its own diff: typo-only edits are **not** auto-approved and do not supersede tickets.
