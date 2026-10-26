// Birthdays: members save theirs, and on the day GuildScribe wishes them a
// happy birthday in the server's birthday channel and gives them the
// birthday role until the day is over, the way Birthday Bot does.
//
//   /birthday set        month and day (the year is optional and only used
//                        for "turns 30"); moderators can set anyone's
//   /birthday remove     forget it
//   /birthday show       someone's birthday
//   /birthday upcoming   the next ones in this server
//   /birthday setup      (moderators) channel, role, message ({user}
//                        {age}), the hour to post, and the timezone the
//                        day runs in (default: the server's /wow timezone)
//
//   the job              every 5 minutes (server.ts): on a member's day,
//                        from the set hour, posts once and gives the role;
//                        when the day is over in the server's timezone, the
//                        role comes off. 29 February birthdays are on the
//                        28th in other years.

import { isCommandGroupEnabled } from "./game/db.ts";
import { sqlite } from "./game/sqlite.ts";
import type { LocalCtx } from "./commands.ts";
import { addRole, createMessage, removeRole, type OutMessage } from "./discord.ts";
import { fill, mention, msg } from "./helpers.ts";
import { getSettings as getWowSettings } from "./wow_db.ts";
import { isValidZone, timezoneLabel, wallClock, zonedToUtc } from "./wow_time.ts";

export const BIRTHDAY_GROUP = "birthdays";
export const DEFAULT_BIRTHDAY_MESSAGE = "🎂 Happy birthday, {user}! 🎉";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS_IN = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export interface BirthdaySettings { channelId: string | null; roleId: string | null; message: string; hour: number; timezone: string }

