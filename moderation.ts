// Moderation commands and cases, the way Sapphire (and most mod bots) do it.
//
//   /mod warn | timeout | untimeout | kick | ban | unban   each one is a
//          numbered case: who, by whom, why. The member gets a DM saying what
//          happened and why (before a kick or ban, while they can still get
//          it), and the server log (/mod log) gets an entry.
//   /mod purge        deletes up to 100 recent messages, or only one member's
//   /mod cases        a member's record (warnings and everything else)
//   /mod delcase      takes a case off the record
//   /mod log          the log channel, and whether it also gets deleted and
//                     edited messages and joins and leaves (modlog.ts)
//
// Each action needs the matching Discord permission (Kick Members, Ban
// Members, Timeout Members, Manage Messages), and nobody can act on someone
// whose highest role is at or above their own, the same rule Discord uses.
// GuildScribe needs those permissions too, with its role above the member's.

import { isCommandGroupEnabled } from "./game/db.ts";
import { sqlite } from "./game/sqlite.ts";
import type { LocalCtx } from "./commands.ts";
import { api, deleteMessage, getMember, sendDm, type OutMessage } from "./discord.ts";
import { guildInfo, Perm, selfId, topPosition } from "./guildcache.ts";
import { formatDuration, msg, parseDuration } from "./helpers.ts";
import { getLogSettings, LOG_GREEN, LOG_ORANGE, LOG_RED, logEvent, setLogSettings } from "./modlog.ts";

export const MODERATION_GROUP = "moderation";
const MAX_TIMEOUT = 28 * 86_400_000;
const BULK_MAX_AGE = 14 * 86_400_000 - 60_000;

export type CaseAction = "warn" | "timeout" | "untimeout" | "kick" | "ban" | "unban" | "honeypot" | "spam" | "raid" | "nuke";

const ACTION_LABEL: Record<CaseAction, string> = {
  warn: "⚠️ Warned", timeout: "🔇 Timed out", untimeout: "🔊 Timeout lifted", kick: "👢 Kicked", ban: "🔨 Banned", unban: "🕊️ Unbanned",
  honeypot: "🍯 Caught by the honeypot", spam: "🛡️ Anti-spam", raid: "🚨 Anti-raid", nuke: "☢️ Anti-nuke",
};
const ACTION_COLOR: Record<CaseAction, number> = {
  warn: LOG_ORANGE, timeout: LOG_ORANGE, untimeout: LOG_GREEN, kick: LOG_RED, ban: LOG_RED, unban: LOG_GREEN,
  honeypot: LOG_RED, spam: LOG_ORANGE, raid: LOG_RED, nuke: LOG_RED,
};

export async function ensureModerationTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS mod_cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      number INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      mod_id TEXT NOT NULL,
      action TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      duration_ms INTEGER,
      created_at INTEGER NOT NULL
    )`,
  );
  await sqlite.execute("CREATE INDEX IF NOT EXISTS mod_cases_user ON mod_cases (guild_id, user_id)");
}

/** Records a case and logs it; the case number in this server. Used by the honeypot and security too. */
export async function recordCase(guildId: string, c: { userId: string; modId: string; action: CaseAction; reason: string; durationMs?: number }): Promise<number> {
  const last: any = (await sqlite.execute("SELECT MAX(number) AS n FROM mod_cases WHERE guild_id = ?", [guildId])).rows[0];
  const number = Number(last?.n ?? 0) + 1;
  await sqlite.execute(
    "INSERT INTO mod_cases (guild_id, number, user_id, mod_id, action, reason, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [guildId, number, c.userId, c.modId, c.action, c.reason, c.durationMs ?? null, Date.now()],
  );
  await logEvent(guildId, "mod", {
    color: ACTION_COLOR[c.action],
    title: `${ACTION_LABEL[c.action]} · case #${number}`,
    fields: [
      { name: "Member", value: `<@${c.userId}> (${c.userId})`, inline: true },
      { name: "By", value: c.modId === selfId ? "GuildScribe" : `<@${c.modId}>`, inline: true },
      ...(c.durationMs ? [{ name: "For", value: formatDuration(c.durationMs), inline: true }] : []),
      { name: "Reason", value: c.reason || "*(none given)*" },
    ],
  });
  return number;
}

// ── Actions (also used by the honeypot and security) ──

export const timeoutMember = async (guildId: string, userId: string, ms: number, reason: string) =>
  (await api("PATCH", `/guilds/${guildId}/members/${userId}`, { communication_disabled_until: ms > 0 ? new Date(Date.now() + ms).toISOString() : null }, reason)) !== null;

export const kickMember = async (guildId: string, userId: string, reason: string) =>
  (await api("DELETE", `/guilds/${guildId}/members/${userId}`, undefined, reason)) !== null;

export const banMember = async (guildId: string, userId: string, reason: string, deleteSeconds = 0) =>
  (await api("PUT", `/guilds/${guildId}/bans/${userId}`, { delete_message_seconds: deleteSeconds }, reason)) !== null;

