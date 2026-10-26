// Invite tracking: who invited whom, and how many people each member has
// brought in, the way Invite Tracker does it.
//
// Discord doesn't say which invite someone joined with. So GuildScribe keeps
// every invite's use count (fetched when the server comes online, kept up by
// INVITE_CREATE / INVITE_DELETE), and when a member joins it fetches them
// again: the invite whose count went up is theirs. An invite with a use
// limit disappears on its last use, so one deleted a moment ago counts too.
// Joins in one server are worked out one at a time, so two at once don't
// get mixed up. The vanity URL and joins nobody can be sure of are "unknown".
//
//   counts      joins − left − fake + bonus. "Fake" is an account under a
//               week old; "left" is someone who has gone again.
//   /invites    show (anyone's count), top, who (who invited someone),
//               bonus (moderators add or take away), log (a channel that
//               gets "X joined, invited by Y")
//
// Needs the Gateway with the Server Members intent, and GuildScribe with
// Manage Server (Discord only lists invites to those who have it).

import { isCommandGroupEnabled } from "./game/db.ts";
import { sqlite } from "./game/sqlite.ts";
import type { LocalCtx } from "./commands.ts";
import { api, createMessage, type OutMessage } from "./discord.ts";
import { on } from "./gateway.ts";
import { ensureGuild } from "./guild.ts";
import { fill, mention, msg } from "./helpers.ts";

export const INVITES_GROUP = "invites";
export const DEFAULT_JOIN_MESSAGE = "📥 {user} joined, invited by {inviter} (who now has **{invites}** invites).";
const FAKE_UNDER_MS = 7 * 86_400_000;
const DELETED_GRACE_MS = 15_000;

interface Invite { uses: number; inviterId: string | null }

export interface Join { inviterId: string | null; code: string | null; how: "invite" | "vanity" | "unknown" }

export interface InviteCounts { joins: number; left: number; fake: number; bonus: number; total: number }

