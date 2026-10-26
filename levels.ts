// Levels: XP for chatting, level-up messages and role rewards, the way
// Arcane (and MEE6) do it.
//
//   chatting     each message earns 15–25 XP, at most once a minute
//                (both set with /levels settings). Bots, and channels or
//                roles set with /levels noxp, earn nothing.
//   levels       going from level L to L+1 takes 5L² + 50L + 100 XP, the
//                curve Arcane and MEE6 use, so levels feel the same.
//   level-up     a message where they chatted (or by DM, or in one channel,
//                or not at all), with {user} {username} {level}.
//   rewards      /levels reward add level:10 role:@Regular. Reaching a level
//                gives every reward up to it; with stack off, only the
//                highest is kept.
//   /rank        a member's level, progress and place on the server.
//   /levels top  the leaderboard.
//
// XP comes from the Gateway's MESSAGE_CREATE (gateway.ts). Starts off in a
// new server: /guildscribe feature name:levels state:on.

import { isCommandGroupEnabled } from "./game/db.ts";
import { sqlite } from "./game/sqlite.ts";
import type { LocalCtx } from "./commands.ts";
import { addRole, createMessage, getMember, removeRole, sendDm, type OutMessage } from "./discord.ts";
import { on } from "./gateway.ts";
import { fill, idList, mention, msg, progressBar } from "./helpers.ts";

export const LEVELS_GROUP = "levels";
export const DEFAULT_LEVELUP = "🎉 {user} just reached **level {level}**!";
const ARCANE_BLUE = 0x5865f2;

export interface LevelSettings {
  announce: "here" | "dm" | "channel" | "off";
  channelId: string | null;
  message: string;
  xpMin: number;
  xpMax: number;
  cooldownSeconds: number;
  stack: boolean;
  noXpChannels: string[];
  noXpRoles: string[];
}

export async function ensureLevelTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS levels_xp (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      xp INTEGER NOT NULL DEFAULT 0,
      messages INTEGER NOT NULL DEFAULT 0,
      last_xp_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id)
    )`,
  );
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS levels_settings (
      guild_id TEXT PRIMARY KEY,
      announce TEXT NOT NULL DEFAULT 'here',
      channel_id TEXT,
      message TEXT,
      xp_min INTEGER NOT NULL DEFAULT 15,
      xp_max INTEGER NOT NULL DEFAULT 25,
      cooldown_s INTEGER NOT NULL DEFAULT 60,
      stack INTEGER NOT NULL DEFAULT 1,
      no_xp_channels TEXT NOT NULL DEFAULT '',
      no_xp_roles TEXT NOT NULL DEFAULT ''
    )`,
  );
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS levels_rewards (
      guild_id TEXT NOT NULL,
      level INTEGER NOT NULL,
      role_id TEXT NOT NULL,
      PRIMARY KEY (guild_id, level)
    )`,
  );
}

// ── The curve ──

/** XP needed to go from `level` to the next. */
export const xpToNext = (level: number) => 5 * level * level + 50 * level + 100;

/** Total XP → level, and how far into that level. */
export function levelOf(totalXp: number): { level: number; into: number; needed: number } {
  let level = 0;
  let rest = Math.max(0, totalXp);
  while (rest >= xpToNext(level)) rest -= xpToNext(level++);
  return { level, into: rest, needed: xpToNext(level) };
}

/** Total XP at the start of `level`. */
export function xpForLevel(level: number): number {
  let total = 0;
  for (let l = 0; l < level; l++) total += xpToNext(l);
  return total;
}

// ── Storage ──

export async function getSettings(guildId: string): Promise<LevelSettings> {
  const r: any = (await sqlite.execute("SELECT * FROM levels_settings WHERE guild_id = ?", [guildId])).rows[0];
  return {
    announce: (r?.announce ?? "here") as LevelSettings["announce"],
    channelId: r?.channel_id ? String(r.channel_id) : null,
    message: r?.message ? String(r.message) : DEFAULT_LEVELUP,
    xpMin: r ? Number(r.xp_min) : 15,
    xpMax: r ? Number(r.xp_max) : 25,
    cooldownSeconds: r ? Number(r.cooldown_s) : 60,
    stack: r ? Number(r.stack) === 1 : true,
    noXpChannels: idList(r?.no_xp_channels),
    noXpRoles: idList(r?.no_xp_roles),
  };
}

async function saveSettings(guildId: string, s: LevelSettings) {
  await sqlite.execute(
    `INSERT OR REPLACE INTO levels_settings (guild_id, announce, channel_id, message, xp_min, xp_max, cooldown_s, stack, no_xp_channels, no_xp_roles)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [guildId, s.announce, s.channelId, s.message, s.xpMin, s.xpMax, s.cooldownSeconds, s.stack ? 1 : 0, s.noXpChannels.join(","), s.noXpRoles.join(",")],
  );
}

