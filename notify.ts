// Feed alerts: a post in a channel when a YouTube channel uploads, a
// subreddit or Bluesky account posts, or any RSS/Atom feed (a blog, a
// podcast, a news site) has something new, the way NotifyMe does it.
// (Twitch go-live alerts are /live, live.ts.)
//
//   /notify add      (moderators) what to follow, where to post, a role to
//                    ping and the message ({title} {url} {author} {source})
//   /notify remove   stop following
//   /notify list     what this server follows
//   /notify test     posts the latest item now
//
//   the job          every 5 minutes (server.ts) reads each feed once, however
//                    many servers follow it. Items it hasn't seen are posted,
//                    oldest first, at most 3 a run (a feed that dumps 50 at
//                    once doesn't flood the channel). A feed's first read only
//                    takes note of what's there, so adding one never posts
//                    its back catalogue.
//
// No API keys: YouTube, Reddit and Bluesky all publish RSS. A YouTube channel
// can be given as a link, an @handle or its UC… ID.

import { isCommandGroupEnabled } from "./game/db.ts";
import { sqlite } from "./game/sqlite.ts";
import type { LocalCtx } from "./commands.ts";
import { createMessage, type OutMessage } from "./discord.ts";
import { fill, msg } from "./helpers.ts";

export const NOTIFY_GROUP = "notify";
export type Source = "youtube" | "reddit" | "bluesky" | "rss";
const MAX_PER_SERVER = 25;
const MAX_POSTS_PER_RUN = 3;
const SEEN_KEEP = 200;
const UA = "GuildScribe-Discord/1.0 (feed alerts)";

export const DEFAULT_MESSAGES: Record<Source, string> = {
  youtube: "📺 **{author}** just uploaded: **{title}**\n{url}",
  reddit: "👽 New in **{source}**: **{title}**\n{url}",
  bluesky: "🦋 **{author}** posted on Bluesky:\n{url}",
  rss: "📰 **{title}**\n{url}",
};

export interface Feed {
  id: number;
  guildId: string;
  source: Source;
  url: string;
  label: string;
  channelId: string;
  pingRoleId: string | null;
  message: string;
}

export interface Item { id: string; title: string; url: string; author: string; published: number }

export async function ensureNotifyTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS notify_feeds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      source TEXT NOT NULL,
      url TEXT NOT NULL,
      label TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      ping_role_id TEXT,
      message TEXT NOT NULL,
      added_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (guild_id, url)
    )`,
  );
  // What each feed URL has already shown, shared by every server that follows it.
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS notify_seen (
      url TEXT PRIMARY KEY,
      seen TEXT NOT NULL,
      checked_at INTEGER NOT NULL
    )`,
  );
}

function toFeed(r: any): Feed {
  return { id: Number(r.id), guildId: String(r.guild_id), source: String(r.source) as Source, url: String(r.url), label: String(r.label), channelId: String(r.channel_id), pingRoleId: r.ping_role_id ? String(r.ping_role_id) : null, message: String(r.message) };
}

export async function listFeeds(guildId?: string): Promise<Feed[]> {
  const res = guildId ? await sqlite.execute("SELECT * FROM notify_feeds WHERE guild_id = ? ORDER BY id", [guildId]) : await sqlite.execute("SELECT * FROM notify_feeds");
  return res.rows.map(toFeed);
}

// ── Reading feeds ──

function decode(s: string): string {
  return s
    .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .trim();
}

function tag(xml: string, name: string): string {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]) : "";
}

/** RSS <item>s or Atom <entry>s, newest first as feeds list them. */
export function parseFeed(xml: string): { title: string; items: Item[] } {
  const blocks = [...xml.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)].map((m) => m[2]);
  const head = xml.split(/<(?:item|entry)[\s>]/i)[0];
  const items = blocks.map((b) => {
    const atomLink = b.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i) ?? b.match(/<link[^>]*href=["']([^"']+)["']/i);
    const url = decode(atomLink?.[1] ?? tag(b, "link"));
    const id = tag(b, "yt:videoId") || tag(b, "guid") || tag(b, "id") || url;
    const authorBlock = b.match(/<author[\s\S]*?<\/author>/i)?.[0] ?? "";
    const author = tag(authorBlock, "name") || tag(b, "dc:creator") || tag(b, "author").replace(/<[^>]+>/g, "").trim();
    const published = Date.parse(tag(b, "published") || tag(b, "pubDate") || tag(b, "updated") || tag(b, "dc:date")) || 0;
    const title = tag(b, "title") || tag(b, "description").replace(/<[^>]+>/g, "").slice(0, 200);
    return { id, title, url, author, published };
  }).filter((i) => i.id && i.url);
  return { title: tag(head, "title"), items };
}

