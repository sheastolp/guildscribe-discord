// Go-live alerts: a post in a server channel when a Twitch streamer goes live,
// the way Streamcord does it.
//
//   /live add      a moderator watches a streamer: which channel the alert
//                  goes in, a role to ping (@everyone works too) and the
//                  message above the card ({streamer} {title} {game} {url})
//   /live remove   stop watching one
//   /live list     who this server watches, and who's live now
//   /live test     posts the alert now, live or not, to check how it looks
//
//   the job        every minute (server.ts) asks Twitch which watched
//                  streamers are live (Helix, 100 per request). A new stream
//                  gets the alert: a card with the title, game, viewers and a
//                  preview, and a Watch button. While live, the card follows
//                  title and game changes. When the stream ends it becomes
//                  "was live" with how long it ran. A stream that drops and
//                  comes back within REJOIN_MS reuses the same post, so a
//                  shaky connection doesn't ping everyone twice.
//
// Needs TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET (an app at dev.twitch.tv,
// the same pair the Twitch bot uses). Without them /live says so and the job
// does nothing. Discord-only, so it isn't synced from the Twitch bot.

import { isCommandGroupEnabled } from "./game/db.ts";
import { sqlite } from "./game/sqlite.ts";
import type { Args } from "./commands.ts";
import { createMessage, editMessage, type OutMessage } from "./discord.ts";

export const LIVE_GROUP = "livealerts";

const HELIX = "https://api.twitch.tv/helix";
const TWITCH_PURPLE = 0x9146ff;
const OFFLINE_GREY = 0x747f8d;
/** A stream back within this long after ending is the same stream: its post is reused, nobody is pinged again. */
const REJOIN_MS = 10 * 60_000;
const MAX_PER_SERVER = 25;
const MAX_MESSAGE = 400;
export const DEFAULT_MESSAGE = "🔴 **{streamer}** is live on Twitch! {url}";

export interface Alert {
  guildId: string;
  login: string;
  channelId: string;
  pingRoleId: string | null;
  message: string;
  streamId: string | null;
  messageId: string | null;
  startedAt: number | null;
  endedAt: number | null;
  lastTitle: string;
  lastGame: string;
}

export interface Stream {
  id: string;
  login: string;
  name: string;
  title: string;
  game: string;
  viewers: number;
  startedAt: number;
  thumbnail: string;
}

export interface Streamer { id: string; login: string; name: string; avatar: string }

export interface LiveCtx {
  guildId: string;
  channelId: string;
  userId: string;
  moderator: boolean;
  a: Args;
}

export async function ensureLiveTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS live_alerts (
      guild_id TEXT NOT NULL,
      login TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      ping_role_id TEXT,
      message TEXT NOT NULL,
      stream_id TEXT,
      message_id TEXT,
      started_at INTEGER,
      ended_at INTEGER,
      last_title TEXT NOT NULL DEFAULT '',
      last_game TEXT NOT NULL DEFAULT '',
      added_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, login)
    )`,
  );
}

function toAlert(r: any): Alert {
  return {
    guildId: String(r.guild_id),
    login: String(r.login),
    channelId: String(r.channel_id),
    pingRoleId: r.ping_role_id ? String(r.ping_role_id) : null,
    message: String(r.message),
    streamId: r.stream_id ? String(r.stream_id) : null,
    messageId: r.message_id ? String(r.message_id) : null,
    startedAt: r.started_at === null || r.started_at === undefined ? null : Number(r.started_at),
    endedAt: r.ended_at === null || r.ended_at === undefined ? null : Number(r.ended_at),
    lastTitle: String(r.last_title ?? ""),
    lastGame: String(r.last_game ?? ""),
  };
}

export async function listAlerts(guildId?: string): Promise<Alert[]> {
  const res = guildId
    ? await sqlite.execute("SELECT * FROM live_alerts WHERE guild_id = ? ORDER BY login", [guildId])
    : await sqlite.execute("SELECT * FROM live_alerts");
  return res.rows.map(toAlert);
}

async function saveState(a: Alert) {
  await sqlite.execute(
    "UPDATE live_alerts SET stream_id = ?, message_id = ?, started_at = ?, ended_at = ?, last_title = ?, last_game = ? WHERE guild_id = ? AND login = ?",
    [a.streamId, a.messageId, a.startedAt, a.endedAt, a.lastTitle, a.lastGame, a.guildId, a.login],
  );
}

// ── Twitch (Helix, with an app access token) ──

export const twitchConfigured = () => Boolean(Deno.env.get("TWITCH_CLIENT_ID") && Deno.env.get("TWITCH_CLIENT_SECRET"));

let appToken: { token: string; expiresAt: number } | null = null;

async function token(): Promise<string> {
  if (appToken && Date.now() < appToken.expiresAt) return appToken.token;
  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: Deno.env.get("TWITCH_CLIENT_ID")!, client_secret: Deno.env.get("TWITCH_CLIENT_SECRET")!, grant_type: "client_credentials" }),
  });
  if (!res.ok) throw new Error(`Twitch app token failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  // A minute early, so a request never goes out with a token that expires on the way.
  appToken = { token: String(data.access_token), expiresAt: Date.now() + Math.max(0, Number(data.expires_in ?? 0) * 1000 - 60_000) };
  return appToken.token;
}