export async function ensureBirthdayTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS birthdays (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      month INTEGER NOT NULL,
      day INTEGER NOT NULL,
      year INTEGER,
      PRIMARY KEY (guild_id, user_id)
    )`,
  );
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS birthday_settings (
      guild_id TEXT PRIMARY KEY,
      channel_id TEXT,
      role_id TEXT,
      message TEXT,
      hour INTEGER NOT NULL DEFAULT 9,
      timezone TEXT
    )`,
  );
  // One row per birthday celebrated: never posted twice, and the role comes off at role_until.
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS birthday_celebrations (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      year INTEGER NOT NULL,
      role_id TEXT,
      role_until INTEGER NOT NULL,
      role_removed INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id, year)
    )`,
  );
}

export async function getBirthdaySettings(guildId: string): Promise<BirthdaySettings> {
  const r: any = (await sqlite.execute("SELECT * FROM birthday_settings WHERE guild_id = ?", [guildId])).rows[0];
  return {
    channelId: r?.channel_id ? String(r.channel_id) : null,
    roleId: r?.role_id ? String(r.role_id) : null,
    message: r?.message ? String(r.message) : DEFAULT_BIRTHDAY_MESSAGE,
    hour: r ? Number(r.hour) : 9,
    timezone: r?.timezone ? String(r.timezone) : (await getWowSettings(guildId)).timezone,
  };
}

export const formatDate = (month: number, day: number, year?: number | null) => `${MONTHS[month - 1]} ${day}${year ? `, ${year}` : ""}`;

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** Whether a birthday falls on this date (29 Feb counts on 28 Feb in other years). */
export function isBirthdayOn(b: { month: number; day: number }, y: number, mo: number, d: number): boolean {
  if (b.month === mo && b.day === d) return true;
  return b.month === 2 && b.day === 29 && !isLeap(y) && mo === 2 && d === 28;
}

/** Days from a local date to the next time a birthday comes round (0 = today). */
function daysUntil(b: { month: number; day: number }, y: number, mo: number, d: number): number {
  const today = Date.UTC(y, mo - 1, d);
  for (const year of [y, y + 1]) {
    const day = b.month === 2 && b.day === 29 && !isLeap(year) ? 28 : b.day;
    const at = Date.UTC(year, b.month - 1, day);
    if (at >= today) return Math.round((at - today) / 86_400_000);
  }
  return 366;
}

// ── The job ──

export async function runBirthdayJobs(now = Date.now()) {
  // Roles from days that are over come off first.
  const done = await sqlite.execute("SELECT guild_id, user_id, year, role_id FROM birthday_celebrations WHERE role_removed = 0 AND role_id IS NOT NULL AND role_until <= ?", [now]);
  for (const r of done.rows as any[]) {
    await removeRole(String(r.guild_id), String(r.user_id), String(r.role_id), "Birthday is over");
    await sqlite.execute("UPDATE birthday_celebrations SET role_removed = 1 WHERE guild_id = ? AND user_id = ? AND year = ?", [r.guild_id, r.user_id, r.year]);
  }

  const guilds = await sqlite.execute("SELECT DISTINCT guild_id FROM birthday_settings WHERE channel_id IS NOT NULL OR role_id IS NOT NULL");
  for (const g of guilds.rows as any[]) {
    const guildId = String(g.guild_id);
    try {
      if (!(await isCommandGroupEnabled(guildId, BIRTHDAY_GROUP))) continue;
      const s = await getBirthdaySettings(guildId);
      const w = wallClock(s.timezone, now);
      if (w.h < s.hour) continue;
      const list = await sqlite.execute("SELECT user_id, month, day, year FROM birthdays WHERE guild_id = ? AND month = ?", [guildId, w.mo]);
      const tomorrow = new Date(Date.UTC(w.y, w.mo - 1, w.d + 1));
      const dayEnds = zonedToUtc(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(), 0, 0, s.timezone);
      for (const b of list.rows as any[]) {
        if (!isBirthdayOn({ month: Number(b.month), day: Number(b.day) }, w.y, w.mo, w.d)) continue;
        const claimed = await sqlite.execute(
          "INSERT OR IGNORE INTO birthday_celebrations (guild_id, user_id, year, role_id, role_until) VALUES (?, ?, ?, ?, ?)",
          [guildId, b.user_id, w.y, s.roleId, dayEnds],
        );
        if (!claimed.rowsAffected) continue;
        await celebrate(guildId, String(b.user_id), b.year ? w.y - Number(b.year) : null, s);
      }
    } catch (e) {
      console.error(`birthdays in ${guildId} failed`, e);
    }
  }
}

function birthdayMessage(userId: string, age: number | null, s: BirthdaySettings): OutMessage {
  const ageText = age && age > 0 && age < 130 ? String(age) : "another year";
  return { content: fill(s.message, { user: mention(userId), age: ageText }).slice(0, 2000), ping: [userId] };
}

async function celebrate(guildId: string, userId: string, age: number | null, s: BirthdaySettings) {
  if (s.roleId) await addRole(guildId, userId, s.roleId, "Happy birthday!");
  if (s.channelId) await createMessage(s.channelId, birthdayMessage(userId, age, s));
}

// ── /birthday ──

export async function handleBirthdayCommand(kind: string, ctx: LocalCtx): Promise<OutMessage> {
  if (!(await isCommandGroupEnabled(ctx.guildId, BIRTHDAY_GROUP))) {
    return msg("Birthdays are switched off in this server. A moderator can turn them on with `/guildscribe feature name:birthdays state:on`.");
  }
  const a = ctx.a;
  const other = a.id("user") && a.id("user") !== ctx.userId ? a.id("user") : null;
  const who = other ?? ctx.userId;
  const whose = other ? `<@${other}>'s` : "Your";

  if (kind === "birthday.set") {
    if (other && !ctx.moderator) return msg("Only moderators can set someone else's birthday.");
    const month = Number(a.s("month"));
    const day = Number(a.s("day"));
    const year = a.s("year") ? Number(a.s("year")) : null;
    if (day < 1 || day > DAYS_IN[month - 1]) return msg(`${MONTHS[month - 1]} has no day ${day}.`);
    if (year && month === 2 && day === 29 && !isLeap(year)) return msg(`${year} had no 29 February.`);
    if (year && (year < 1900 || year > new Date().getUTCFullYear())) return msg("That year doesn't look right. Leave it out to keep your age private.");
    await sqlite.execute("INSERT OR REPLACE INTO birthdays (guild_id, user_id, month, day, year) VALUES (?, ?, ?, ?, ?)", [ctx.guildId, who, month, day, year]);
    const s = await getBirthdaySettings(ctx.guildId);
    const note = s.channelId ? "" : "\n(No birthday channel yet: a moderator sets one with `/birthday setup`.)";
    return msg(`🎂 ${whose} birthday is saved: **${formatDate(month, day)}**.${note}`);
  }
  if (kind === "birthday.remove") {
    if (other && !ctx.moderator) return msg("Only moderators can remove someone else's birthday.");
    const res = await sqlite.execute("DELETE FROM birthdays WHERE guild_id = ? AND user_id = ?", [ctx.guildId, who]);
    return msg(res.rowsAffected ? `🎂 ${whose} birthday is forgotten.` : `${other ? "They haven't" : "You haven't"} saved a birthday.`);
  }
  if (kind === "birthday.show") {
    const b: any = (await sqlite.execute("SELECT month, day FROM birthdays WHERE guild_id = ? AND user_id = ?", [ctx.guildId, who])).rows[0];
    if (!b) return msg(other ? `<@${other}> hasn't saved a birthday.` : "You haven't saved a birthday. `/birthday set` saves it.");
    // The year stays private; only the day is shown.
    return msg(`🎂 ${whose} birthday is **${formatDate(Number(b.month), Number(b.day))}**.`);
  }
  if (kind === "birthday.upcoming") {
    const s = await getBirthdaySettings(ctx.guildId);
    const w = wallClock(s.timezone, Date.now());
    const all = (await sqlite.execute("SELECT user_id, month, day FROM birthdays WHERE guild_id = ?", [ctx.guildId])).rows as any[];
    if (!all.length) return msg("🎂 Nobody has saved a birthday yet. `/birthday set` saves yours.");
    const next = all
      .map((b) => ({ userId: String(b.user_id), month: Number(b.month), day: Number(b.day), in: daysUntil({ month: Number(b.month), day: Number(b.day) }, w.y, w.mo, w.d) }))
      .sort((x, y) => x.in - y.in)
      .slice(0, 10);
    const when = (n: number) => n === 0 ? "**today** 🎉" : n === 1 ? "tomorrow" : `in ${n} days`;
    return msg(["🎂 **Upcoming birthdays**", ...next.map((b) => `${formatDate(b.month, b.day)} · <@${b.userId}> · ${when(b.in)}`)].join("\n"));
  }
  if (kind === "birthday.setup") {
    if (!ctx.moderator) return msg("Only moderators (Manage Server or Manage Messages) can set up birthdays.");
    const s = await getBirthdaySettings(ctx.guildId);
    const next = { ...s };
    if (a.id("channel")) next.channelId = a.id("channel");
    if (a.id("role")) next.roleId = a.id("role") === ctx.guildId ? null : a.id("role");
    if (a.s("message")) next.message = a.s("message") === "-" ? DEFAULT_BIRTHDAY_MESSAGE : a.s("message").slice(0, 500);
    if (a.s("hour")) next.hour = Number(a.s("hour"));
    if (a.s("timezone")) {
      if (!isValidZone(a.s("timezone"))) return msg(`${a.s("timezone")} isn't a timezone.`);
      next.timezone = a.s("timezone");
    }
    if (a.b("off")) {
      next.channelId = null;
      next.roleId = null;
    }
    await sqlite.execute(
      "INSERT OR REPLACE INTO birthday_settings (guild_id, channel_id, role_id, message, hour, timezone) VALUES (?, ?, ?, ?, ?, ?)",
      [ctx.guildId, next.channelId, next.roleId, next.message, next.hour, next.timezone],
    );
    const hour = `${next.hour % 12 || 12}${next.hour < 12 ? "am" : "pm"}`;
    return msg([
      "🎂 **Birthdays**",
      `Wishes go in: ${next.channelId ? `<#${next.channelId}>` : "nowhere"} · birthday role: ${next.roleId ? `<@&${next.roleId}>` : "none"}`,
      `Posted from ${hour}, ${timezoneLabel(next.timezone)} time, on the day. Message: ${next.message}`,
      next.roleId ? "GuildScribe needs Manage Roles, with its own role above the birthday role." : "",
    ].filter(Boolean).join("\n"));
  }
  return msg("Unknown /birthday command.");
}