export async function getXp(guildId: string, userId: string): Promise<{ xp: number; messages: number; lastXpAt: number }> {
  const r: any = (await sqlite.execute("SELECT xp, messages, last_xp_at FROM levels_xp WHERE guild_id = ? AND user_id = ?", [guildId, userId])).rows[0];
  return { xp: Number(r?.xp ?? 0), messages: Number(r?.messages ?? 0), lastXpAt: Number(r?.last_xp_at ?? 0) };
}

async function setXp(guildId: string, userId: string, xp: number) {
  await sqlite.execute(
    `INSERT INTO levels_xp (guild_id, user_id, xp) VALUES (?, ?, ?) ON CONFLICT (guild_id, user_id) DO UPDATE SET xp = excluded.xp`,
    [guildId, userId, Math.max(0, Math.round(xp))],
  );
}

async function rankOf(guildId: string, xp: number): Promise<number> {
  const r: any = (await sqlite.execute("SELECT COUNT(*) AS n FROM levels_xp WHERE guild_id = ? AND xp > ?", [guildId, xp])).rows[0];
  return Number(r?.n ?? 0) + 1;
}

export async function getRewards(guildId: string): Promise<Array<{ level: number; roleId: string }>> {
  const res = await sqlite.execute("SELECT level, role_id FROM levels_rewards WHERE guild_id = ? ORDER BY level", [guildId]);
  return res.rows.map((r: any) => ({ level: Number(r.level), roleId: String(r.role_id) }));
}

// ── Earning XP ──

const lastAward = new Map<string, number>();

/** One chat message: XP if the cooldown allows, then any level-up. Returns the new level when it went up. */
export async function awardMessage(m: { guildId: string; channelId: string; userId: string; roles: string[]; messageId?: string }, now = Date.now()): Promise<number | null> {
  if (!(await isCommandGroupEnabled(m.guildId, LEVELS_GROUP))) return null;
  const s = await getSettings(m.guildId);
  if (s.noXpChannels.includes(m.channelId) || m.roles.some((r) => s.noXpRoles.includes(r))) return null;
  const key = `${m.guildId}:${m.userId}`;
  const cooldown = s.cooldownSeconds * 1000;
  if (now - (lastAward.get(key) ?? 0) < cooldown) {
    await sqlite.execute("UPDATE levels_xp SET messages = messages + 1 WHERE guild_id = ? AND user_id = ?", [m.guildId, m.userId]);
    return null;
  }
  const before = await getXp(m.guildId, m.userId);
  if (now - before.lastXpAt < cooldown) return null; // another process or a restart
  lastAward.set(key, now);
  const gain = s.xpMin + Math.floor(Math.random() * (Math.max(s.xpMin, s.xpMax) - s.xpMin + 1));
  await sqlite.execute(
    `INSERT INTO levels_xp (guild_id, user_id, xp, messages, last_xp_at) VALUES (?, ?, ?, 1, ?)
     ON CONFLICT (guild_id, user_id) DO UPDATE SET xp = xp + excluded.xp, messages = messages + 1, last_xp_at = excluded.last_xp_at`,
    [m.guildId, m.userId, gain, now],
  );
  const from = levelOf(before.xp).level;
  const to = levelOf(before.xp + gain).level;
  if (to <= from) return null;
  await levelledUp(m.guildId, m.userId, m.roles, to, s, m.channelId);
  return to;
}

async function levelledUp(guildId: string, userId: string, roles: string[], level: number, s: LevelSettings, channelId: string | null) {
  await syncRewardRoles(guildId, userId, roles, level, s.stack);
  if (s.announce === "off") return;
  const content = fill(s.message, { user: mention(userId), username: `<@${userId}>`, level });
  const out: OutMessage = { content, ping: [userId] };
  if (s.announce === "dm") await sendDm(userId, { content: content.replace(/<@\d+>/g, "you") });
  else if (s.announce === "channel" && s.channelId) await createMessage(s.channelId, out);
  else if (channelId) await createMessage(channelId, out);
}