/** GET a Helix endpoint; a rejected token is fetched again once. */
async function helix(path: string): Promise<any[]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`${HELIX}${path}`, { headers: { Authorization: `Bearer ${await token()}`, "Client-Id": Deno.env.get("TWITCH_CLIENT_ID")! } });
    if (res.status === 401 && attempt === 0) {
      appToken = null;
      continue;
    }
    if (!res.ok) throw new Error(`Twitch ${path.split("?")[0]} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return (await res.json()).data ?? [];
  }
  return [];
}

const query = (key: string, logins: string[]) => logins.map((l) => `${key}=${encodeURIComponent(l)}`).join("&");

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Who among `logins` is live right now, by login. */
export async function liveStreams(logins: string[]): Promise<Map<string, Stream>> {
  const out = new Map<string, Stream>();
  for (const batch of chunks(logins, 100)) {
    for (const s of await helix(`/streams?first=100&${query("user_login", batch)}`)) {
      if (s.type && s.type !== "live") continue;
      const login = String(s.user_login).toLowerCase();
      out.set(login, {
        id: String(s.id),
        login,
        name: String(s.user_name || s.user_login),
        title: String(s.title ?? ""),
        game: String(s.game_name ?? ""),
        viewers: Number(s.viewer_count ?? 0),
        startedAt: Date.parse(s.started_at) || Date.now(),
        thumbnail: String(s.thumbnail_url ?? ""),
      });
    }
  }
  return out;
}

export async function streamers(logins: string[]): Promise<Map<string, Streamer>> {
  const out = new Map<string, Streamer>();
  for (const batch of chunks(logins, 100)) {
    for (const u of await helix(`/users?${query("login", batch)}`)) {
      const login = String(u.login).toLowerCase();
      out.set(login, { id: String(u.id), login, name: String(u.display_name || u.login), avatar: String(u.profile_image_url ?? "") });
    }
  }
  return out;
}

/** "twitch.tv/Some_One", "@Some_One" or "Some_One" → "some_one"; null when it can't be a Twitch name. */
export function parseLogin(typed: string): string | null {
  const login = typed.trim().replace(/^https?:\/\//i, "").replace(/^(www\.|m\.)?twitch\.tv\//i, "").replace(/^@/, "").split(/[/?#]/)[0].toLowerCase();
  return /^[a-z0-9_]{3,25}$/.test(login) ? login : null;
}

// ── The alert post ──

const watchUrl = (login: string) => `https://www.twitch.tv/${login}`;

function duration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const h = Math.floor(minutes / 60);
  return h ? `${h}h ${minutes % 60}m` : `${minutes}m`;
}

/** The text above the card: the server's message with its placeholders filled, and the ping. */
export function alertContent(alert: Alert, stream: Stream | null, name: string): string {
  const fill = (alert.message || DEFAULT_MESSAGE)
    .replaceAll("{streamer}", name)
    .replaceAll("{title}", stream?.title || "")
    .replaceAll("{game}", stream?.game || "")
    .replaceAll("{url}", `<${watchUrl(alert.login)}>`);
  const ping = !alert.pingRoleId ? "" : alert.pingRoleId === alert.guildId ? "@everyone " : `<@&${alert.pingRoleId}> `;
  return `${ping}${fill}`.slice(0, 2000);
}