async function get(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.5" }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return await res.text();
}

export async function readFeed(url: string): Promise<{ title: string; items: Item[] }> {
  return parseFeed(await get(url));
}

/** What a member typed → the feed to read, and a name for it; or an error to show them. */
export async function resolveSource(source: Source, typed: string): Promise<{ url: string; label: string } | { error: string }> {
  const t = typed.trim();
  if (source === "youtube") {
    let channelId = t.match(/\b(UC[\w-]{22})\b/)?.[1];
    if (!channelId) {
      const page = /^https?:\/\//i.test(t) ? t : `https://www.youtube.com/${t.startsWith("@") ? t : `@${t}`}`;
      const html = await get(page).catch(() => "");
      channelId = html.match(/"(?:externalId|channelId)":"(UC[\w-]{22})"/)?.[1] ?? html.match(/channel\/(UC[\w-]{22})/)?.[1];
    }
    if (!channelId) return { error: `Couldn't find the YouTube channel **${t}**. Use its link, its @handle, or its ID (starts with UC).` };
    const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
    const feed = await readFeed(url).catch(() => null);
    if (!feed) return { error: "YouTube didn't answer for that channel. Try again in a minute." };
    return { url, label: feed.title || t };
  }
  if (source === "reddit") {
    const sub = t.replace(/^https?:\/\/(www\.|old\.)?reddit\.com\//i, "").replace(/^\/?r\//i, "").split(/[/?#]/)[0];
    if (!/^\w{2,21}$/.test(sub)) return { error: `**${t}** isn't a subreddit name.` };
    const url = `https://www.reddit.com/r/${sub}/new/.rss`;
    if (!(await readFeed(url).catch(() => null))) return { error: `Reddit has no r/${sub} (or it's private).` };
    return { url, label: `r/${sub}` };
  }
  if (source === "bluesky") {
    const handle = t.replace(/^https?:\/\/bsky\.app\/profile\//i, "").replace(/^@/, "").split(/[/?#]/)[0];
    if (!/^[\w.-]+\.[\w-]+$|^did:/.test(handle)) return { error: `**${t}** isn't a Bluesky handle (like name.bsky.social).` };
    const url = `https://bsky.app/profile/${handle}/rss`;
    if (!(await readFeed(url).catch(() => null))) return { error: `Bluesky has no account **${handle}**.` };
    return { url, label: `@${handle}` };
  }
  if (!/^https?:\/\//i.test(t)) return { error: "Give the feed's full address (https://…)." };
  const feed = await readFeed(t).catch(() => null);
  if (!feed?.items.length) return { error: `There's no RSS or Atom feed at ${t}. Look for an "RSS" link on the site.` };
  return { url: t, label: feed.title || new URL(t).host };
}

// ── Posting ──

export function itemMessage(f: Feed, item: Item): OutMessage {
  const content = fill(f.message, { title: item.title || "(untitled)", url: item.url, author: item.author || f.label, source: f.label });
  const ping = !f.pingRoleId ? "" : f.pingRoleId === f.guildId ? "@everyone " : `<@&${f.pingRoleId}> `;
  return {
    content: `${ping}${content}`.slice(0, 2000),
    ...(f.pingRoleId ? (f.pingRoleId === f.guildId ? { pingEveryone: true } : { pingRoles: [f.pingRoleId] }) : {}),
  };
}

async function seenFor(url: string): Promise<string[] | null> {
  const r: any = (await sqlite.execute("SELECT seen FROM notify_seen WHERE url = ?", [url])).rows[0];
  return r ? JSON.parse(String(r.seen)) : null;
}

async function saveSeen(url: string, ids: string[]) {
  await sqlite.execute("INSERT OR REPLACE INTO notify_seen (url, seen, checked_at) VALUES (?, ?, ?)", [url, JSON.stringify(ids.slice(0, SEEN_KEEP)), Date.now()]);
}

export async function runNotifyJobs() {
  const feeds: Feed[] = [];
  const enabled = new Map<string, boolean>();
  for (const f of await listFeeds()) {
    if (!enabled.has(f.guildId)) enabled.set(f.guildId, await isCommandGroupEnabled(f.guildId, NOTIFY_GROUP));
    if (enabled.get(f.guildId)) feeds.push(f);
  }
  const byUrl = new Map<string, Feed[]>();
  for (const f of feeds) byUrl.set(f.url, [...(byUrl.get(f.url) ?? []), f]);
  for (const [url, followers] of byUrl) {
    try {
      const { items } = await readFeed(url);
      const seen = await seenFor(url);
      const ids = items.map((i) => i.id);
      if (seen === null) {
        await saveSeen(url, ids); // first read: just take note
        continue;
      }
      const fresh = items.filter((i) => !seen.includes(i.id)).reverse().slice(-MAX_POSTS_PER_RUN);
      await saveSeen(url, [...new Set([...ids, ...seen])]);
      for (const item of fresh) for (const f of followers) await createMessage(f.channelId, itemMessage(f, item));
    } catch (e) {
      console.error(`feed ${url} failed`, e instanceof Error ? e.message : e);
    }
  }
}

// ── /notify ──

export async function notifyChoices(guildId: string, typed: string): Promise<Array<{ name: string; value: number }>> {
  const q = typed.toLowerCase().trim();
  return (await listFeeds(guildId)).filter((f) => !q || f.label.toLowerCase().includes(q) || String(f.id).startsWith(q)).slice(0, 25).map((f) => ({ name: `#${f.id} ${f.source}: ${f.label}`.slice(0, 100), value: f.id }));
}

const ICON: Record<Source, string> = { youtube: "📺", reddit: "👽", bluesky: "🦋", rss: "📰" };

export async function handleNotifyCommand(kind: string, ctx: LocalCtx): Promise<OutMessage> {
  if (!(await isCommandGroupEnabled(ctx.guildId, NOTIFY_GROUP))) {
    return msg("Feed alerts are switched off in this server. A moderator can turn them on with `/guildscribe feature name:notify state:on`.");
  }
  const a = ctx.a;
  if (kind === "notify.list") {
    const feeds = await listFeeds(ctx.guildId);
    if (!feeds.length) return msg("🔔 This server doesn't follow any feeds yet. A moderator adds one with `/notify add`.");
    const lines = feeds.map((f) => `**#${f.id}** ${ICON[f.source]} ${f.label} → <#${f.channelId}>${f.pingRoleId ? (f.pingRoleId === ctx.guildId ? " · pings @everyone" : ` · pings <@&${f.pingRoleId}>`) : ""}`);
    return msg([`🔔 **Feed alerts** (${feeds.length})`, ...lines].join("\n"));
  }
  if (!ctx.moderator) return msg("Only moderators (Manage Server or Manage Messages) can change feed alerts.");

  if (kind === "notify.add") {
    const source = a.s("source") as Source;
    if ((await listFeeds(ctx.guildId)).length >= MAX_PER_SERVER) return msg(`This server already follows ${MAX_PER_SERVER} feeds. Remove one with \`/notify remove\` first.`);
    const found = await resolveSource(source, a.s("from"));
    if ("error" in found) return msg(found.error);
    const channelId = a.id("channel") || ctx.channelId;
    const message = a.s("message") && a.s("message") !== "-" ? a.s("message").slice(0, 500) : DEFAULT_MESSAGES[source];
    await sqlite.execute(
      `INSERT INTO notify_feeds (guild_id, source, url, label, channel_id, ping_role_id, message, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (guild_id, url) DO UPDATE SET channel_id = excluded.channel_id, ping_role_id = excluded.ping_role_id, message = excluded.message`,
      [ctx.guildId, source, found.url, found.label, channelId, a.id("ping") || null, message, ctx.userId, Date.now()],
    );
    // Take note of what's there now, so only new items are posted.
    if ((await seenFor(found.url)) === null) await saveSeen(found.url, (await readFeed(found.url).catch(() => ({ items: [] as Item[] }))).items.map((i) => i.id));
    return msg(`🔔 Following ${ICON[source]} **${found.label}**: new posts go in <#${channelId}> (checked every 5 minutes).\nMessage: ${message}\n\`/notify test\` posts the latest one now.`);
  }
  const f = (await listFeeds(ctx.guildId)).find((x) => x.id === Number(a.s("feed")));
  if (!f) return msg("This server doesn't follow that. `/notify list` shows what it does.");
  if (kind === "notify.remove") {
    await sqlite.execute("DELETE FROM notify_feeds WHERE id = ?", [f.id]);
    return msg(`🔕 No more alerts for ${ICON[f.source]} **${f.label}**.`);
  }
  if (kind === "notify.test") {
    const latest = (await readFeed(f.url).catch(() => ({ items: [] as Item[] }))).items[0];
    if (!latest) return msg(`${f.label} has nothing to show right now.`);
    const ok = await createMessage(f.channelId, itemMessage(f, latest));
    return msg(ok ? `🔔 Posted the latest from **${f.label}** in <#${f.channelId}>.` : `Couldn't post in <#${f.channelId}>. GuildScribe needs View Channel and Send Messages there.`);
  }
  return msg("Unknown /notify command.");
}