/** Gives the rewards up to `level`; with stack off, takes away all but the highest. */
export async function syncRewardRoles(guildId: string, userId: string, roles: string[], level: number, stack: boolean) {
  const rewards = await getRewards(guildId);
  const earned = rewards.filter((r) => r.level <= level);
  const keep = stack ? earned : earned.slice(-1);
  for (const r of keep) if (!roles.includes(r.roleId)) await addRole(guildId, userId, r.roleId, `Level ${level} reward`);
  for (const r of rewards) {
    if (!keep.some((k) => k.roleId === r.roleId) && roles.includes(r.roleId)) await removeRole(guildId, userId, r.roleId, `Level ${level} reward`);
  }
}

on("MESSAGE_CREATE", async (m: any) => {
  if (!m.guild_id || m.author?.bot || m.webhook_id || (m.type !== 0 && m.type !== 19)) return;
  await awardMessage({ guildId: String(m.guild_id), channelId: String(m.channel_id), userId: String(m.author.id), roles: (m.member?.roles ?? []).map(String) });
});

// ── /rank and /levels ──

export async function rankCard(guildId: string, userId: string): Promise<OutMessage> {
  const { xp, messages } = await getXp(guildId, userId);
  const { level, into, needed } = levelOf(xp);
  const rank = await rankOf(guildId, xp);
  return {
    content: "",
    embeds: [{
      title: "Rank",
      color: ARCANE_BLUE,
      description: `${mention(userId)}\n\`${progressBar(into / needed)}\` ${into.toLocaleString("en-US")} / ${needed.toLocaleString("en-US")} XP`,
      fields: [
        { name: "Level", value: String(level), inline: true },
        { name: "Rank", value: `#${rank}`, inline: true },
        { name: "Total XP", value: xp.toLocaleString("en-US"), inline: true },
        { name: "Messages", value: messages.toLocaleString("en-US"), inline: true },
      ],
    }],
  };
}

