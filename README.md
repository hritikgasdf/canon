# Canon: version-pinned procedure gate for Jira + Confluence (Forge)

Canon pins the approved Confluence procedure version a Jira change started under. If the procedure is revised while the ticket is open, Canon blocks the Done transition until the material changes are re-attested.

## Setup (read first)
See **[docs/judges-setup.md](docs/judges-setup.md)**. Most important: **Canon must have access to the procedure space.** Spaces that existed before install are invisible to the app until an admin adds Canon in *Space settings → Users → Add people and agents* (search "Canon", add **canon** and **Canon Procedure Guard**, each with at least view access). The other way is to use *Load sample data*, which creates a fresh space. Without access, the gate fails closed.

## Development
`npm test` · `npm run typecheck` · `npm run lint` · `forge deploy -e development`.
Development-only verification hooks are kept outside this repository; the manifest here is the production manifest.
