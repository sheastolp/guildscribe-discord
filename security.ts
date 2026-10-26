// Security: anti-spam, anti-raid and anti-nuke, the protections the Security
// bot (securitybot.gg) is known for. Everything starts off; /security turns
// each part on.
//
//   anti-spam   someone sending too many messages too fast (default 6 in 5
//               seconds), or pinging too many people at once (default 5),
//               is timed out (default 10 minutes) and those messages
//               deleted. Optionally, Discord invite links from members are
//               deleted.
//   anti-raid   too many joins too fast (default 10 in 10 seconds) starts
//               raid mode for 10 minutes: everyone joining meanwhile is
//               kicked with a DM saying to try again later. Accounts younger
//               than a set age can be kept out at any time. /security
//               raidmode turns raid mode on or off by hand.
//   anti-nuke   someone deleting channels or roles, or banning or kicking
//               members, faster than the limit (default 3 in a minute) has
//               every role taken off them (a bot is kicked), and the owner
//               gets a DM. That stops a hacked admin or a rogue bot from
//               wiping the server. The owner, GuildScribe and trusted
//               members (/security trust) are never stopped.
//
// Moderators, bots and trusted members are never caught by anti-spam. Every
// action is a case in the mod record and goes in the server log.
//
// Needs the Gateway (Server Members and Message Content intents) and
// GuildScribe with Timeout Members, Kick Members, Manage Messages, Manage
// Roles and View Audit Log, its role as high as it can go: it can only
// stop people below it.

import { isCommandGroupEnabled } from "./game/db.ts";
import { sqlite } from "./game/sqlite.ts";
import type { LocalCtx } from "./commands.ts";
import { api, deleteMessage, getMember, sendDm, type OutMessage } from "./discord.ts";
import { on } from "./gateway.ts";
import { guildInfo, isModeratorMember, Perm, selfId } from "./guildcache.ts";
import { formatDuration, idList, mention, msg } from "./helpers.ts";
import { accountCreatedAt } from "./invites.ts";
import { kickMember, recordCase, timeoutMember } from "./moderation.ts";
import { LOG_RED, logEvent } from "./modlog.ts";

export const SECURITY_GROUP = "security";
const RAID_MODE_MS = 10 * 60_000;
const NUKE_WINDOW_MS = 60_000;
const INVITE_LINK = /(?:discord(?:app)?\.com\/invite|discord\.gg|discord\.me|dsc\.gg)\/[\w-]+/i;
/** Audit log actions anti-nuke counts. */
const NUKE_ACTIONS: Record<number, string> = { 12: "deleted a channel", 32: "deleted a role", 22: "banned a member", 20: "kicked a member" };

export interface SecuritySettings {
  antispam: boolean;
  spamMessages: number;
  spamSeconds: number;
  maxMentions: number;
  blockInvites: boolean;
  spamTimeoutMinutes: number;
  antiraid: boolean;
  raidJoins: number;
  raidSeconds: number;
  minAccountDays: number;
  raidUntil: number;
  antinuke: boolean;
  nukeLimit: number;
  trusted: string[];
}