export async function handleLevelsCommand(kind: string, ctx: LocalCtx): Promise<OutMessage> {
  if (!(await isCommandGroupEnabled(ctx.guildId, LEVELS_GROUP))) {
    return msg("Levels are switched off in this server. A moderator can turn them on with `/guildscribe feature name:levels state:on`.");
  }
  const a = ctx.a;
  if (kind === "levels.rank") {
    return await rankCard(ctx.guildId, a.id("user") || ctx.userId);
  }
  if (kind === "levels.top") {
    const page = Math.max(1, Number(a.s("page") || 1));
    const res = await sqlite.execute("SELECT user_id, xp FROM levels_xp WHERE guild_id = ? AND xp > 0 ORDER BY xp DESC LIMIT 10 OFFSET ?", [ctx.guildId, (page - 1) * 10]);
    if (!res.rows.length) return msg(page === 1 ? "🏆 Nobody has any XP yet. Chat away!" : "🏆 That page is empty.");
    const medals = ["🥇", "🥈", "🥉"];
    const lines = res.rows.map((r: any, i: number) => {
      const n = (page - 1) * 10 + i;
      return `${medals[n] ?? `**${n + 1}.**`} <@${r.user_id}> · level ${levelOf(Number(r.xp)).level} · ${Number(r.xp).toLocaleString("en-US")} XP`;
    });
    return msg([`🏆 **Leaderboard**${page > 1 ? ` · page ${page}` : ""}`, ...lines].join("\n"));
  }
  if (kind === "levels.reward.list") {
    const rewards = await getRewards(ctx.guildId);
    const s = await getSettings(ctx.guildId);
    if (!rewards.length) return msg("🎁 No level rewards yet. A moderator adds one with `/levels reward add`.");
    return msg([`🎁 **Level rewards** (${s.stack ? "members keep every reward" : "members keep only the highest"})`, ...rewards.map((r) => `Level **${r.level}** → <@&${r.roleId}>`)].join("\n"));
  }

  if (!ctx.moderator) return msg("Only moderators (Manage Server or Manage Messages) can change levels.");
  const s = await getSettings(ctx.guildId);

  if (kind === "levels.reward.add") {
    const level = Number(a.s("level"));
    const roleId = a.id("role");
    if (roleId === ctx.guildId) return msg("@everyone can't be a reward.");
    await sqlite.execute("INSERT OR REPLACE INTO levels_rewards (guild_id, level, role_id) VALUES (?, ?, ?)", [ctx.guildId, level, roleId]);
    return msg(`🎁 Reaching level **${level}** now gives <@&${roleId}>. (GuildScribe's role must be above it, with Manage Roles.) Members already past it get it next time they level up, or with \`/levels set\`.`);
  }
  if (kind === "levels.reward.remove") {
    const level = Number(a.s("level"));
    const res = await sqlite.execute("DELETE FROM levels_rewards WHERE guild_id = ? AND level = ?", [ctx.guildId, level]);
    return msg(res.rowsAffected ? `🎁 Level ${level} no longer gives a role.` : `There's no reward at level ${level}.`);
  }
  if (kind === "levels.settings") {
    const next = { ...s };
    if (a.s("announce")) next.announce = a.s("announce") as LevelSettings["announce"];
    if (a.id("channel")) next.channelId = a.id("channel");
    if (a.s("message")) next.message = a.s("message") === "-" ? DEFAULT_LEVELUP : a.s("message").slice(0, 500);
    if (a.s("xp_min")) next.xpMin = Number(a.s("xp_min"));
    if (a.s("xp_max")) next.xpMax = Number(a.s("xp_max"));
    if (next.xpMax < next.xpMin) next.xpMax = next.xpMin;
    if (a.s("cooldown")) next.cooldownSeconds = Number(a.s("cooldown"));
    if (a.s("stack")) next.stack = a.s("stack") === "true";
    if (next.announce === "channel" && !next.channelId) return msg("Pick the `channel` level-ups go to.");
    await saveSettings(ctx.guildId, next);
    const where = { here: "where they chatted", dm: "by DM", channel: `in <#${next.channelId}>`, off: "nowhere (silent)" }[next.announce];
    return msg([
      "⚙️ **Levels**",
      `Level-ups are announced ${where}: ${next.message}`,
      `${next.xpMin}–${next.xpMax} XP per message, at most once every ${next.cooldownSeconds}s.`,
      `Rewards: ${next.stack ? "members keep every reward role" : "members keep only the highest reward role"}.`,
      `No XP in: ${[...next.noXpChannels.map((c) => `<#${c}>`), ...next.noXpRoles.map((r) => `<@&${r}>`)].join(" ") || "nowhere"}`,
    ].join("\n"));
  }
  if (kind === "levels.noxp") {
    const channelId = a.id("channel");
    const roleId = a.id("role");
    if (!channelId && !roleId) return msg("Pick a `channel` or a `role` to stop (or start again) earning XP.");
    const toggle = (list: string[], id: string) => list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
    const next = { ...s };
    if (channelId) next.noXpChannels = toggle(s.noXpChannels, channelId);
    if (roleId) next.noXpRoles = toggle(s.noXpRoles, roleId);
    await saveSettings(ctx.guildId, next);
    const said: string[] = [];
    if (channelId) said.push(`<#${channelId}> ${next.noXpChannels.includes(channelId) ? "no longer earns" : "earns"} XP.`);
    if (roleId) said.push(`<@&${roleId}> ${next.noXpRoles.includes(roleId) ? "no longer earns" : "earns"} XP.`);
    return msg(said.join("\n"));
  }
  const target = a.id("user");
  if (kind === "levels.set" || kind === "levels.give" || kind === "levels.reset") {
    const { xp } = await getXp(ctx.guildId, target);
    const total = kind === "levels.set" ? xpForLevel(Number(a.s("level"))) : kind === "levels.give" ? xp + Number(a.s("xp")) : 0;
    await setXp(ctx.guildId, target, total);
    const level = levelOf(Math.max(0, total)).level;
    const member = await getMember(ctx.guildId, target);
    if (member) await syncRewardRoles(ctx.guildId, target, (member.roles ?? []).map(String), level, s.stack);
    return msg(`✨ <@${target}> is now level **${level}** (${Math.max(0, total).toLocaleString("en-US")} XP).`);
  }
  return msg("Unknown /levels command.");
}
