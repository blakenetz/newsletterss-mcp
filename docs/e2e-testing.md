# End-to-end testing against your real feed

Manual checklist for verifying the server against a live Newsletterss inbox. Run it after changes to feed
parsing, markdown conversion, storage or auth.

## Prerequisites

- Node from `.nvmrc` (`nvm install`), dependencies installed and built (`npm i && npm run build`).
- `.env` with `NEWSLETTERSS_USERNAME` and `AUTH_TOKEN` set (see the [README](../README.md#configuration)).
- `jq` and `sqlite3` on your `PATH` (both ship with macOS).
- Server running: `npm start`. The first poll runs at startup and logs `[poll] +N (total N)`.

## 1. Load `.env` into your shell

```bash
set -a; source .env; set +a
curl -s localhost:3000/healthz            # {"ok":true,"total":10} after the first poll
```

The feed only returns the latest 10 entries, so a fresh archive starts at 10 or fewer.

## 2. Exercise every tool

Define a helper (bash or zsh) that calls a tool and prints its text result:

```bash
MCP_URL=http://localhost:3000/mcp
mcp() {
  curl -s "$MCP_URL" \
    -H "authorization: Bearer $AUTH_TOKEN" \
    -H "content-type: application/json" \
    -H "accept: application/json, text/event-stream" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":${2:-"{}"}}}" \
  | sed -n "s/^data: //p" | jq -r ".result.content[0].text"
}
```

Then:

```bash
mcp list_senders
mcp list_newsletters '{"limit":10}'
mcp get_newsletter '{"id":"<id or unique fragment from the list>"}'
mcp search_newsletters '{"query":"<a word you know appears>"}'
mcp refresh_feed                           # expect "added": 0
```

## 3. Auth

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST $MCP_URL                  # 401: no token
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$MCP_URL?token=wrong"     # 401: wrong token
```

## 4. MCP Inspector (optional)

```bash
npx @modelcontextprotocol/inspector
```

Transport **Streamable HTTP**, URL `http://localhost:3000/mcp?token=<AUTH_TOKEN>` (or the plain URL plus the
token as a Bearer token under Authentication), then **Tools → List Tools** and run each tool.

## 5. Inspect the stored data

```bash
sqlite3 newsletters.db "select sender, published, title, length(html), length(plain) from newsletters order by published desc"
curl -s "https://newsletterss.com/rss/$NEWSLETTERSS_USERNAME" | head -c 3000   # raw XML to compare against parsed fields
```

## 6. Persistence across restarts

Stop the server (Ctrl-C), run `npm start` again, then:

```bash
curl -s localhost:3000/healthz             # same total as before, not doubled
mcp refresh_feed                           # "added": 0
```

## What to check

| Area                                               | Pass                                      | Fail                                                                           |
| -------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------ |
| Senders (`list_senders`)                           | Real newsletter names                     | Blank, email-only, or one name for everything (e.g. your Newsletterss account) |
| Dates                                              | Close to when the emails arrived (UTC)    | All identical, near server start time (date parser fell back)                  |
| Markdown (`get_newsletter`, 2–3 different senders) | Readable headings, paragraphs, links      | Table pipes, leftover images, `&nbsp;`, footer/unsubscribe text dominating     |
| Length                                             | Most under the 40 000-char default        | Frequent `…[truncated]`                                                        |
| Search                                             | Hits with **bolded** terms in the snippet | No hits for words you know are present                                         |
| Refresh / restart                                  | `added: 0`, total unchanged               | Total grows                                                                    |

## Reporting a problem

Include the `list_senders` output, an excerpt of a bad `get_newsletter` result, and one raw `<entry>` from
step 5 (just `<author>` and the first few hundred characters of `<content>`). Never include your username,
`AUTH_TOKEN`, or a connector URL containing either.
