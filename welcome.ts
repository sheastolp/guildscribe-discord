// Welcome and goodbye messages, a welcome DM and roles for new members, the
// parts of Sapphire people use most.
//
//   /welcome message   the channel and text new members are greeted with
//   /welcome leave     the channel and text when someone leaves
//   /welcome dm        a DM to each new member
//   /welcome autorole  roles every new member gets (up to 5; humans only)
//   /welcome test      shows the messages as if you'd just joined
//   /welcome status    what's set
//
// Placeholders: {user} (a mention), {username}, {server}, {count} (members,
// with an ordinal: "you're our 42nd member" → {count}), {inviter} (who
// invited them, from invite tracking, invites.ts).
//
// Joins and leaves also go in the server log when it takes them (modlog.ts).
// Needs the Gateway with the Server Members intent.

import { isCommandGroupEnabled } from "./game/db.ts";
import { sqlite } from "./game/sqlite.ts";
import type { LocalCtx } from "./commands.ts";
import { addRole, createMessage, sendDm, type OutMessage } from "./discord.ts";
import { on } from "./gateway.ts";
import { guildInfo, memberCount } from "./guildcache.ts";
import { fill, idList, mention, msg } from "./helpers.ts";
import { accountCreatedAt, INVITES_GROUP, resolveJoin } from "./invites.ts";
import { LOG_GREEN, LOG_RED, logEvent } from "./modlog.ts";
import { joinVerdict } from "./security.ts";

export const WELCOME_GROUP = "welcome";
const MAX_AUTOROLES = 5;
export const DEFAULT_WELCOME = "👋 Welcome to **{server}**, {user}! You're our {count} member.";
export const DEFAULT_LEAVE = "👋 **{username}** has left the server.";

export interface WelcomeSettings {
  channelId: string | null;
  message: string;
  leaveChannelId: string | null;
  leaveMessage: string;
  dmMessage: string | null;
  autoroles: string[];
}

export async function ensureWelcomeTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS welcome_settings (
      guild_id TEXT PRIMARY KEY,
      channel_id TEXT,
      message TEXT,
      leave_channel_id TEXT,
      leave_message TEXT,
      dm_message TEXT,
      autoroles TEXT NOT NULL DEFAULT ''
    )`,
  );
}

export async function getWelcome(guildId: string): Promise<WelcomeSettings> {
  const r: any = (await sqlite.execute("SELECT * FROM welcome_settings WHERE guild_id = ?", [guildId])).rows[0];
  return {
    channelId: r?.channel_id ? String(r.channel_id) : null,
    message: r?.message ? String(r.message) : DEFAULT_WELCOME,
    leaveChannelId: r?.leave_channel_id ? String(r.leave_channel_id) : null,
    leaveMessage: r?.leave_message ? String(r.leave_message) : DEFAULT_LEAVE,
    dmMessage: r?.dm_message ? String(r.dm_message) : null,
    autoroles: idList(r?.autoroles),
  };
}

async function saveWelcome(guildId: string, s: WelcomeSettings) {
  await sqlite.execute(
    "INSERT OR REPLACE INTO welcome_settings (guild_id, channel_id, message, leave_channel_id, leave_message, dm_message, autoroles) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [guildId, s.channelId, s.message, s.leaveChannelId, s.leaveMessage, s.dmMessage, s.autoroles.join(",")],
  );
}

export function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n.toLocaleString("en-US")}${s}`;
}

async function vars(guildId: string, user: any, inviterId: string | null | undefined): Promise<Record<string, string>> {
  const g = await guildInfo(guildId);
  const count = memberCount(guildId);
  return {
    user: mention(String(user.id)),
    username: String(user.global_name || user.username || "someone"),
    server: g?.name || "the server",
    count: count ? ordinal(count) : "newest",
    inviter: inviterId ? mention(inviterId) : "someone",
  };
}

async function greet(guildId: string, user: any, s: WelcomeSettings) {
  const invitesOn = await isCommandGroupEnabled(guildId, INVITES_GROUP);
  const needsInviter = invitesOn && [s.message, s.dmMessage ?? ""].some((t) => t.includes("{inviter}"));
  const join = needsInviter ? await resolveJoin(guildId, String(user.id)) : null;
  const v = await vars(guildId, user, join?.inviterId);
  if (s.channelId) await createMessage(s.channelId, { content: fill(s.message, v).slice(0, 2000), ping: [String(user.id)] });
  if (s.dmMessage) await sendDm(String(user.id), { content: fill(s.dmMessage, { ...v, user: v.username }).slice(0, 2000) });
}

on("GUILD_MEMBER_ADD", async (m: any) => {
  const guildId = String(m.guild_id);
  const user = m.user ?? {};
  const age = Date.now() - accountCreatedAt(String(user.id));
  await logEvent(guildId, "members", {
    color: LOG_GREEN,
    title: "📥 Member joined",
    description: `${mention(String(user.id))} · ${user.username ?? ""}`,
    fields: [{ name: "Account made", value: `<t:${Math.floor(accountCreatedAt(String(user.id)) / 1000)}:R>${age < 7 * 86_400_000 ? " ⚠️ new account" : ""}`, inline: true }],
    ...(user.avatar ? { thumbnail: { url: `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` } } : {}),
  });
  if (!(await isCommandGroupEnabled(guildId, WELCOME_GROUP))) return;
  if (await joinVerdict(m)) return; // kicked at the door by anti-raid
  const s = await getWelcome(guildId);
  // Members still screening (rules to accept) get their roles when they pass (GUILD_MEMBER_UPDATE).
  if (!user.bot && m.pending) screening.add(`${guildId}:${user.id}`);
  else if (!user.bot) for (const r of s.autoroles) await addRole(guildId, String(user.id), r, "Autorole");
  if (!user.bot) await greet(guildId, user, s);
});

