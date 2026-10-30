import { DatabaseSync } from "node:sqlite";
import { XMLParser } from "fast-xml-parser";

export interface Newsletter {
  id: string;
  title: string;
  sender: string;
  published: string; // ISO
  link: string;
  html: string;
}

export interface StoredNewsletter extends Newsletter {
  plain: string;
  fetched_at: string;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null;

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/** Newsletterss dates look like "30 Oct 26 00:07 UTC" (2-digit year). */
export function parseDate(s: string | undefined): string {
  if (!s) return new Date().toISOString();
  const m = s.trim().match(/^(\d{1,2}) (\w{3}) (\d{2,4}) (\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    const d = new Date(Date.UTC(y, MONTHS[m[2].toLowerCase()] ?? 0, +m[1], +m[4], +m[5], +(m[6] ?? 0)));
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

const text = (v: unknown): string => {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (typeof v === "object" && "#text" in v) return String(v["#text"]);
  return "";
};

export function parseFeed(xml: string): Newsletter[] {
  const p = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    trimValues: true,
    // Newsletterss emits <author><Name>; match tags case-insensitively.
    transformTagName: (tag) => tag.toLowerCase(),
    // Decode numeric/HTML entities such as &#39; in titles and names.
    htmlEntities: true,
  });
  const doc = p.parse(xml);
  const raw: unknown = doc?.feed?.entry ?? doc?.rss?.channel?.item ?? [];
  const entries = (Array.isArray(raw) ? raw : [raw]).filter(isRec);
  return entries.map((e): Newsletter => {
    const links: unknown[] = Array.isArray(e.link) ? e.link : [e.link];
    const link = links.map((l) => (typeof l === "string" ? l : isRec(l) ? text(l["@_href"]) : "")).find(Boolean) ?? "";
    const author = e.author;
    const sender = isRec(author) ? text(author.name) || text(author.email) : text(author);
    return {
      id: text(e.id) || text(e.guid) || link,
      title: text(e.title),
      sender: sender.trim(),
      published: parseDate(text(e.published) || text(e.pubdate) || text(e.updated)),
      link,
      html: text(e.content) || text(e.description) || text(e.summary),
    };
  });
}

export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS newsletters (
        id TEXT PRIMARY KEY, title TEXT, sender TEXT, published TEXT,
        link TEXT, html TEXT, plain TEXT, fetched_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pub ON newsletters(published DESC);
      CREATE VIRTUAL TABLE IF NOT EXISTS nl_fts USING fts5(id UNINDEXED, title, sender, plain);
    `);
  }

  upsert(items: Newsletter[], toPlain: (html: string) => string): number {
    const existing = this.db.prepare("SELECT title, sender FROM newsletters WHERE id = ?");
    const ins = this.db.prepare(
      "INSERT INTO newsletters (id,title,sender,published,link,html,plain,fetched_at) VALUES (?,?,?,?,?,?,?,?)",
    );
    const fts = this.db.prepare("INSERT INTO nl_fts (id,title,sender,plain) VALUES (?,?,?,?)");
    const updMeta = this.db.prepare("UPDATE newsletters SET title = ?, sender = ? WHERE id = ?");
    const updFts = this.db.prepare("UPDATE nl_fts SET title = ?, sender = ? WHERE id = ?");
    let added = 0;
    for (const n of items) {
      if (!n.id) continue;
      // Rows come from the newsletters table schema above.
      const row = existing.get(n.id) as { title: string; sender: string } | undefined;
      if (row) {
        // Re-seen entry: refresh metadata so parser fixes reach archived rows still in the feed.
        if (row.title !== n.title || row.sender !== n.sender) {
          updMeta.run(n.title, n.sender, n.id);
          updFts.run(n.title, n.sender, n.id);
        }
        continue;
      }
      const plain = toPlain(n.html);
      ins.run(n.id, n.title, n.sender, n.published, n.link, n.html, plain, new Date().toISOString());
      fts.run(n.id, n.title, n.sender, plain);
      added++;
    }
    return added;
  }

  list(opts: { since?: string; until?: string; sender?: string; limit: number }) {
    const where: string[] = [];
    const args: string[] = [];
    if (opts.since) {
      where.push("published >= ?");
      args.push(parseDate(opts.since));
    }
    if (opts.until) {
      where.push("published <= ?");
      args.push(parseDate(opts.until));
    }
    if (opts.sender) {
      where.push("sender LIKE ?");
      args.push(`%${opts.sender}%`);
    }
    const sql = `SELECT id,title,sender,published,link,length(plain) AS chars FROM newsletters
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY published DESC LIMIT ${opts.limit}`;
    return this.db.prepare(sql).all(...args);
  }

  get(id: string) {
    return this.db.prepare("SELECT * FROM newsletters WHERE id = ? OR id LIKE ?").get(id, `%${id}%`) as
      | StoredNewsletter
      | undefined;
  }

  search(query: string, limit: number) {
    // Quote each term so punctuation in user queries doesn't break FTS syntax.
    const q = query
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `"${t.replace(/"/g, "")}"`)
      .join(" ");
    return this.db
      .prepare(
        `SELECT n.id,n.title,n.sender,n.published,n.link,
        snippet(nl_fts, 3, '**', '**', '…', 24) AS snippet
       FROM nl_fts JOIN newsletters n ON n.id = nl_fts.id
       WHERE nl_fts MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(q, limit);
  }

  senders() {
    return this.db
      .prepare(
        "SELECT sender, COUNT(*) AS count, MAX(published) AS latest FROM newsletters GROUP BY sender ORDER BY latest DESC",
      )
      .all();
  }

  count(): number {
    // COUNT(*) always yields exactly one row with a numeric c.
    const row = this.db.prepare("SELECT COUNT(*) AS c FROM newsletters").get() as { c: number };
    return row.c;
  }
}
