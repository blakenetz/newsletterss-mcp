# newsletterss-mcp

MCP server for your Newsletterss inbox. Polls your private Atom feed
(`https://newsletterss.com/rss/<username>`, latest 10 items) every 15 min and
archives everything into SQLite with full-text search, so history builds up over time.

**Tools:** `list_newsletters`, `get_newsletter` (markdown), `search_newsletters`,
`list_senders`, `refresh_feed`.

> Your feed URL needs no login — treat it like a password.

## Run locally

```bash
npm i && npm run build
FEED_URL=https://newsletterss.com/rss/you AUTH_TOKEN=xyz npm start   # http://localhost:3000/mcp
```

Requires a current Node 22 release: older 22.x builds (e.g. 22.13) ship `node:sqlite` without FTS5.

## Development

```bash
npm run lint        # Biome lint + format check (warnings fail)
npm run lint:fix    # apply Biome fixes and formatting
npm run typecheck
```

`main` is protected: changes land through pull requests, and the `quality` CI job
(Biome, typecheck, build) must pass before merge.

## Claude Desktop (local, stdio)

```json
{
  "mcpServers": {
    "newsletterss": {
      "command": "node",
      "args": ["--no-warnings", "/abs/path/newsletterss-mcp/dist/server.js", "--stdio"],
      "env": { "FEED_URL": "https://newsletterss.com/rss/you", "DB_PATH": "/abs/path/newsletters.db" }
    }
  }
}
```
Only archives while Desktop is running — deploy it if you want continuous history.

## Deploy (Fly.io, needs a volume for the DB)

```bash
fly launch --no-deploy
fly volumes create data --size 1
# in fly.toml: [mounts] source="data" destination="/data"
fly secrets set FEED_URL=https://newsletterss.com/rss/you AUTH_TOKEN=$(openssl rand -hex 24)
fly deploy
```
Keep one machine always on (`min_machines_running = 1`, `auto_stop_machines = false`) so polling continues.

## Add to Claude

claude.ai → Settings → Connectors → Add custom connector →
`https://<your-app>.fly.dev/mcp?token=<AUTH_TOKEN>`