export async function ensureSecurityTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS security_settings (
      guild_id TEXT PRIMARY KEY,
      antispam INTEGER NOT NULL DEFAULT 0,
      spam_messages INTEGER NOT NULL DEFAULT 6,
      spam_seconds INTEGER NOT NULL DEFAULT 5,
      max_mentions INTEGER NOT NULL DEFAULT 5,
      block_invites INTEGER NOT NULL DEFAULT 0,
      spam_timeout_min INTEGER NOT NULL DEFAULT 10,
      antiraid INTEGER NOT NULL DEFAULT 0,
      raid_joins INTEGER NOT NULL DEFAULT 10,
      raid_seconds INTEGER NOT NULL DEFAULT 10,
      min_account_days INTEGER NOT NULL DEFAULT 0,
      raid_until INTEGER NOT NULL DEFAULT 0,
      antinuke INTEGER NOT NULL DEFAULT 0,
      nuke_limit INTEGER NOT NULL DEFAULT 3,
      trusted TEXT NOT NULL DEFAULT ''
    )`,
  );
}

export async function getSecurity(guildId: string): Promise<SecuritySettings> {
  const r: any = (await sqlite.execute("SELECT * FROM security_settings WHERE guild_id = ?", [guildId])).rows[0];
  return {
    antispam: Number(r?.antispam ?? 0) === 1,
    spamMessages: Number(r?.spam_messages ?? 6),
    spamSeconds: Number(r?.spam_seconds ?? 5),
    maxMentions: Number(r?.max_mentions ?? 5),
    blockInvites: Number(r?.block_invites ?? 0) === 1,
    spamTimeoutMinutes: Number(r?.spam_timeout_min ?? 10),
    antiraid: Number(r?.antiraid ?? 0) === 1,
    raidJoins: Number(r?.raid_joins ?? 10),
    raidSeconds: Number(r?.raid_seconds ?? 10),
    minAccountDays: Number(r?.min_account_days ?? 0),
    raidUntil: Number(r?.raid_until ?? 0),
    antinuke: Number(r?.antinuke ?? 0) === 1,
    nukeLimit: Number(r?.nuke_limit ?? 3),
    trusted: idList(r?.trusted),
  };
}

async function saveSecurity(guildId: string, s: SecuritySettings) {
  await sqlite.execute(
    `INSERT OR REPLACE INTO security_settings (guild_id, antispam, spam_messages, spam_seconds, max_mentions, block_invites, spam_timeout_min,
       antiraid, raid_joins, raid_seconds, min_account_days, raid_until, antinuke, nuke_limit, trusted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [guildId, +s.antispam, s.spamMessages, s.spamSeconds, s.maxMentions, +s.blockInvites, s.spamTimeoutMinutes, +s.antiraid, s.raidJoins, s.raidSeconds, s.minAccountDays, s.raidUntil, +s.antinuke, s.nukeLimit, s.trusted.join(",")],
  );
}

async function active(guildId: string): Promise<SecuritySettings | null> {
  return (await isCommandGroupEnabled(guildId, SECURITY_GROUP)) ? await getSecurity(guildId) : null;
}

// ── Anti-spam ──

const recent = new Map<string, Array<{ at: number; channelId: string; id: string }>>();
const punished = new Map<string, number>();

/** One message: returns what was done ("flood", "mentions", "invite") or null. */
export async function checkMessage(m: any, now = Date.now()): Promise<string | null> {
  if (!m.guild_id || m.author?.bot || m.webhook_id || String(m.author?.id) === selfId) return null;
  const guildId = String(m.guild_id);
  const s = await active(guildId);
  if (!s?.antispam) return null;
  const userId = String(m.author.id);
  if (s.trusted.includes(userId) || await isModeratorMember(guildId, userId, (m.member?.roles ?? []).map(String))) return null;
  const channelId = String(m.channel_id);
  const key = `${guildId}:${userId}`;

  if (s.blockInvites && INVITE_LINK.test(String(m.content ?? ""))) {
    await deleteMessage(channelId, String(m.id), "Anti-spam: invite link");
    await recordCase(guildId, { userId, modId: selfId, action: "spam", reason: `Posted an invite link in <#${channelId}>` });
    return "invite";
  }
  const pings = (m.mentions ?? []).filter((u: any) => String(u.id) !== userId).length + (m.mention_roles ?? []).length + (m.mention_everyone ? 1 : 0);
  const window = [...(recent.get(key) ?? []).filter((x) => now - x.at < s.spamSeconds * 1000), { at: now, channelId, id: String(m.id) }];
  recent.set(key, window);
  const flood = window.length >= s.spamMessages;
  if (pings <= s.maxMentions && !flood) return null;
  if (now - (punished.get(key) ?? 0) < 10_000) {
    await deleteMessage(channelId, String(m.id), "Anti-spam");
    return null;
  }
  punished.set(key, now);
  recent.delete(key);
  const what = flood ? "flood" : "mentions";
  const reason = flood ? `Sent ${window.length} messages in under ${s.spamSeconds}s` : `Pinged ${pings} people/roles in one message`;
  const ms = s.spamTimeoutMinutes * 60_000;
  await timeoutMember(guildId, userId, ms, `Anti-spam: ${reason}`);
  for (const x of flood ? window : [window.at(-1)!]) await deleteMessage(x.channelId, x.id, "Anti-spam");
  await recordCase(guildId, { userId, modId: selfId, action: "spam", reason, durationMs: ms });
  await sendDm(userId, { content: `🛡️ You were timed out for ${formatDuration(ms)} in **${(await guildInfo(guildId))?.name ?? "a server"}** for spam: ${reason.toLowerCase()}.` });
  return what;
}