export async function ensureInviteTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS invite_joins (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      inviter_id TEXT,
      code TEXT,
      how TEXT NOT NULL,
      fake INTEGER NOT NULL DEFAULT 0,
      joined_at INTEGER NOT NULL,
      left_at INTEGER,
      PRIMARY KEY (guild_id, user_id)
    )`,
  );
  await sqlite.execute("CREATE INDEX IF NOT EXISTS invite_joins_inviter ON invite_joins (guild_id, inviter_id)");
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS invite_settings (
      guild_id TEXT PRIMARY KEY,
      channel_id TEXT,
      message TEXT
    )`,
  );
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS invite_bonus (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      bonus INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id)
    )`,
  );
}

/** When an account was made, from its ID. */
export const accountCreatedAt = (userId: string) => Number((BigInt(userId) >> 22n) + 1420070400000n);

// ── The invite snapshot ──

const snapshots = new Map<string, Map<string, Invite>>();
const vanity = new Map<string, number>();
const deleted = new Map<string, Array<{ code: string; inviterId: string | null; at: number }>>();
const queue = new Map<string, Promise<unknown>>();
const pending = new Map<string, Promise<Join>>();

async function fetchInvites(guildId: string): Promise<Map<string, Invite> | null> {
  const list = await api("GET", `/guilds/${guildId}/invites`);
  if (!Array.isArray(list)) return null;
  return new Map(list.map((i: any) => [String(i.code), { uses: Number(i.uses ?? 0), inviterId: i.inviter?.id ? String(i.inviter.id) : null }]));
}

async function fetchVanityUses(guildId: string): Promise<number | null> {
  const v = await api("GET", `/guilds/${guildId}/vanity-url`);
  return v?.code ? Number(v.uses ?? 0) : null;
}

export async function loadInvites(guildId: string) {
  const list = await fetchInvites(guildId);
  if (list) snapshots.set(guildId, list);
  const v = await fetchVanityUses(guildId);
  if (v !== null) vanity.set(guildId, v);
}

/** Which invite a member who just joined used. Worked out once per join, one join at a time per server. */
export function resolveJoin(guildId: string, userId: string): Promise<Join> {
  const key = `${guildId}:${userId}`;
  const hit = pending.get(key);
  if (hit) return hit;
  const prev = queue.get(guildId) ?? Promise.resolve();
  const job = prev.then(() => diff(guildId)).catch((e) => {
    console.error(`invite tracking in ${guildId} failed`, e);
    return { inviterId: null, code: null, how: "unknown" } as Join;
  });
  queue.set(guildId, job);
  pending.set(key, job);
  setTimeout(() => pending.delete(key), 60_000);
  return job;
}

async function diff(guildId: string): Promise<Join> {
  const before = snapshots.get(guildId);
  const after = await fetchInvites(guildId);
  if (after) snapshots.set(guildId, after);
  if (!before || !after) return { inviterId: null, code: null, how: "unknown" };
  const used = [...after].filter(([code, inv]) => inv.uses > (before.get(code)?.uses ?? 0));
  if (used.length === 1) return { inviterId: used[0][1].inviterId, code: used[0][0], how: "invite" };
  if (used.length === 0) {
    // Used up: a limited invite is deleted on its last use.
    const gone = (deleted.get(guildId) ?? []).filter((d) => Date.now() - d.at < DELETED_GRACE_MS);
    if (gone.length === 1) {
      deleted.set(guildId, []);
      return { inviterId: gone[0].inviterId, code: gone[0].code, how: "invite" };
    }
    const v = await fetchVanityUses(guildId);
    if (v !== null && v > (vanity.get(guildId) ?? v)) {
      vanity.set(guildId, v);
      return { inviterId: null, code: "vanity", how: "vanity" };
    }
    if (v !== null) vanity.set(guildId, v);
  }
  return { inviterId: null, code: null, how: "unknown" };
}

// ── Counting ──

export async function countsFor(guildId: string, userId: string): Promise<InviteCounts> {
  const r: any = (await sqlite.execute(
    `SELECT COUNT(*) AS joins, SUM(CASE WHEN left_at IS NOT NULL THEN 1 ELSE 0 END) AS left_count,
            SUM(CASE WHEN left_at IS NULL AND fake = 1 THEN 1 ELSE 0 END) AS fake
     FROM invite_joins WHERE guild_id = ? AND inviter_id = ?`,
    [guildId, userId],
  )).rows[0];
  const b: any = (await sqlite.execute("SELECT bonus FROM invite_bonus WHERE guild_id = ? AND user_id = ?", [guildId, userId])).rows[0];
  const joins = Number(r?.joins ?? 0);
  const left = Number(r?.left_count ?? 0);
  const fake = Number(r?.fake ?? 0);
  const bonus = Number(b?.bonus ?? 0);
  return { joins, left, fake, bonus, total: joins - left - fake + bonus };
}

async function joinMessage(guildId: string, userId: string, j: Join) {
  const s: any = (await sqlite.execute("SELECT channel_id, message FROM invite_settings WHERE guild_id = ?", [guildId])).rows[0];
  if (!s?.channel_id) return;
  const invites = j.inviterId ? (await countsFor(guildId, j.inviterId)).total : 0;
  const inviter = j.inviterId ? mention(j.inviterId) : j.how === "vanity" ? "the server's vanity link" : "someone GuildScribe couldn't work out";
  const content = fill(String(s.message || DEFAULT_JOIN_MESSAGE), { user: mention(userId), inviter, invites, code: j.code ?? "?" });
  await createMessage(String(s.channel_id), { content });
}

// ── Gateway ──

on("GUILD_CREATE", async (g: any) => {
  const guildId = String(g.id);
  await ensureGuild(guildId, undefined, () => Promise.resolve(g.name ? String(g.name) : null));
  if (await isCommandGroupEnabled(guildId, INVITES_GROUP)) await loadInvites(guildId);
});

on("INVITE_CREATE", (i: any) => {
  if (!i.guild_id) return;
  snapshots.get(String(i.guild_id))?.set(String(i.code), { uses: Number(i.uses ?? 0), inviterId: i.inviter?.id ? String(i.inviter.id) : null });
});

on("INVITE_DELETE", (i: any) => {
  if (!i.guild_id) return;
  const guildId = String(i.guild_id);
  const inv = snapshots.get(guildId)?.get(String(i.code));
  if (!inv) return;
  snapshots.get(guildId)!.delete(String(i.code));
  deleted.set(guildId, [...(deleted.get(guildId) ?? []).filter((d) => Date.now() - d.at < DELETED_GRACE_MS), { code: String(i.code), inviterId: inv.inviterId, at: Date.now() }]);
});

on("GUILD_MEMBER_ADD", async (m: any) => {
  const guildId = String(m.guild_id);
  if (m.user?.bot || !(await isCommandGroupEnabled(guildId, INVITES_GROUP))) return;
  const userId = String(m.user.id);
  const j = await resolveJoin(guildId, userId);
  const fake = Date.now() - accountCreatedAt(userId) < FAKE_UNDER_MS ? 1 : 0;
  await sqlite.execute(
    "INSERT OR REPLACE INTO invite_joins (guild_id, user_id, inviter_id, code, how, fake, joined_at, left_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
    [guildId, userId, j.inviterId === userId ? null : j.inviterId, j.code, j.how, fake, Date.now()],
  );
  await joinMessage(guildId, userId, j);
});

on("GUILD_MEMBER_REMOVE", async (m: any) => {
  await sqlite.execute("UPDATE invite_joins SET left_at = ? WHERE guild_id = ? AND user_id = ? AND left_at IS NULL", [Date.now(), String(m.guild_id), String(m.user?.id)]);
});

// ── /invites ──

export async function handleInvitesCommand(kind: string, ctx: LocalCtx): Promise<OutMessage> {
  if (!(await isCommandGroupEnabled(ctx.guildId, INVITES_GROUP))) {
    return msg("Invite tracking is switched off in this server. A moderator can turn it on with `/guildscribe feature name:invites state:on`.");
  }
  const a = ctx.a;
  const target = a.id("user") || ctx.userId;
  if (kind === "invites.show") {
    const c = await countsFor(ctx.guildId, target);
    return msg(`📨 ${target === ctx.userId ? "You have" : `${mention(target)} has`} **${c.total}** invite${c.total === 1 ? "" : "s"} (${c.joins} joined, ${c.left} left, ${c.fake} fake${c.bonus ? `, ${c.bonus > 0 ? "+" : ""}${c.bonus} bonus` : ""}).`);
  }
  if (kind === "invites.top") {
    const res = await sqlite.execute(
      `SELECT inviter_id AS user_id FROM invite_joins WHERE guild_id = ? AND inviter_id IS NOT NULL
       UNION SELECT user_id FROM invite_bonus WHERE guild_id = ?`,
      [ctx.guildId, ctx.guildId],
    );
    const rows = await Promise.all(res.rows.map(async (r: any) => ({ userId: String(r.user_id), c: await countsFor(ctx.guildId, String(r.user_id)) })));
    const top = rows.filter((r) => r.c.total > 0).sort((x, y) => y.c.total - x.c.total).slice(0, 10);
    if (!top.length) return msg("📨 Nobody has brought anyone in yet (that GuildScribe has seen).");
    return msg(["📨 **Top inviters**", ...top.map((r, i) => `**${i + 1}.** ${mention(r.userId)} · ${r.c.total} invite${r.c.total === 1 ? "" : "s"}`)].join("\n"));
  }
  if (kind === "invites.who") {
    const r: any = (await sqlite.execute("SELECT * FROM invite_joins WHERE guild_id = ? AND user_id = ?", [ctx.guildId, target])).rows[0];
    if (!r) return msg(`GuildScribe didn't see ${mention(target)} join (they joined before it was tracking, or while it was offline).`);
    const by = r.inviter_id ? `invited by ${mention(String(r.inviter_id))}${r.code ? ` (\`${r.code}\`)` : ""}` : r.how === "vanity" ? "came in through the vanity link" : "joined with an invite GuildScribe couldn't work out";
    return msg(`📨 ${mention(target)} ${by}, <t:${Math.floor(Number(r.joined_at) / 1000)}:R>.`);
  }
  if (!ctx.moderator) return msg("Only moderators (Manage Server or Manage Messages) can change invite tracking.");
  if (kind === "invites.bonus") {
    const amount = Number(a.s("amount"));
    await sqlite.execute(
      "INSERT INTO invite_bonus (guild_id, user_id, bonus) VALUES (?, ?, ?) ON CONFLICT (guild_id, user_id) DO UPDATE SET bonus = bonus + excluded.bonus",
      [ctx.guildId, target, amount],
    );
    return msg(`📨 ${mention(target)} now has **${(await countsFor(ctx.guildId, target)).total}** invites.`);
  }
  if (kind === "invites.log") {
    const channelId = a.b("off") ? null : a.id("channel") || ctx.channelId;
    const message = a.s("message") && a.s("message") !== "-" ? a.s("message").slice(0, 500) : DEFAULT_JOIN_MESSAGE;
    await sqlite.execute("INSERT OR REPLACE INTO invite_settings (guild_id, channel_id, message) VALUES (?, ?, ?)", [ctx.guildId, channelId, message]);
    await loadInvites(ctx.guildId);
    const canSee = snapshots.has(ctx.guildId);
    return msg([
      channelId ? `📨 Joins are announced in <#${channelId}>: ${message}` : "📨 Joins are no longer announced (invites are still counted).",
      canSee ? "" : "⚠️ GuildScribe can't see this server's invites: it needs **Manage Server**.",
    ].filter(Boolean).join("\n"));
  }
  return msg("Unknown /invites command.");
}