export const unbanMember = async (guildId: string, userId: string, reason: string) =>
  (await api("DELETE", `/guilds/${guildId}/bans/${userId}`, undefined, reason)) !== null;

// ── /mod ──

const NEEDS: Record<string, [bigint, string]> = {
  "mod.warn": [Perm.MODERATE_MEMBERS, "Timeout Members"],
  "mod.timeout": [Perm.MODERATE_MEMBERS, "Timeout Members"],
  "mod.untimeout": [Perm.MODERATE_MEMBERS, "Timeout Members"],
  "mod.kick": [Perm.KICK_MEMBERS, "Kick Members"],
  "mod.ban": [Perm.BAN_MEMBERS, "Ban Members"],
  "mod.unban": [Perm.BAN_MEMBERS, "Ban Members"],
  "mod.purge": [Perm.MANAGE_MESSAGES, "Manage Messages"],
  "mod.cases": [Perm.MODERATE_MEMBERS, "Timeout Members"],
  "mod.delcase": [Perm.MODERATE_MEMBERS, "Timeout Members"],
  "mod.log": [Perm.MANAGE_GUILD, "Manage Server"],
};

/** Why `modId` can't act on `targetId`, or null when they can. */
async function outranks(guildId: string, modId: string, modRoles: string[], targetId: string): Promise<string | null> {
  if (targetId === modId) return "You can't do that to yourself.";
  if (targetId === selfId) return "GuildScribe won't do that to itself.";
  const g = await guildInfo(guildId);
  if (g?.ownerId === targetId) return "That's the server owner.";
  const member = await getMember(guildId, targetId);
  if (!member) return null; // not in the server: only ban/unban get here
  const theirs = await topPosition(guildId, targetId, (member.roles ?? []).map(String));
  if (theirs >= await topPosition(guildId, modId, modRoles)) return `<@${targetId}>'s highest role is at or above yours.`;
  return null;
}

async function tell(userId: string, guildId: string, what: string, reason: string) {
  const name = (await guildInfo(guildId))?.name || "a server";
  return await sendDm(userId, { content: `${what} in **${name}**.${reason ? `\nReason: ${reason}` : ""}` });
}