on("MESSAGE_CREATE", (m: any) => checkMessage(m));

// ── Anti-raid ──

const joins = new Map<string, number[]>();

/** One join: returns "young", "raid" or null. */
export async function checkJoin(m: any, now = Date.now()): Promise<string | null> {
  const guildId = String(m.guild_id);
  const s = await active(guildId);
  if (!s || m.user?.bot) return null;
  const userId = String(m.user.id);
  const say = async (dm: string, reason: string, kind: string) => {
    await sendDm(userId, { content: dm });
    await kickMember(guildId, userId, `Anti-raid: ${reason}`);
    await recordCase(guildId, { userId, modId: selfId, action: "raid", reason });
    return kind;
  };
  const name = (await guildInfo(guildId))?.name ?? "the server";
  if (s.minAccountDays > 0 && now - accountCreatedAt(userId) < s.minAccountDays * 86_400_000) {
    return await say(`🛡️ **${name}** only lets in accounts at least ${s.minAccountDays} day${s.minAccountDays === 1 ? "" : "s"} old. Come back then!`, `Account under ${s.minAccountDays} days old`, "young");
  }
  if (!s.antiraid && s.raidUntil <= now) return null;
  const window = [...(joins.get(guildId) ?? []).filter((t) => now - t < s.raidSeconds * 1000), now];
  joins.set(guildId, window);
  if (s.raidUntil <= now && s.antiraid && window.length >= s.raidJoins) {
    s.raidUntil = now + RAID_MODE_MS;
    await saveSecurity(guildId, s);
    await logEvent(guildId, "mod", { color: LOG_RED, title: "🚨 Raid mode on", description: `${window.length} joins in ${s.raidSeconds}s. Everyone joining in the next ${formatDuration(RAID_MODE_MS)} is kicked. \`/security raidmode state:off\` ends it.` });
  }
  if (s.raidUntil > now) return await say(`🛡️ **${name}** is under a raid and not letting anyone in right now. Try again in a few minutes.`, "Joined during raid mode", "raid");
  return null;
}

const verdicts = new Map<string, Promise<string | null>>();

/** checkJoin, once per join: welcome.ts asks too, so a raider kicked at the door isn't greeted. */
export function joinVerdict(m: any): Promise<string | null> {
  const key = `${m.guild_id}:${m.user?.id}`;
  let v = verdicts.get(key);
  if (!v) {
    v = checkJoin(m).catch((e) => {
      console.error("anti-raid failed", e);
      return null;
    });
    verdicts.set(key, v);
    setTimeout(() => verdicts.delete(key), 60_000);
  }
  return v;
}

on("GUILD_MEMBER_ADD", (m: any) => joinVerdict(m));

// ── Anti-nuke ──

const nukes = new Map<string, number[]>();

/** One audit log entry: returns true when it stopped someone. */
export async function checkAudit(e: any, now = Date.now()): Promise<boolean> {
  const label = NUKE_ACTIONS[Number(e.action_type)];
  if (!label || !e.user_id) return false;
  const guildId = String(e.guild_id);
  const s = await active(guildId);
  if (!s?.antinuke) return false;
  const userId = String(e.user_id);
  const g = await guildInfo(guildId);
  if (userId === selfId || userId === g?.ownerId || s.trusted.includes(userId)) return false;
  const key = `${guildId}:${userId}`;
  const window = [...(nukes.get(key) ?? []).filter((t) => now - t < NUKE_WINDOW_MS), now];
  nukes.set(key, window);
  if (window.length < s.nukeLimit) return false;
  nukes.delete(key);
  const reason = `Anti-nuke: ${label} ${window.length} times in a minute`;
  const member = await getMember(guildId, userId);
  const isBot = Boolean(member?.user?.bot);
  const stopped = isBot ? await kickMember(guildId, userId, reason) : (await api("PATCH", `/guilds/${guildId}/members/${userId}`, { roles: [] }, reason)) !== null;
  await recordCase(guildId, { userId, modId: selfId, action: "nuke", reason: `${reason}. ${stopped ? (isBot ? "Kicked (a bot)." : "All roles taken away.") : "Couldn't stop them: GuildScribe's role is below theirs!"}` });
  if (g?.ownerId) {
    await sendDm(g.ownerId, {
      content: `☢️ **Anti-nuke in ${g.name}:** ${mention(userId)} ${label} ${window.length} times in a minute. ${stopped ? (isBot ? "The bot was kicked." : "Every role was taken off them.") : "**GuildScribe couldn't stop them** (its role is below theirs). Check the server now."}\nIf it was on purpose, give their roles back and \`/security trust\` them.`,
    });
  }
  return stopped;
}