/** The card: live (title, game, viewers, a fresh preview) or ended ("was live", how long). */
export function alertCard(alert: Alert, stream: Stream | null, who: Streamer | null, ended?: { startedAt: number; endedAt: number }): OutMessage {
  const name = stream?.name || who?.name || alert.login;
  const url = watchUrl(alert.login);
  const title = (stream?.title || alert.lastTitle || `${name} on Twitch`).slice(0, 256);
  const game = stream?.game || alert.lastGame;
  const embed: Record<string, unknown> = ended
    ? {
      author: { name: `${name} was live on Twitch`, url, ...(who?.avatar ? { icon_url: who.avatar } : {}) },
      title,
      url,
      color: OFFLINE_GREY,
      fields: [
        ...(game ? [{ name: "Game", value: game.slice(0, 1024), inline: true }] : []),
        { name: "Streamed for", value: duration(ended.endedAt - ended.startedAt), inline: true },
      ],
      ...(who?.avatar ? { thumbnail: { url: who.avatar } } : {}),
      footer: { text: "Stream ended" },
      timestamp: new Date(ended.endedAt).toISOString(),
    }
    : {
      author: { name: `${name} is now live on Twitch!`, url, ...(who?.avatar ? { icon_url: who.avatar } : {}) },
      title,
      url,
      color: TWITCH_PURPLE,
      fields: [
        ...(game ? [{ name: "Game", value: game.slice(0, 1024), inline: true }] : []),
        ...(stream ? [{ name: "Viewers", value: stream.viewers.toLocaleString("en-US"), inline: true }] : []),
      ],
      ...(who?.avatar ? { thumbnail: { url: who.avatar } } : {}),
      // Twitch caches previews by URL; a new one per post shows the stream as it is now.
      ...(stream?.thumbnail ? { image: { url: `${stream.thumbnail.replace("{width}", "1280").replace("{height}", "720")}?t=${Date.now()}` } } : {}),
      footer: { text: "Twitch" },
      timestamp: new Date(stream?.startedAt ?? Date.now()).toISOString(),
    };
  const button = { type: 2, style: 5, label: ended ? "Visit Channel" : "Watch Stream", url };
  const everyone = alert.pingRoleId === alert.guildId;
  return {
    content: ended ? "" : alertContent(alert, stream, name),
    embeds: [embed],
    components: [{ type: 1, components: [button] }],
    ...(!ended && alert.pingRoleId ? (everyone ? { pingEveryone: true } : { pingRoles: [alert.pingRoleId] }) : {}),
  };
}

// ── The job ──

/** Checks every watched streamer and posts, updates or closes out alerts. */
export async function runLiveJobs(now = Date.now()) {
  if (!twitchConfigured()) return;
  const all = await listAlerts();
  const enabled = new Map<string, boolean>();
  const alerts: Alert[] = [];
  for (const a of all) {
    if (!enabled.has(a.guildId)) enabled.set(a.guildId, await isCommandGroupEnabled(a.guildId, LIVE_GROUP));
    if (enabled.get(a.guildId)) alerts.push(a);
  }
  if (!alerts.length) return;
  const logins = [...new Set(alerts.map((a) => a.login))];
  const live = await liveStreams(logins);
  // Avatars only for the streamers whose card changes this run.
  const changing = alerts.filter((a) => {
    const s = live.get(a.login);
    return s ? a.streamId !== s.id || a.lastTitle !== s.title || a.lastGame !== s.game : Boolean(a.streamId);
  });
  const who = changing.length ? await streamers([...new Set(changing.map((a) => a.login))]).catch(() => new Map<string, Streamer>()) : new Map<string, Streamer>();
  for (const alert of changing) {
    try {
      await step(alert, live.get(alert.login) ?? null, who.get(alert.login) ?? null, now);
    } catch (e) {
      console.error(`live alert ${alert.login} in ${alert.guildId} failed`, e);
    }
  }
}

async function step(alert: Alert, stream: Stream | null, who: Streamer | null, now: number) {
  if (!stream) {
    // Ended: the post becomes "was live".
    if (alert.messageId && alert.startedAt) await editMessage(alert.channelId, alert.messageId, alertCard(alert, null, who, { startedAt: alert.startedAt, endedAt: now }));
    await saveState({ ...alert, streamId: null, endedAt: now });
    return;
  }
  const fresh = alert.streamId !== stream.id;
  const rejoin = fresh && !alert.streamId && alert.messageId && alert.endedAt !== null && now - alert.endedAt < REJOIN_MS;
  const next: Alert = { ...alert, streamId: stream.id, endedAt: null, lastTitle: stream.title, lastGame: stream.game };
  if (fresh && !rejoin) {
    // Marked first, so a slow or failing post never alerts twice.
    await saveState({ ...next, messageId: null, startedAt: stream.startedAt });
    const messageId = await createMessage(alert.channelId, alertCard(next, stream, who));
    if (!messageId) console.error(`live alert for ${alert.login} couldn't post in channel ${alert.channelId} (missing permission or deleted channel?)`);
    await saveState({ ...next, messageId, startedAt: stream.startedAt });
    return;
  }
  // Same stream (or back after a blip): keep the post, follow title and game.
  if (alert.messageId) await editMessage(alert.channelId, alert.messageId, alertCard(next, stream, who));
  await saveState({ ...next, startedAt: alert.startedAt ?? stream.startedAt });
}

// ── /live ──

const msg = (content: string): OutMessage => ({ content });

