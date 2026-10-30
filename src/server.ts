import { createHash, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import TurndownService from "turndown";
import { z } from "zod";
import { parseFeed, Store } from "./store.js";

const USERNAME = process.env.NEWSLETTERSS_USERNAME?.trim() ?? "";
const DB_PATH = process.env.DB_PATH ?? "./newsletters.db";
const POLL_MINUTES = Number(process.env.POLL_MINUTES ?? 15);
const PORT = Number(process.env.PORT ?? 3000);
const AUTH_TOKEN = process.env.AUTH_TOKEN ?? ""; // HTTP mode: sent as Bearer header or ?token=
const STDIO = process.argv.includes("--stdio");
const MIN_TOKEN_LENGTH = 32;
const FEED_TIMEOUT_MS = 30_000;

if (!USERNAME) {
  console.error("NEWSLETTERSS_USERNAME is required (the <username> in https://newsletterss.com/rss/<username>)");
  process.exit(1);
}
if (!STDIO && AUTH_TOKEN.length < MIN_TOKEN_LENGTH) {
  console.error(
    `AUTH_TOKEN is required in HTTP mode and must be at least ${MIN_TOKEN_LENGTH} characters (generate one with: openssl rand -hex 32)`,
  );
  process.exit(1);
}
const FEED_URL = `https://newsletterss.com/rss/${encodeURIComponent(USERNAME)}`;

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
  const res = await fetch(FEED_URL, {
    headers: { "user-agent": "newsletterss-mcp/1.0" },
    signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
  });
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

void poll(); // first poll runs in the background so a slow feed can't block startup
setInterval(poll, POLL_MINUTES * 60_000).unref?.();

if (STDIO) {
  await buildServer().connect(new StdioServerTransport());
} else {
  const expectedToken = createHash("sha256").update(AUTH_TOKEN).digest();
  const app = express();
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, total: store.count() });
  });
  const authenticate: RequestHandler = (req, res, next) => {
    const header = req.headers.authorization ?? "";
    const got = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : String(req.query.token ?? "");
    // Compare fixed-length digests so the check takes the same time regardless of where tokens differ.
    if (!timingSafeEqual(createHash("sha256").update(got).digest(), expectedToken)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
  // Authenticate before parsing so unauthenticated bodies are never read.
  app.all("/mcp", authenticate, express.json({ limit: "4mb" }), async (req, res) => {
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
  // Express's default error page includes stack traces; answer with bare JSON instead.
  const onError: ErrorRequestHandler = (err, _req, res, next) => {
    if (res.headersSent) return next(err);
    const status = typeof err?.status === "number" ? err.status : 500;
    if (status >= 500) console.error("[http]", err);
    res.status(status).json({ error: status >= 500 ? "internal error" : "invalid request" });
  };
  app.use(onError);
  app.listen(PORT, () => console.error(`newsletterss-mcp on :${PORT}/mcp`));
}