on("GUILD_AUDIT_LOG_ENTRY_CREATE", (e: any) => checkAudit(e));

// ── /security ──

export async function handleSecurityCommand(kind: string, ctx: LocalCtx): Promise<OutMessage> {
  if (!(await isCommandGroupEnabled(ctx.guildId, SECURITY_GROUP))) {
    return msg("Security is switched off in this server. A moderator can turn it on with `/guildscribe feature name:security state:on`.");
  }
  if (!(ctx.permissions & (Perm.MANAGE_GUILD | Perm.ADMINISTRATOR))) return msg("Security settings need the **Manage Server** permission.");
  const a = ctx.a;
  const s = await getSecurity(ctx.guildId);
  const num = (name: string, fallback: number) => a.s(name) ? Number(a.s(name)) : fallback;
  const onOff = (name: string, fallback: boolean) => a.s(name) ? a.b(name) : fallback;

  if (kind === "security.antispam") {
    Object.assign(s, { antispam: onOff("enabled", s.antispam), spamMessages: num("messages", s.spamMessages), spamSeconds: num("seconds", s.spamSeconds), maxMentions: num("mentions", s.maxMentions), blockInvites: onOff("invites", s.blockInvites), spamTimeoutMinutes: num("timeout", s.spamTimeoutMinutes) });
  } else if (kind === "security.antiraid") {
    Object.assign(s, { antiraid: onOff("enabled", s.antiraid), raidJoins: num("joins", s.raidJoins), raidSeconds: num("seconds", s.raidSeconds), minAccountDays: num("account_age", s.minAccountDays) });
  } else if (kind === "security.antinuke") {
    Object.assign(s, { antinuke: onOff("enabled", s.antinuke), nukeLimit: num("limit", s.nukeLimit) });
  } else if (kind === "security.trust") {
    const userId = a.id("user");
    s.trusted = s.trusted.includes(userId) ? s.trusted.filter((u) => u !== userId) : [...s.trusted, userId];
  } else if (kind === "security.raidmode") {
    s.raidUntil = a.s("state") === "on" ? Date.now() + RAID_MODE_MS : 0;
    await logEvent(ctx.guildId, "mod", { color: LOG_RED, title: s.raidUntil ? "🚨 Raid mode on" : "✅ Raid mode off", description: `By ${mention(ctx.userId)}` });
  } else if (kind !== "security.status") {
    return msg("Unknown /security command.");
  }
  if (kind !== "security.status") await saveSecurity(ctx.guildId, s);
  const yes = (b: boolean) => b ? "🟢 on" : "⚫ off";
  const raid = s.raidUntil > Date.now() ? `🚨 **Raid mode until <t:${Math.floor(s.raidUntil / 1000)}:t>** (\`/security raidmode state:off\` ends it)` : "";
  return msg([
    "🛡️ **Security**",
    `**Anti-spam** ${yes(s.antispam)} · ${s.spamMessages} messages in ${s.spamSeconds}s or ${s.maxMentions + 1}+ pings → ${s.spamTimeoutMinutes}m timeout · invite links ${s.blockInvites ? "deleted" : "allowed"}`,
    `**Anti-raid** ${yes(s.antiraid)} · ${s.raidJoins} joins in ${s.raidSeconds}s starts raid mode · ${s.minAccountDays ? `accounts under ${s.minAccountDays} day${s.minAccountDays === 1 ? "" : "s"} old are kicked` : "any account age"}`,
    `**Anti-nuke** ${yes(s.antinuke)} · ${s.nukeLimit} channel/role deletes, bans or kicks in a minute → roles taken away`,
    `**Trusted:** ${s.trusted.map(mention).join(" ") || "nobody (the owner always is)"}`,
    raid,
    s.antispam || s.antiraid || s.antinuke ? "GuildScribe can only stop members whose roles are below its own: move its role as high as you can." : "",
  ].filter(Boolean).join("\n"));
}
