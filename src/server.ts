import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import TurndownService from "turndown";
import { z } from "zod";
import { parseFeed, Store } from "./store.js";

const FEED_URL = process.env.FEED_URL ?? ""; // e.g. https://newsletterss.com/rss/<username>
const DB_PATH = process.env.DB_PATH ?? "./newsletters.db";
const POLL_MINUTES = Number(process.env.POLL_MINUTES ?? 15);
const PORT = Number(process.env.PORT ?? 3000);
const AUTH_TOKEN = process.env.AUTH_TOKEN; // optional: required as ?token= or Bearer for HTTP

if (!FEED_URL) {
  console.error("FEED_URL is required (your https://newsletterss.com/rss/<username> URL)");
  process.exit(1);
}

const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
td.remove(["style", "script", "head", "title", "meta"]);
// Drop tracking pixels / spacer images.
td.addRule("pixels", {
  filter: (n) => n.nodeName === "IMG" && /^(1|0)$/.test(n.getAttribute("width") ?? ""),
  replacement: () => "",
});
const toMarkdown = (html: string) =>
  td
    .turndown(html || "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
const toPlain = (html: string) =>
  toMarkdown(html)
    .replace(/!\[[^\]]*]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)]\([^)]*\)/g, "$1");

const store = new Store(DB_PATH);

async function refresh(): Promise<{ added: number; total: number }> {
  const res = await fetch(FEED_URL, { headers: { "user-agent": "newsletterss-mcp/1.0" } });
  if (!res.ok) throw new Error(`Feed fetch failed: ${res.status}`);
  const added = store.upsert(parseFeed(await res.text()), toPlain);
  return { added, total: store.count() };
}

const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });

function buildServer() {
  const s = new McpServer({ name: "newsletterss", version: "1.0.0" });

  s.registerTool(
    "list_newsletters",
    {
      description: "List newsletters in the archive, newest first. Returns id, title, sender, date and length.",
      inputSchema: {
        since: z.string().optional().describe("ISO date or date string; only items on/after this"),
        until: z.string().optional(),
        sender: z.string().optional().describe("Substring match on sender name"),
        limit: z.number().int().min(1).max(200).default(25),
      },
    },
    async (a) => json(store.list(a)),
  );

  s.registerTool(
    "get_newsletter",
    {
      description: "Get one newsletter's full content as markdown.",
      inputSchema: {
        id: z.string().describe("id from list/search (or a unique fragment of it)"),
        max_chars: z.number().int().min(500).max(200000).default(40000),
      },
    },
    async ({ id, max_chars }) => {
      const n = store.get(id);
      if (!n) return { isError: true, content: [{ type: "text" as const, text: `No newsletter with id ${id}` }] };
      let body = toMarkdown(n.html);
      if (body.length > max_chars) body = `${body.slice(0, max_chars)}\n\n…[truncated]`;
      return {
        content: [
          {
            type: "text" as const,
            text: `# ${n.title}\nFrom: ${n.sender}\nDate: ${n.published}\nLink: ${n.link}\n\n${body}`,
          },
        ],
      };
    },
  );

  s.registerTool(
    "search_newsletters",
    {
      description: "Full-text search across all archived newsletters (title, sender, body).",
      inputSchema: { query: z.string(), limit: z.number().int().min(1).max(50).default(10) },
    },
    async ({ query, limit }) => json(store.search(query, limit)),
  );

  s.registerTool(
    "list_senders",
    {
      description: "List newsletter senders with counts and latest issue date.",
      inputSchema: {},
    },
    async () => json(store.senders()),
  );

  s.registerTool(
    "refresh_feed",
    {
      description: "Pull the latest items from the Newsletterss feed now.",
      inputSchema: {},
    },
    async () => json(await refresh()),
  );

  return s;
}

async function poll() {
  try {
    const r = await refresh();
    if (r.added) console.error(`[poll] +${r.added} (total ${r.total})`);
  } catch (e) {
    console.error("[poll]", (e as Error).message);
  }
}

await poll();
setInterval(poll, POLL_MINUTES * 60_000).unref?.();

if (process.argv.includes("--stdio")) {
  await buildServer().connect(new StdioServerTransport());
} else {
  const app = express();
  app.use(express.json({ limit: "4mb" }));
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, total: store.count() });
  });
  app.all("/mcp", async (req, res) => {
    if (AUTH_TOKEN) {
      const got = (req.headers.authorization ?? "").replace(/^Bearer /, "") || String(req.query.token ?? "");
      if (got !== AUTH_TOKEN) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
    }
    // Stateless: fresh server+transport per request.
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.listen(PORT, () => console.error(`newsletterss-mcp on :${PORT}/mcp`));
}
