# Canon: version-pinned procedure gate for Jira + Confluence (Forge)

Canon pins the approved Confluence procedure version a Jira change started under. If the procedure is revised while the ticket is open, Canon blocks the Done transition until the material changes are re-attested.

## Setup (read first)
See **[docs/judges-setup.md](docs/judges-setup.md)**. Most important: **Canon must have access to the procedure space.** Spaces that existed before install are invisible to the app until an admin adds Canon in *Space settings → Users → Add people and agents* (search "Canon", add **canon** and **Canon Procedure Guard**, each with at least view access). The other way is to create a new space after install and use *Load sample data* there. Without access, the gate fails closed.

After install, open **Jira settings → Marketplace apps → Canon setup**: a checklist shows Confluence connected, procedure-space access, whether the Canon gate has run on a Done transition, policy, and auto-bind mappings, each with its fix. The same page holds gate settings, *Load sample data*, *Publish sample v4* and *Reset sample data*.

**Roles judges need:** Jira admin for *Canon setup*; **project admin** (the project's *Administrators* role, which grants *Administer Projects*) or Jira admin for break-glass override and *Attach evidence pack*. In Jira Cloud a Jira admin does not automatically hold *Administer Projects*, so Canon accepts either. The *Canon register* is under the project's top tab bar: **More → Canon register**.

## Development
`npm test` · `npm run typecheck` · `npm run lint` · `forge deploy -e development`.
Development-only verification hooks are kept outside this repository; the manifest here is the production manifest.

## Extra: Canon tools for customer-built agents
Canon declares a `rovo:mcp` module ("Canon procedure tools") that exposes two read-only actions as tools: `canon-get-gate-status` and `canon-get-approved-procedure`. Both take the work item from the Rovo context only (no issue context → `NO_CONTEXT`). Procedure text and titles are returned only if the user can view the page (checked as the user). `canon-explain-delta` is deliberately not exposed.

Where it shows up (what we have actually verified, 22 Nov 2026):
- **Rovo Studio → custom agent → Tools:** Canon's actions are listed (seen: *Get Canon gate status*, *Get approved procedure*, and the other Canon actions). Canon does **not** appear as a separate entry in Rovo Studio's MCP server list; Forge app tools are offered as tools, not as a connectable server.
- **Third-party MCP clients (Atlassian Preview, not tested by us):** off by default. A site or org admin can enable it in Atlassian Administration → Apps → Sites → *your site* → Connected apps → Canon → choose the tools. Clients then connect to `https://mcp.atlassian.com/forge/12bf2743-b147-41da-9c66-4f171fa7bdfd` with OAuth, and calls run with the connecting user's permissions. See https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-mcp/ .
