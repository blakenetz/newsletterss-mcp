# newsletterss-mcp

MCP server for your Newsletterss inbox. Polls your private Atom feed
(`https://newsletterss.com/rss/<username>`, latest 10 items) every 15 min and
archives everything into SQLite with full-text search, so history builds up over time.

**Tools:** `list_newsletters`, `get_newsletter` (markdown), `search_newsletters`,
`list_senders`, `refresh_feed`.

## Configuration

| Variable                | Required             | Default                                               | Purpose                                                                                |
| ----------------------- | -------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `NEWSLETTERSS_USERNAME` | yes                  | —                                                     | Your Newsletterss username; the server reads `https://newsletterss.com/rss/<username>` |
| `AUTH_TOKEN`            | for HTTP deployments | unset                                                 | Shared secret clients must send to `/mcp` (see [Auth token](#auth-token))              |
| `DB_PATH`               | no                   | `./newsletters.db` (`/data/newsletters.db` in Docker) | SQLite archive location                                                                |
| `POLL_MINUTES`          | no                   | `15`                                                  | Feed polling interval                                                                  |
| `PORT`                  | no                   | `3000`                                                | HTTP port                                                                              |

> The feed needs no login, so anyone who knows your username can read your inbox.
> Treat `NEWSLETTERSS_USERNAME` like a password: keep it in `.env` or host secrets, never in commits.

For local runs, copy the template and fill it in; `.env` is gitignored and `npm start` loads it automatically:

```bash
cp .env.example .env
```

### Auth token

`AUTH_TOKEN` protects the HTTP endpoint (`/mcp`). When it is set, every request must carry it, either as
`Authorization: Bearer <AUTH_TOKEN>` or as `?token=<AUTH_TOKEN>`; anything else gets `401`. When it is unset,
`/mcp` is open to anyone who can reach it, so **always set it on a public deployment**. `/healthz` is never
protected, and stdio mode (Claude Desktop) ignores the token.

1. Generate a long random value (any URL-safe string works; hex avoids escaping in the connector URL):

   ```bash
   openssl rand -hex 32
   ```

2. Put it in `.env` for local runs, or in your host's secret store for deployments
   (`fly secrets set AUTH_TOKEN=...`). Never commit it.
3. Give it to clients:
   - The claude.ai custom connector form takes a URL, so pass the token in the query string:
     `https://<your-app>.fly.dev/mcp?token=<AUTH_TOKEN>`. That URL is now a secret too.
   - Clients that support headers (MCP Inspector, curl, other MCP hosts) should prefer
     `Authorization: Bearer <AUTH_TOKEN>`, which keeps the token out of URLs and logs.
4. To rotate, generate a new value, update the secret (`fly secrets set AUTH_TOKEN=...` restarts the app),
   then update the connector URL in claude.ai. The old token stops working immediately.

## Run locally

```bash
nvm install && npm i && npm run build   # Node version from .nvmrc
cp .env.example .env                    # then set NEWSLETTERSS_USERNAME and AUTH_TOKEN
npm start                               # http://localhost:3000/mcp
```

Development, CI and the Docker image use the Node version in `.nvmrc` (26.13.0 LTS). `package.json` `engines`
allows `^22.16.0 || >=24.0.0`: earlier releases (including all of Node 23) ship `node:sqlite` without FTS5.

## Development

```bash
npm run lint        # Biome lint + format check (warnings fail)
npm run lint:fix    # apply Biome fixes and formatting
npm run typecheck
```

`main` is protected: changes land through pull requests, and the `quality` CI job
(Biome, typecheck, build) must pass before merge.

To verify against your real feed (tools, auth, persistence, parsing quality), follow
[docs/e2e-testing.md](docs/e2e-testing.md).

## Claude Desktop (local, stdio)

```json
{
  "mcpServers": {
    "newsletterss": {
      "command": "node",
      "args": ["--no-warnings", "/abs/path/newsletterss-mcp/dist/server.js", "--stdio"],
      "env": {
        "NEWSLETTERSS_USERNAME": "your-username",
        "DB_PATH": "/abs/path/newsletters.db"
      }
    }
  }
}
```

No `AUTH_TOKEN` is needed: stdio has no network endpoint. Only archives while Desktop is running — deploy it if
you want continuous history.

## Deploy (Fly.io, needs a volume for the DB)

```bash
fly launch --no-deploy
fly volumes create data --size 1
# in fly.toml: [mounts] source="data" destination="/data"
AUTH_TOKEN=$(openssl rand -hex 32) && echo "$AUTH_TOKEN"   # save this; Fly won't show it again
fly secrets set NEWSLETTERSS_USERNAME=your-username AUTH_TOKEN="$AUTH_TOKEN"
fly deploy
```

Keep one machine always on (`min_machines_running = 1`, `auto_stop_machines = false`) so polling continues.

## Add to Claude

claude.ai → Settings → Connectors → Add custom connector →
`https://<your-app>.fly.dev/mcp?token=<AUTH_TOKEN>`