export async function liveChoices(guildId: string, typed: string): Promise<Array<{ name: string; value: string }>> {
  const q = typed.toLowerCase().trim();
  return (await listAlerts(guildId)).filter((a) => a.login.includes(q)).slice(0, 25).map((a) => ({ name: a.login, value: a.login }));
}

export async function handleLiveCommand(kind: string, ctx: LiveCtx): Promise<OutMessage> {
  if (!(await isCommandGroupEnabled(ctx.guildId, LIVE_GROUP))) {
    return msg("Go-live alerts are switched off in this server. A moderator can turn them on with `/guildscribe feature name:live state:on`.");
  }
  if (!twitchConfigured()) return msg("Go-live alerts need a Twitch app: whoever runs GuildScribe sets `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET`.");
  const a = ctx.a;
  if (kind === "live.list") {
    const alerts = await listAlerts(ctx.guildId);
    if (!alerts.length) return msg("📺 This server isn't watching any streamers yet. A moderator adds one with `/live add`.");
    const live = await liveStreams(alerts.map((x) => x.login)).catch(() => new Map<string, Stream>());
    const lines = alerts.map((x) => {
      const s = live.get(x.login);
      const ping = !x.pingRoleId ? "" : x.pingRoleId === ctx.guildId ? " · pings @everyone" : ` · pings <@&${x.pingRoleId}>`;
      return `${s ? "🔴" : "⚫"} **${s?.name ?? x.login}** → <#${x.channelId}>${ping}${s ? ` · live${s.game ? ` with ${s.game}` : ""}` : ""}`;
    });
    return msg([`📺 **Go-live alerts** (${alerts.length})`, ...lines].join("\n"));
  }
  if (!ctx.moderator) return msg("Only moderators (Manage Server or Manage Messages) can change go-live alerts.");
  const login = parseLogin(a.s("streamer"));
  if (!login) return msg(`**${a.s("streamer")}** isn't a Twitch name. Use the name from their channel link, e.g. \`twitch.tv/name\` → \`name\`.`);
  const existing = (await listAlerts(ctx.guildId)).find((x) => x.login === login) ?? null;

  if (kind === "live.remove") {
    if (!existing) return msg(`This server isn't watching **${login}**. \`/live list\` shows who it is.`);
    await sqlite.execute("DELETE FROM live_alerts WHERE guild_id = ? AND login = ?", [ctx.guildId, login]);
    return msg(`📺 No more go-live alerts for **${login}**.`);
  }

  const user = (await streamers([login])).get(login);
  if (!user) return msg(`Twitch has no channel called **${login}**.`);

  if (kind === "live.add") {
    if (!existing && (await listAlerts(ctx.guildId)).length >= MAX_PER_SERVER) return msg(`This server already watches ${MAX_PER_SERVER} streamers. Remove one with \`/live remove\` first.`);
    const channelId = a.id("channel") || existing?.channelId || ctx.channelId;
    const pingRoleId = a.id("ping") || existing?.pingRoleId || null;
    const message = a.s("message") === "-" ? DEFAULT_MESSAGE : (a.s("message") || existing?.message || DEFAULT_MESSAGE).slice(0, MAX_MESSAGE);
    await sqlite.execute(
      `INSERT INTO live_alerts (guild_id, login, channel_id, ping_role_id, message, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (guild_id, login) DO UPDATE SET channel_id = excluded.channel_id, ping_role_id = excluded.ping_role_id, message = excluded.message`,
      [ctx.guildId, login, channelId, pingRoleId, message, ctx.userId, Date.now()],
    );
    const ping = !pingRoleId ? "" : pingRoleId === ctx.guildId ? ", pinging @everyone" : `, pinging <@&${pingRoleId}>`;
    return msg(
      `📺 ${existing ? "Updated" : "Watching"} **${user.name}**: when they go live, GuildScribe posts in <#${channelId}>${ping}.\n` +
        `Message: ${message}\nTry it with \`/live test streamer:${login}\`. (Within a minute of going live; GuildScribe needs Send Messages and Embed Links there.)`,
    );
  }

  if (kind === "live.test") {
    if (!existing) return msg(`Add **${login}** with \`/live add\` first, so the test uses its channel, ping and message.`);
    const stream = (await liveStreams([login])).get(login) ?? null;
    const sample: Stream = stream ?? { id: "test", login, name: user.name, title: existing.lastTitle || "Test alert: this is how a go-live post looks", game: existing.lastGame, viewers: 0, startedAt: Date.now(), thumbnail: "" };
    const ok = await createMessage(existing.channelId, alertCard(existing, sample, user));
    return msg(ok ? `📺 Test alert posted in <#${existing.channelId}>.` : `Couldn't post in <#${existing.channelId}>. GuildScribe needs View Channel, Send Messages and Embed Links there.`);
  }
  return msg("Unknown /live command.");
}