export async function handleModCommand(kind: string, ctx: LocalCtx): Promise<OutMessage> {
  if (!(await isCommandGroupEnabled(ctx.guildId, MODERATION_GROUP))) {
    return msg("Moderation is switched off in this server. A moderator can turn it on with `/guildscribe feature name:moderation state:on`.");
  }
  const need = NEEDS[kind];
  if (need && !(ctx.permissions & need[0]) && !(ctx.permissions & Perm.ADMINISTRATOR)) return msg(`That needs the **${need[1]}** permission.`);
  const a = ctx.a;
  const reason = a.s("reason").slice(0, 400);
  const target = a.id("user");
  const audit = `${ctx.display}: ${reason || "no reason given"}`;

  if (kind === "mod.log") {
    const s = await getLogSettings(ctx.guildId);
    const next = {
      channelId: a.b("off") ? null : a.id("channel") || s.channelId,
      messages: a.s("messages") ? a.b("messages") : s.messages,
      members: a.s("members") ? a.b("members") : s.members,
    };
    await setLogSettings(ctx.guildId, next);
    if (!next.channelId) return msg("📋 Server log is off.");
    return msg([
      `📋 Server log: <#${next.channelId}>`,
      "Moderation, honeypot and security actions always go there.",
      `Deleted and edited messages: ${next.messages ? "yes" : "no"} · joins and leaves: ${next.members ? "yes" : "no"}`,
    ].join("\n"));
  }

  if (kind === "mod.purge") {
    const count = Number(a.s("count"));
    const listed: any[] = (await api("GET", `/channels/${ctx.channelId}/messages?limit=100`)) ?? [];
    const cutoff = Date.now() - BULK_MAX_AGE;
    const ids = listed
      .filter((m) => !target || String(m.author?.id) === target)
      .filter((m) => Date.parse(m.timestamp) > cutoff && !m.pinned)
      .slice(0, count)
      .map((m) => String(m.id));
    if (!ids.length) return msg("Nothing to delete (Discord only bulk-deletes messages under 14 days old; pinned ones are kept).");
    const ok = ids.length === 1 ? await deleteMessage(ctx.channelId, ids[0], audit) : (await api("POST", `/channels/${ctx.channelId}/messages/bulk-delete`, { messages: ids }, audit)) !== null;
    return { content: ok ? `🧹 Deleted ${ids.length} message${ids.length === 1 ? "" : "s"}${target ? ` from <@${target}>` : ""}.` : "Couldn't delete them. GuildScribe needs Manage Messages and Read Message History here.", ephemeral: true };
  }

  if (kind === "mod.cases") {
    const res = await sqlite.execute("SELECT * FROM mod_cases WHERE guild_id = ? AND user_id = ? ORDER BY number DESC LIMIT 20", [ctx.guildId, target]);
    if (!res.rows.length) return msg(`<@${target}> has a clean record.`);
    const warns = res.rows.filter((r: any) => r.action === "warn").length;
    const lines = res.rows.map((r: any) =>
      `**#${r.number}** ${ACTION_LABEL[r.action as CaseAction] ?? r.action}${r.duration_ms ? ` (${formatDuration(Number(r.duration_ms))})` : ""} · <t:${Math.floor(Number(r.created_at) / 1000)}:d> · ${r.mod_id === selfId ? "GuildScribe" : `<@${r.mod_id}>`}${r.reason ? ` · ${r.reason}` : ""}`
    );
    return msg([`📁 **<@${target}>'s record** · ${warns} warning${warns === 1 ? "" : "s"}`, ...lines].join("\n").slice(0, 2000));
  }
  if (kind === "mod.delcase") {
    const res = await sqlite.execute("DELETE FROM mod_cases WHERE guild_id = ? AND number = ?", [ctx.guildId, Number(a.s("case"))]);
    return msg(res.rowsAffected ? `🗑️ Case #${a.s("case")} is off the record.` : `There's no case #${a.s("case")}.`);
  }

  if (kind === "mod.unban") {
    if (!(await unbanMember(ctx.guildId, target, audit))) return msg(`Couldn't unban <@${target}>: they may not be banned, or GuildScribe lacks Ban Members.`);
    const n = await recordCase(ctx.guildId, { userId: target, modId: ctx.userId, action: "unban", reason });
    return msg(`🕊️ <@${target}> is unbanned (case #${n}).`);
  }

  const why = await outranks(ctx.guildId, ctx.userId, ctx.roles, target);
  if (why) return msg(why);
  const inServer = kind === "mod.ban" ? Boolean(await getMember(ctx.guildId, target)) : true;
  const fail = (what: string, perm: string) => msg(`Couldn't ${what} <@${target}>. GuildScribe needs **${perm}**, with its role above theirs.`);

  if (kind === "mod.warn") {
    const n = await recordCase(ctx.guildId, { userId: target, modId: ctx.userId, action: "warn", reason });
    const warns = Number(((await sqlite.execute("SELECT COUNT(*) AS n FROM mod_cases WHERE guild_id = ? AND user_id = ? AND action = 'warn'", [ctx.guildId, target])).rows[0] as any).n);
    const dm = await tell(target, ctx.guildId, "⚠️ You were warned", reason);
    return msg(`⚠️ <@${target}> is warned (case #${n}; warning ${warns}).${dm ? "" : " They don't take DMs, so they weren't told."}`);
  }
  if (kind === "mod.timeout") {
    const ms = parseDuration(a.s("duration"));
    if (!ms || ms > MAX_TIMEOUT) return msg(`"${a.s("duration")}" isn't a timeout Discord allows: anything from \`1m\` to \`28d\`.`);
    if (!(await timeoutMember(ctx.guildId, target, ms, audit))) return fail("time out", "Timeout Members");
    const n = await recordCase(ctx.guildId, { userId: target, modId: ctx.userId, action: "timeout", reason, durationMs: ms });
    await tell(target, ctx.guildId, `🔇 You were timed out for ${formatDuration(ms)}`, reason);
    return msg(`🔇 <@${target}> is timed out for ${formatDuration(ms)} (case #${n}).`);
  }
  if (kind === "mod.untimeout") {
    if (!(await timeoutMember(ctx.guildId, target, 0, audit))) return fail("lift the timeout on", "Timeout Members");
    const n = await recordCase(ctx.guildId, { userId: target, modId: ctx.userId, action: "untimeout", reason });
    return msg(`🔊 <@${target}> can talk again (case #${n}).`);
  }
  if (kind === "mod.kick") {
    const dm = await tell(target, ctx.guildId, "👢 You were kicked", reason);
    if (!(await kickMember(ctx.guildId, target, audit))) return fail("kick", "Kick Members");
    const n = await recordCase(ctx.guildId, { userId: target, modId: ctx.userId, action: "kick", reason });
    return msg(`👢 <@${target}> is kicked (case #${n}).${dm ? "" : " They don't take DMs, so they weren't told why."}`);
  }
  if (kind === "mod.ban") {
    const days = Number(a.s("delete_days") || 0);
    if (inServer) await tell(target, ctx.guildId, "🔨 You were banned", reason);
    if (!(await banMember(ctx.guildId, target, audit, days * 86400))) return fail("ban", "Ban Members");
    const n = await recordCase(ctx.guildId, { userId: target, modId: ctx.userId, action: "ban", reason });
    return msg(`🔨 <@${target}> is banned (case #${n})${days ? `, and their messages from the last ${days} day${days === 1 ? "" : "s"} are gone` : ""}.`);
  }
  return msg("Unknown /mod command.");
}