/** Members who joined but haven't accepted the rules yet. */
const screening = new Set<string>();

on("GUILD_MEMBER_UPDATE", async (m: any) => {
  // Passed membership screening: the autoroles they were waiting for.
  const key = `${m.guild_id}:${m.user?.id}`;
  if (m.pending !== false || !screening.delete(key)) return;
  const guildId = String(m.guild_id);
  const s = await getWelcome(guildId);
  const has: string[] = (m.roles ?? []).map(String);
  for (const r of s.autoroles.filter((r) => !has.includes(r))) await addRole(guildId, String(m.user.id), r, "Autorole (passed screening)");
});

on("GUILD_MEMBER_REMOVE", async (m: any) => {
  const guildId = String(m.guild_id);
  const user = m.user ?? {};
  await logEvent(guildId, "members", { color: LOG_RED, title: "📤 Member left", description: `${mention(String(user.id))} · ${user.username ?? ""}` });
  if (user.bot || !(await isCommandGroupEnabled(guildId, WELCOME_GROUP))) return;
  const s = await getWelcome(guildId);
  if (s.leaveChannelId) await createMessage(s.leaveChannelId, { content: fill(s.leaveMessage, await vars(guildId, user, null)).slice(0, 2000) });
});

// ── /welcome ──

export async function handleWelcomeCommand(kind: string, ctx: LocalCtx): Promise<OutMessage> {
  if (!(await isCommandGroupEnabled(ctx.guildId, WELCOME_GROUP))) {
    return msg("Welcome messages are switched off in this server. A moderator can turn them on with `/guildscribe feature name:welcome state:on`.");
  }
  if (!ctx.moderator) return msg("Only moderators (Manage Server or Manage Messages) can change welcome messages.");
  const a = ctx.a;
  const s = await getWelcome(ctx.guildId);
  const text = (fallback: string) => a.s("message") === "-" ? fallback : a.s("message").slice(0, 1000);

  if (kind === "welcome.message") {
    const next = { ...s, channelId: a.b("off") ? null : a.id("channel") || s.channelId || ctx.channelId, message: a.s("message") ? text(DEFAULT_WELCOME) : s.message };
    await saveWelcome(ctx.guildId, next);
    return msg(next.channelId ? `👋 New members are greeted in <#${next.channelId}>: ${next.message}` : "👋 No more welcome messages.");
  }
  if (kind === "welcome.leave") {
    const next = { ...s, leaveChannelId: a.b("off") ? null : a.id("channel") || s.leaveChannelId || ctx.channelId, leaveMessage: a.s("message") ? text(DEFAULT_LEAVE) : s.leaveMessage };
    await saveWelcome(ctx.guildId, next);
    return msg(next.leaveChannelId ? `👋 Leaving members are seen off in <#${next.leaveChannelId}>: ${next.leaveMessage}` : "👋 No more goodbye messages.");
  }
  if (kind === "welcome.dm") {
    const next = { ...s, dmMessage: a.b("off") || a.s("message") === "-" ? null : a.s("message").slice(0, 1000) || s.dmMessage };
    await saveWelcome(ctx.guildId, next);
    return msg(next.dmMessage ? `✉️ New members get this DM: ${next.dmMessage}` : "✉️ New members get no DM.");
  }
  if (kind === "welcome.autorole") {
    const roleId = a.id("role");
    if (roleId === ctx.guildId) return msg("Everyone has @everyone already.");
    const has = s.autoroles.includes(roleId);
    if (!has && s.autoroles.length >= MAX_AUTOROLES) return msg(`At most ${MAX_AUTOROLES} autoroles. Remove one first (pick it again).`);
    const next = { ...s, autoroles: has ? s.autoroles.filter((r) => r !== roleId) : [...s.autoroles, roleId] };
    await saveWelcome(ctx.guildId, next);
    return msg(has ? `🎭 New members no longer get <@&${roleId}>.` : `🎭 New members now get <@&${roleId}>. (GuildScribe needs Manage Roles, with its role above it.)`);
  }
  if (kind === "welcome.test") {
    const me = { id: ctx.userId, username: ctx.display };
    const v = await vars(ctx.guildId, me, ctx.userId);
    return msg([
      `**Welcome** ${s.channelId ? `(<#${s.channelId}>)` : "(off)"}: ${fill(s.message, v)}`,
      `**Goodbye** ${s.leaveChannelId ? `(<#${s.leaveChannelId}>)` : "(off)"}: ${fill(s.leaveMessage, v)}`,
      `**DM**: ${s.dmMessage ? fill(s.dmMessage, { ...v, user: v.username }) : "(off)"}`,
    ].join("\n"));
  }
  if (kind === "welcome.status") {
    return msg([
      "👋 **Welcome**",
      `Greeting: ${s.channelId ? `<#${s.channelId}> · ${s.message}` : "off"}`,
      `Goodbye: ${s.leaveChannelId ? `<#${s.leaveChannelId}> · ${s.leaveMessage}` : "off"}`,
      `DM: ${s.dmMessage ?? "off"}`,
      `Autoroles: ${s.autoroles.map((r) => `<@&${r}>`).join(" ") || "none"}`,
    ].join("\n"));
  }
  return msg("Unknown /welcome command.");
}
