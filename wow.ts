// World of Warcraft: Forever — raid and party nights for a Discord server.
//
//   /wow raid create   a leader posts a raid (or a 5-player party) with a
//                      start time and role slots; the post has signup buttons
//   buttons            🛡️ Tank / 💚 Healer / ⚔️ DPS / 🤔 Maybe / ❌ Can't make it / Leave.
//                      Past a role's slots (or the raid's size) you're on the
//                      bench, and moved in, with a DM, when a spot opens.
//   /wow raid invite   DMs members the raid card with the same buttons, and
//                      pings them on the server; the post lists who hasn't answered
//   reminders          a DM to everyone in (and maybes) plus a ping in the
//                      raid's channel, 30 minutes before (/wow timezone sets both
//                      the server's default timezone and the lead time)
//   tracking           WOW_FINISH_AFTER_HOURS (4) after the start, or with
//                      /wow raid complete, everyone in is marked as having shown
//                      up; leaders fix it with /wow raid attendance, hand out
//                      drops with /wow raid loot. /wow stats and /wow top read it.
//   /wow character     a member's main (name, class, role), shown on rosters
//   /wow forever       the launch countdown (the Twitch bot's !wow:forever)
//
// Leaders: whoever created the raid, and server moderators.
// The tables are in wow_db.ts, start times in wow_time.ts.

import { isCommandGroupEnabled } from "./game/db.ts";
import { sqlite } from "./game/sqlite.ts";
import type { Args } from "./commands.ts";
import { createMessage, editMessage, followUp, json, messageData, ResponseType, sendDm, type OutMessage } from "./discord.ts";
import { displayName, loginFor, rememberMember } from "./identity.ts";
import {
  addLoot, type Answer, attendanceBoard, createRaid, defaultSlots, FINISH_AFTER_MS, getAttendance, getChars, getGuildRaid, getInvites, getRaid, getSettings,
  getSignups, listRaids, memberLoot, memberStats, type Raid, raidLoot, raidsDue, recordInvite, removeAttendance, removeSignup, type Role, ROLES,
  setAttendance, setChar, setSettings, setSignup, type Signup, updateRaid,
} from "./wow_db.ts";
import { isValidZone, parseWhen, stamp, timezoneLabel } from "./wow_time.ts";

export const WOW_GROUP = "wowraid";

const ROLE_META: Record<Role, { emoji: string; label: string; plural: string; style: number }> = {
  tank: { emoji: "🛡️", label: "Tank", plural: "Tanks", style: 1 },
  healer: { emoji: "💚", label: "Healer", plural: "Healers", style: 3 },
  dps: { emoji: "⚔️", label: "DPS", plural: "DPS", style: 4 },
};

const COLORS = { open: 0xf8b700, done: 0x5865f2, cancelled: 0x747f8d };
const MAX_TITLE = 80;
const MAX_NOTES = 500;
const MAX_INVITES = 25;

export interface WowCtx {
  guildId: string;
  channelId: string;
  userId: string;
  display: string;
  moderator: boolean;
  a: Args;
}

// ── The roster ──

export interface Roster {
  in: Record<Role, Signup[]>;
  bench: Signup[];
  maybe: Signup[];
  no: Signup[];
  total: number;
}

/** Who's in: "yes" signups in the order they came, up to each role's slots and the raid's size; the rest wait on the bench. */
export function buildRoster(raid: Pick<Raid, "size" | "slots">, signups: Signup[]): Roster {
  const r: Roster = { in: { tank: [], healer: [], dps: [] }, bench: [], maybe: [], no: [], total: 0 };
  for (const s of [...signups].sort((a, b) => a.signedAt - b.signedAt)) {
    if (s.answer === "no") r.no.push(s);
    else if (s.answer === "maybe") r.maybe.push(s);
    else if (s.role && r.in[s.role].length < raid.slots[s.role] && r.total < raid.size) {
      r.in[s.role].push(s);
      r.total++;
    } else r.bench.push(s);
  }
  return r;
}

const inIds = (r: Roster) => new Set(ROLES.flatMap((role) => r.in[role].map((s) => s.userId)));

/** One member's place on the roster, in a few words. */
export function standing(raid: Raid, r: Roster, userId: string): string {
  for (const role of ROLES) if (r.in[role].some((s) => s.userId === userId)) return `✅ You're in as ${ROLE_META[role].label}.`;
  const bench = r.bench.find((s) => s.userId === userId);
  if (bench) {
    const role = bench.role ?? "dps";
    const why = r.total >= raid.size ? `the raid is full (${raid.size})` : `${ROLE_META[role].plural.toLowerCase()} are full (${raid.slots[role]})`;
    return `🪑 You're on the bench as ${ROLE_META[role].label}: ${why}. You'll be moved in, with a DM, if a spot opens.`;
  }
  if (r.maybe.some((s) => s.userId === userId)) return "🤔 You're down as maybe.";
  if (r.no.some((s) => s.userId === userId)) return "❌ You can't make it. Change your mind with the buttons.";
  return "You're not signed up.";
}

function cap(lines: string[], max = 1000): string {
  let out = "";
  for (let i = 0; i < lines.length; i++) {
    const next = (out ? "\n" : "") + lines[i];
    if (out.length + next.length > max - 20) return `${out}\n…and ${lines.length - i} more`;
    out += next;
  }
  return out || "—";
}

const link = (raid: Raid) => raid.channelId && raid.messageId ? `https://discord.com/channels/${raid.guildId}/${raid.channelId}/${raid.messageId}` : "";

function plainTime(raid: Raid): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: raid.timezone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })
      .format(new Date(raid.startsAt));
  } catch {
    return new Date(raid.startsAt).toISOString();
  }
}

// ── The raid card (the signup post, invite DMs, /wow raid view) ──

export async function raidCard(raid: Raid, opts: { content?: string } = {}): Promise<OutMessage> {
  const signups = await getSignups(raid.id);
  const roster = buildRoster(raid, signups);
  const chars = await getChars(raid.guildId, signups.map((s) => s.userId));
  const who = (userId: string) => {
    const c = chars.get(userId);
    return c ? `<@${userId}> · ${c.name}${c.cls ? ` (${c.cls})` : ""}` : `<@${userId}>`;
  };
  const head = { open: "⚔️", done: "✅", cancelled: "🚫" }[raid.status];
  const desc = [
    `🗓️ ${stamp(raid.startsAt)} (${stamp(raid.startsAt, "R")})`,
    `👑 Leader: <@${raid.leaderId}>`,
    `👥 ${raid.size === 5 ? "Party" : "Raid"} of ${raid.size} · ${ROLES.map((r) => `${ROLE_META[r].emoji} ${raid.slots[r]}`).join("  ")}`,
  ];
  if (raid.notes) desc.push("", raid.notes);
  if (raid.status === "cancelled") desc.unshift("**Cancelled.**");

  const fields: Array<{ name: string; value: string; inline?: boolean }> = [];
  if (raid.status === "done") {
    const att = await getAttendance(raid.id);
    const loot = await raidLoot(raid.id);
    const present = att.filter((a) => a.status === "present");
    const noshow = att.filter((a) => a.status === "noshow");
    fields.push({ name: `✅ Showed up (${present.length})`, value: cap(present.map((a) => `${a.role ? ROLE_META[a.role].emoji : "•"} ${who(a.userId)}`)) });
    if (noshow.length) fields.push({ name: `🚫 No-shows (${noshow.length})`, value: cap(noshow.map((a) => who(a.userId))) });
    if (loot.length) fields.push({ name: `💰 Loot (${loot.length})`, value: cap(loot.map((l) => `${l.item} → <@${l.userId}>`)) });
  } else {
    for (const role of ROLES) {
      fields.push({ name: `${ROLE_META[role].emoji} ${ROLE_META[role].plural} (${roster.in[role].length}/${raid.slots[role]})`, value: cap(roster.in[role].map((s) => who(s.userId))), inline: true });
    }
    if (roster.bench.length) fields.push({ name: `🪑 Bench (${roster.bench.length})`, value: cap(roster.bench.map((s) => `${s.role ? ROLE_META[s.role].emoji : "•"} ${who(s.userId)}`)) });
    if (roster.maybe.length) fields.push({ name: `🤔 Maybe (${roster.maybe.length})`, value: cap(roster.maybe.map((s) => who(s.userId))) });
    if (roster.no.length) fields.push({ name: `❌ Can't make it (${roster.no.length})`, value: cap([roster.no.map((s) => `<@${s.userId}>`).join(", ")]) });
    const answered = new Set(signups.map((s) => s.userId));
    const waiting = (await getInvites(raid.id)).filter((i) => !answered.has(i.userId));
    if (waiting.length && raid.status === "open") fields.push({ name: `📨 Invited, no answer yet (${waiting.length})`, value: cap([waiting.map((i) => `<@${i.userId}>`).join(", ")]) });
  }

  const embed = {
    title: `${head} ${raid.title}`.slice(0, 256),
    description: desc.join("\n").slice(0, 4000),
    color: COLORS[raid.status],
    fields: fields.slice(0, 25),
    footer: { text: `WoW: Forever · Raid #${raid.id} · ${roster.total}/${raid.size} in · times show in your own timezone` },
  };
  return { content: opts.content ?? "", embeds: [embed], components: raid.status === "open" ? signupButtons(raid, roster) : [] };
}

function signupButtons(raid: Raid, roster: Roster) {
  const id = (action: string) => `wow:${raid.id}:${action}`;
  const full = roster.total >= raid.size;
  return [
    {
      type: 1,
      components: ROLES.map((role) => ({
        type: 2,
        style: ROLE_META[role].style,
        custom_id: id(role),
        emoji: { name: ROLE_META[role].emoji },
        label: `${ROLE_META[role].label} ${roster.in[role].length}/${raid.slots[role]}${full || roster.in[role].length >= raid.slots[role] ? " · bench" : ""}`,
      })),
    },
    {
      type: 1,
      components: [
        { type: 2, style: 2, custom_id: id("maybe"), emoji: { name: "🤔" }, label: "Maybe" },
        { type: 2, style: 2, custom_id: id("no"), emoji: { name: "❌" }, label: "Can't make it" },
        { type: 2, style: 2, custom_id: id("leave"), label: "Leave" },
      ],
    },
  ];
}

/** Re-renders the raid's signup post. */
export async function refreshPost(raid: Raid) {
  if (!raid.channelId || !raid.messageId) return;
  const card = await raidCard(raid);
  await editMessage(raid.channelId, raid.messageId, { ...card, content: raid.pingRoleId && raid.status === "open" ? `<@&${raid.pingRoleId}>` : "" });
}

async function serverName(guildId: string): Promise<string> {
  const res = await sqlite.execute("SELECT name FROM discord_guilds WHERE guild_id = ?", [guildId]);
  return String((res.rows[0] as any)?.name ?? "the server");
}

/** DMs whoever just moved off the bench. */
async function tellPromoted(raid: Raid, before: Roster, after: Roster, except: string) {
  const was = inIds(before);
  for (const role of ROLES) {
    for (const s of after.in[role]) {
      if (was.has(s.userId) || s.userId === except) continue;
      await sendDm(s.userId, { content: `🎉 A spot opened up: you're in **${raid.title}** as ${ROLE_META[role].label}, ${stamp(raid.startsAt)} (${stamp(raid.startsAt, "R")}). ${link(raid)}` });
    }
  }
}

// ── Buttons ──

/** A click on a raid card's button, in the server or in an invite DM. Answered within Discord's 3 seconds. */
export async function handleWowButton(interaction: any): Promise<Response> {
  const [, rawId, action] = String(interaction.data?.custom_id ?? "").split(":");
  const raid = await getRaid(Number(rawId));
  const ephemeral = (content: string) => json({ type: ResponseType.CHANNEL_MESSAGE, data: messageData({ content }, true) });
  if (!raid) return ephemeral("That raid is gone.");
  if (interaction.guild_id && String(interaction.guild_id) !== raid.guildId) return ephemeral("That raid belongs to another server.");
  if (!(await isCommandGroupEnabled(raid.guildId, WOW_GROUP))) return ephemeral("WoW raids are switched off in that server.");
  const user = interaction.member?.user ?? interaction.user;
  const userId = String(user.id);
  const display = displayName(interaction.member, user);
  if (interaction.member) await rememberMember(raid.guildId, { userId, login: loginFor(userId), display });

  const appId = String(interaction.application_id);
  const token = String(interaction.token);
  const onPost = interaction.message?.id && String(interaction.message.id) === raid.messageId;
  const inDm = !interaction.guild_id;

  if (raid.status !== "open") {
    const card = await raidCard(raid, { content: inDm ? `This raid is ${raid.status === "done" ? "over" : "cancelled"}.` : undefined });
    return json({ type: ResponseType.UPDATE_MESSAGE, data: messageData(card) });
  }

  const signups = await getSignups(raid.id);
  const before = buildRoster(raid, signups);
  const mine = signups.find((s) => s.userId === userId);
  let change: "new" | "changed" | "same" | "left" | "none" = "none";
  if (action === "leave") change = (await removeSignup(raid.id, userId)) ? "left" : "none";
  else if (action === "tank" || action === "healer" || action === "dps") change = await setSignup(raid.id, { userId, display, role: action, answer: "yes" });
  else if (action === "maybe" || action === "no") {
    const chars = await getChars(raid.guildId, [userId]);
    const role = mine?.role ?? chars.get(userId)?.role ?? null;
    change = await setSignup(raid.id, { userId, display, role, answer: action as Answer });
  } else return ephemeral("That button has changed. Try the post again.");

  const after = buildRoster(raid, await getSignups(raid.id));
  const mineNow = standing(raid, after, userId);
  const card = await raidCard(raid, inDm ? { content: `📨 **${await serverName(raid.guildId)}** · ${mineNow}` } : {});
  // After Discord has the response: a follow-up needs the interaction acknowledged first.
  setTimeout(async () => {
    try {
      if (!onPost) await refreshPost(raid);
      await tellPromoted(raid, before, after, userId);
      if (!inDm && change !== "same") await followUp(appId, token, { content: change === "left" ? "You've left the signup." : mineNow, ephemeral: true });
    } catch (e) {
      console.error("wow button follow-up failed", e);
    }
  }, 500);
  if (onPost || inDm) return json({ type: ResponseType.UPDATE_MESSAGE, data: messageData(onPost && raid.pingRoleId ? { ...card, content: `<@&${raid.pingRoleId}>` } : card) });
  // A copy of the card (/wow raid view): update it too.
  return json({ type: ResponseType.UPDATE_MESSAGE, data: messageData(card) });
}

// ── Autocomplete: the raid option ──

export async function raidChoices(guildId: string, typed: string, sub: string): Promise<Array<{ name: string; value: number }>> {
  const wantsDone = sub === "attendance" || sub === "loot" || sub === "view";
  const raids = [...await listRaids(guildId, { status: "open", limit: 25 }), ...(wantsDone ? await listRaids(guildId, { status: "done", limit: 15 }) : [])];
  const q = typed.toLowerCase().replace(/^#/, "").trim();
  return raids
    .filter((r) => !q || String(r.id).startsWith(q) || r.title.toLowerCase().includes(q))
    .slice(0, 25)
    .map((r) => ({ name: `#${r.id} ${r.title} — ${plainTime(r)}${r.status === "done" ? " (done)" : ""}`.slice(0, 100), value: r.id }));
}

// ── Slash commands ──

const ROLE_WORDS: Record<string, Role> = { tank: "tank", healer: "healer", heal: "healer", dps: "dps", damage: "dps" };

function leaderCheck(ctx: WowCtx, raid: Raid): string | null {
  return raid.leaderId === ctx.userId || ctx.moderator ? null : `Only the raid's leader (<@${raid.leaderId}>) or a moderator can do that.`;
}

async function findRaid(ctx: WowCtx): Promise<Raid | string> {
  const id = Number(ctx.a.s("raid").replace(/^#/, ""));
  const raid = Number.isSafeInteger(id) ? await getGuildRaid(ctx.guildId, id) : null;
  if (raid) return raid;
  const open = await listRaids(ctx.guildId, { status: "open", limit: 5 });
  return `No raid #${ctx.a.s("raid") || "?"} here.${open.length ? ` Open now: ${open.map((r) => `#${r.id} ${r.title}`).join(", ")}.` : " Make one with `/wow raid create`."}`;
}

const msg = (content: string, ping: string[] = []): OutMessage => ({ content, ping });

export async function handleWowCommand(kind: string, ctx: WowCtx): Promise<OutMessage> {
  if (!(await isCommandGroupEnabled(ctx.guildId, WOW_GROUP))) {
    return msg("WoW raids are switched off in this server. A moderator can turn them on with `/guildscribe feature name:wow state:on`.");
  }
  const a = ctx.a;
  switch (kind) {
    case "wow.character": {
      const name = a.s("name").slice(0, 24);
      const cls = a.s("class").slice(0, 20);
      const role = ROLE_WORDS[a.s("role")] ?? null;
      if (!name) return msg("Give your character's name.");
      await setChar(ctx.guildId, ctx.userId, { name, cls, role });
      return msg(`🗡️ <@${ctx.userId}> mains **${name}**${cls ? ` the ${cls}` : ""}${role ? ` (${ROLE_META[role].label})` : ""}. It shows on raid rosters here.`);
    }
    case "wow.stats": {
      const userId = a.id("user") || ctx.userId;
      const [st, chars, loot] = await Promise.all([memberStats(ctx.guildId, userId), getChars(ctx.guildId, [userId]), memberLoot(ctx.guildId, userId, 5)]);
      const c = chars.get(userId);
      const who = `<@${userId}>${c ? ` · **${c.name}**${c.cls ? ` the ${c.cls}` : ""}${c.role ? ` (${ROLE_META[c.role].label})` : ""}` : ""}`;
      const judged = st.present + st.noshow;
      if (!judged && !st.signups) return msg(`📊 ${who} hasn't raided here yet.${userId === ctx.userId ? " Sign up on a raid post, or set your main with `/wow character`." : ""}`);
      const lines = [
        `📊 ${who}`,
        `✅ ${st.present} raid${st.present === 1 ? "" : "s"} attended · 🚫 ${st.noshow} no-show${st.noshow === 1 ? "" : "s"}${judged ? ` · ${Math.round((st.present / judged) * 100)}% attendance` : ""} · ✍️ ${st.signups} signup${st.signups === 1 ? "" : "s"}`,
      ];
      const roles = ROLES.filter((r) => st.byRole[r]).map((r) => `${ROLE_META[r].emoji} ${st.byRole[r]} as ${ROLE_META[r].label}`);
      if (roles.length) lines.push(roles.join(" · "));
      if (st.lastRaid) lines.push(`Last raid: **${st.lastRaid.title}** (#${st.lastRaid.id}), ${stamp(st.lastRaid.startsAt, "D")}`);
      if (loot.length) lines.push(`💰 ${st.loot} drop${st.loot === 1 ? "" : "s"}: ${loot.map((l) => `${l.item} (#${l.raidId})`).join(", ")}${st.loot > loot.length ? ", …" : ""}`);
      return msg(lines.join("\n"));
    }
    case "wow.top": {
      const board = await attendanceBoard(ctx.guildId, 10);
      if (!board.length) return msg("🏆 Nobody has a finished raid on the books yet.");
      const medal = ["🥇", "🥈", "🥉"];
      return msg(["🏆 **Most raids attended**", ...board.map((b, i) => `${medal[i] ?? `${i + 1}.`} <@${b.userId}> — ${b.present} raid${b.present === 1 ? "" : "s"}${b.noshow ? ` · ${b.noshow} no-show${b.noshow === 1 ? "" : "s"}` : ""}`)].join("\n"));
    }
    case "wow.timezone": {
      const zone = a.s("zone");
      const remind = a.s("remind");
      const cur = await getSettings(ctx.guildId);
      if (!zone && !remind) return msg(`🕰️ Raid times here are read as **${timezoneLabel(cur.timezone)}** unless a raid says otherwise, and reminders go out ${cur.remindMinutes} minutes before.`);
      if (!ctx.moderator) return msg("Only moderators can change the server's raid timezone and reminders.");
      if (zone && !isValidZone(zone)) return msg(`${zone} isn't a timezone I know.`);
      const minutes = remind ? Math.max(0, Math.min(1440, Math.round(Number(remind)))) : undefined;
      await setSettings(ctx.guildId, { timezone: zone || undefined, remindMinutes: Number.isFinite(minutes) ? minutes : undefined });
      const now = await getSettings(ctx.guildId);
      return msg(`🕰️ Raid times are now read as **${timezoneLabel(now.timezone)}**; reminders go out ${now.remindMinutes ? `${now.remindMinutes} minutes before` : "never (off)"}.`);
    }
    case "wow.raid.create":
      return await createRaidCommand(ctx);
    case "wow.raid.list": {
      const open = await listRaids(ctx.guildId, { status: "open", limit: 10 });
      const done = await listRaids(ctx.guildId, { status: "done", limit: 3 });
      if (!open.length && !done.length) return msg("No raids yet. Post one with `/wow raid create`.");
      const lines = ["⚔️ **Upcoming**", ...(open.length ? [] : ["Nothing scheduled."])];
      for (const r of open) {
        const roster = buildRoster(r, await getSignups(r.id));
        lines.push(`**#${r.id} ${r.title}** · ${stamp(r.startsAt, "f")} (${stamp(r.startsAt, "R")}) · ${roster.total}/${r.size} in${link(r) ? ` · ${link(r)}` : ""}`);
      }
      if (done.length) lines.push("", "✅ **Recent**", ...done.map((r) => `#${r.id} ${r.title} · ${stamp(r.startsAt, "D")}`));
      return msg(lines.join("\n"));
    }
    case "wow.raid.view": {
      const raid = await findRaid(ctx);
      if (typeof raid === "string") return msg(raid);
      return await raidCard(raid, { content: link(raid) ? `The signup post: ${link(raid)}` : "" });
    }
    case "wow.raid.invite":
      return await inviteCommand(ctx);
    case "wow.raid.edit":
      return await editCommand(ctx);
    case "wow.raid.cancel": {
      const raid = await findRaid(ctx);
      if (typeof raid === "string") return msg(raid);
      const no = leaderCheck(ctx, raid);
      if (no) return msg(no);
      if (raid.status !== "open") return msg(`#${raid.id} is already ${raid.status === "done" ? "over" : "cancelled"}.`);
      const roster = buildRoster(raid, await getSignups(raid.id));
      await updateRaid(raid.id, { status: "cancelled", closedAt: Date.now() });
      const closed = (await getRaid(raid.id))!;
      await refreshPost(closed);
      const reason = a.s("reason").slice(0, 200);
      const told = [...inIds(roster), ...roster.bench.map((s) => s.userId), ...roster.maybe.map((s) => s.userId)];
      for (const id of told) {
        await sendDm(id, { content: `🚫 **${raid.title}** (${stamp(raid.startsAt)}) on **${await serverName(raid.guildId)}** is cancelled${reason ? `: ${reason}` : "."}` });
      }
      return msg(`🚫 Cancelled **${raid.title}** (#${raid.id}).${told.length ? ` Told ${told.length} signed-up member${told.length === 1 ? "" : "s"} by DM.` : ""}`);
    }
    case "wow.raid.complete": {
      const raid = await findRaid(ctx);
      if (typeof raid === "string") return msg(raid);
      const no = leaderCheck(ctx, raid);
      if (no) return msg(no);
      if (raid.status !== "open") return msg(`#${raid.id} is already ${raid.status === "done" ? "closed out" : "cancelled"}.`);
      if (raid.startsAt > Date.now()) return msg(`#${raid.id} hasn't started yet (${stamp(raid.startsAt, "R")}). Cancel it instead with \`/wow raid cancel\`.`);
      const n = await finishRaid(raid);
      return msg(`✅ Closed out **${raid.title}** (#${raid.id}): ${n} marked as there. Fix it with \`/wow raid attendance\`; hand out drops with \`/wow raid loot\`.`);
    }
    case "wow.raid.attendance": {
      const raid = await findRaid(ctx);
      if (typeof raid === "string") return msg(raid);
      const no = leaderCheck(ctx, raid);
      if (no) return msg(no);
      if (raid.status !== "done") return msg(`Attendance is taken once a raid is over: #${raid.id} ${raid.status === "open" ? `closes itself out a few hours after it starts, or now with \`/wow raid complete raid:${raid.id}\`` : "was cancelled"}.`);
      const userId = a.id("user");
      const status = a.s("status");
      if (!userId) return msg("Who?");
      if (status === "remove") {
        return msg((await removeAttendance(raid.id, userId)) ? `Took <@${userId}> off #${raid.id}'s attendance.` : `<@${userId}> isn't on #${raid.id}'s attendance.`);
      }
      const signup = (await getSignups(raid.id)).find((s) => s.userId === userId);
      const chars = await getChars(raid.guildId, [userId]);
      await setAttendance(raid, [{ userId, display: signup?.display ?? chars.get(userId)?.name ?? "member", role: signup?.role ?? chars.get(userId)?.role ?? null, status: status === "noshow" ? "noshow" : "present" }]);
      await refreshPost(raid);
      return msg(status === "noshow" ? `🚫 <@${userId}> marked as a no-show for **${raid.title}** (#${raid.id}).` : `✅ <@${userId}> marked as there for **${raid.title}** (#${raid.id}).`);
    }
    case "wow.raid.loot": {
      const raid = await findRaid(ctx);
      if (typeof raid === "string") return msg(raid);
      const no = leaderCheck(ctx, raid);
      if (no) return msg(no);
      if (raid.status === "cancelled") return msg(`#${raid.id} was cancelled.`);
      const userId = a.id("user");
      const item = a.s("item").slice(0, 100);
      if (!userId || !item) return msg("Who got what?");
      await addLoot(raid, userId, item, ctx.userId);
      await refreshPost(raid);
      return msg(`💰 **${item}** → <@${userId}> on **${raid.title}** (#${raid.id}).`, [userId]);
    }
    case "wow.raid.remove": {
      const raid = await findRaid(ctx);
      if (typeof raid === "string") return msg(raid);
      const no = leaderCheck(ctx, raid);
      if (no) return msg(no);
      const userId = a.id("user");
      if (!userId) return msg("Who?");
      const before = buildRoster(raid, await getSignups(raid.id));
      if (!(await removeSignup(raid.id, userId))) return msg(`<@${userId}> isn't signed up for #${raid.id}.`);
      const after = buildRoster(raid, await getSignups(raid.id));
      await refreshPost(raid);
      await tellPromoted(raid, before, after, userId);
      return msg(`Took <@${userId}> off **${raid.title}** (#${raid.id}).`);
    }
  }
  return msg("Unknown WoW command.");
}

function slotsFrom(a: Args, size: number, base?: Record<Role, number>): Record<Role, number> | string {
  const slots = { ...(base ?? defaultSlots(size)) };
  for (const [opt, role] of [["tanks", "tank"], ["healers", "healer"], ["dps", "dps"]] as const) {
    const v = a.s(opt);
    if (v !== "") slots[role] = Math.max(0, Math.min(40, Math.round(Number(v))));
  }
  if (!slots.tank && !slots.healer && !slots.dps) return "A raid needs at least one slot.";
  return slots;
}

async function createRaidCommand(ctx: WowCtx): Promise<OutMessage> {
  const a = ctx.a;
  const title = a.s("title").slice(0, MAX_TITLE);
  if (!title) return msg("Give the raid a name, e.g. Molten Core or Deadmines party.");
  const settings = await getSettings(ctx.guildId);
  const zone = a.s("timezone") || settings.timezone;
  const when = parseWhen(a.s("when"), zone);
  if ("error" in when) return msg(`🗓️ ${when.error} (read as ${timezoneLabel(zone)})`);
  const size = Math.max(2, Math.min(40, Number(a.s("size") || 10)));
  const slots = slotsFrom(a, size);
  if (typeof slots === "string") return msg(slots);
  const channelId = a.id("channel") || ctx.channelId;
  const pingRoleId = a.id("ping") || null;

  const raid = await createRaid({
    guildId: ctx.guildId, title, startsAt: when.at, size, slots, notes: a.s("notes").slice(0, MAX_NOTES),
    leaderId: ctx.userId, channelId, pingRoleId, timezone: zone,
  });
  const card = await raidCard(raid);
  const messageId = await createMessage(channelId, { ...card, content: pingRoleId ? `<@&${pingRoleId}>` : "", pingRoles: pingRoleId ? [pingRoleId] : [] });
  if (!messageId) {
    await updateRaid(raid.id, { status: "cancelled", closedAt: Date.now() });
    return msg(`I couldn't post in <#${channelId}>. Give GuildScribe **View Channel**, **Send Messages** and **Embed Links** there, or pick another channel.`);
  }
  await updateRaid(raid.id, { messageId });
  const posted = (await getRaid(raid.id))!;
  return msg(
    `⚔️ **${title}** (raid #${raid.id}) is up${channelId !== ctx.channelId ? ` in <#${channelId}>` : ""}: ${stamp(when.at)} (${stamp(when.at, "R")}), read as ${timezoneLabel(zone)}. ${link(posted)}\n` +
      `Invite people with \`/wow raid invite raid:${raid.id}\`.`,
  );
}

async function inviteCommand(ctx: WowCtx): Promise<OutMessage> {
  const raid = await findRaid(ctx);
  if (typeof raid === "string") return msg(raid);
  if (raid.status !== "open") return msg(`#${raid.id} is ${raid.status === "done" ? "over" : "cancelled"}.`);
  const signups = await getSignups(raid.id);
  const mine = signups.find((s) => s.userId === ctx.userId);
  if (raid.leaderId !== ctx.userId && !ctx.moderator && mine?.answer !== "yes") {
    return msg("Sign up for the raid first; then you can invite friends. (Its leader and moderators can always invite.)");
  }
  const ids = new Set<string>();
  if (ctx.a.id("user")) ids.add(ctx.a.id("user"));
  for (const m of ctx.a.s("members").matchAll(/<@!?(\d{17,20})>/g)) ids.add(m[1]);
  if (!ids.size) return msg("Who? Pick a `user`, or paste @mentions into `members`.");
  if (ids.size > MAX_INVITES) return msg(`That's more than ${MAX_INVITES} at once; split it up.`);

  const already = new Map(signups.map((s) => [s.userId, s.answer]));
  const sent: string[] = [];
  const noDm: string[] = [];
  const skipped: string[] = [];
  const guild = await serverName(raid.guildId);
  for (const id of ids) {
    if (already.get(id) === "yes") {
      skipped.push(id);
      continue;
    }
    const card = await raidCard(raid, { content: `📨 <@${ctx.userId}> invited you to **${raid.title}** on **${guild}**. Pick a role below.` });
    const ok = await sendDm(id, card);
    await recordInvite(raid.id, id, ctx.userId, ok);
    (ok ? sent : noDm).push(id);
  }
  await refreshPost(raid);
  const lines: string[] = [];
  if (sent.length) lines.push(`📨 Invited ${sent.map((id) => `<@${id}>`).join(", ")} to **${raid.title}** (#${raid.id}): check your DMs, or sign up on the post.`);
  if (noDm.length) lines.push(`📪 ${noDm.map((id) => `<@${id}>`).join(", ")} ${noDm.length === 1 ? "doesn't" : "don't"} take DMs from server members; sign up on the post instead.`);
  if (skipped.length) lines.push(`${skipped.map((id) => `<@${id}>`).join(", ")} ${skipped.length === 1 ? "is" : "are"} already signed up.`);
  if (link(raid)) lines.push(link(raid));
  return msg(lines.join("\n"), [...sent, ...noDm]);
}

async function editCommand(ctx: WowCtx): Promise<OutMessage> {
  const raid = await findRaid(ctx);
  if (typeof raid === "string") return msg(raid);
  const no = leaderCheck(ctx, raid);
  if (no) return msg(no);
  if (raid.status !== "open") return msg(`#${raid.id} is ${raid.status === "done" ? "over" : "cancelled"}.`);
  const a = ctx.a;
  const patch: Parameters<typeof updateRaid>[1] = {};
  const changes: string[] = [];
  if (a.s("title")) { patch.title = a.s("title").slice(0, MAX_TITLE); changes.push("name"); }
  if (a.s("notes")) { patch.notes = a.s("notes") === "-" ? "" : a.s("notes").slice(0, MAX_NOTES); changes.push("notes"); }
  let moved = false;
  if (a.s("when")) {
    const zone = a.s("timezone") || raid.timezone;
    const when = parseWhen(a.s("when"), zone);
    if ("error" in when) return msg(`🗓️ ${when.error} (read as ${timezoneLabel(zone)})`);
    if (when.at !== raid.startsAt) {
      patch.startsAt = when.at;
      patch.reminded = false;
      moved = true;
      changes.push("time");
    }
  }
  const size = a.s("size") ? Math.max(2, Math.min(40, Number(a.s("size")))) : raid.size;
  if (size !== raid.size || a.s("tanks") || a.s("healers") || a.s("dps")) {
    const slots = slotsFrom(a, size, size === raid.size ? raid.slots : undefined);
    if (typeof slots === "string") return msg(slots);
    patch.size = size;
    patch.slots = slots;
    changes.push("slots");
  }
  if (!changes.length) return msg("Nothing to change: give a new `when`, `title`, `notes`, `size` or slots.");
  const before = buildRoster(raid, await getSignups(raid.id));
  await updateRaid(raid.id, patch);
  const updated = (await getRaid(raid.id))!;
  const after = buildRoster(updated, await getSignups(raid.id));
  await refreshPost(updated);
  await tellPromoted(updated, before, after, "");
  if (moved) {
    const ids = [...inIds(after), ...after.bench.map((s) => s.userId), ...after.maybe.map((s) => s.userId)];
    for (const id of ids) await sendDm(id, { content: `🗓️ **${updated.title}** moved to ${stamp(updated.startsAt)} (${stamp(updated.startsAt, "R")}). ${standing(updated, after, id)} ${link(updated)}` });
  }
  return msg(`✏️ Updated **${updated.title}** (#${updated.id}): ${changes.join(", ")}.${moved ? ` Now ${stamp(updated.startsAt)}; everyone signed up was told.` : ""}`);
}

// ── The scheduled job (server.ts, every minute) ──

/** Marks everyone in as present and closes the raid. Returns how many were marked. */
export async function finishRaid(raid: Raid): Promise<number> {
  const roster = buildRoster(raid, await getSignups(raid.id));
  const rows = ROLES.flatMap((role) => roster.in[role].map((s) => ({ userId: s.userId, display: s.display, role, status: "present" as const })));
  await setAttendance(raid, rows);
  await updateRaid(raid.id, { status: "done", closedAt: Date.now() });
  await refreshPost((await getRaid(raid.id))!);
  return rows.length;
}

async function remind(raid: Raid) {
  const roster = buildRoster(raid, await getSignups(raid.id));
  const ids = [...inIds(roster)];
  const maybes = roster.maybe.map((s) => s.userId);
  const bench = roster.bench.map((s) => s.userId);
  for (const id of [...ids, ...maybes, ...bench]) {
    await sendDm(id, { content: `⏰ **${raid.title}** starts ${stamp(raid.startsAt, "R")} (${stamp(raid.startsAt, "t")}). ${standing(raid, roster, id)} ${link(raid)}` });
  }
  if (raid.channelId && ids.length + maybes.length) {
    const ping = [...ids, ...maybes].slice(0, 100);
    await createMessage(raid.channelId, {
      content: `⏰ **${raid.title}** (#${raid.id}) starts ${stamp(raid.startsAt, "R")}! ${ping.map((id) => `<@${id}>`).join(" ")} ${link(raid)}`.slice(0, 2000),
      ping,
    });
  }
}

/** Reminders and closing out finished raids, for every server. */
export async function runWowJobs(now = Date.now()) {
  for (const raid of await raidsDue(now)) {
    try {
      if (raid.startsAt + FINISH_AFTER_MS <= now) await finishRaid(raid);
      else if (!raid.reminded) {
        // Mark first, so a slow or failing DM never sends the reminder twice.
        await updateRaid(raid.id, { reminded: true });
        const lead = (await getSettings(raid.guildId)).remindMinutes;
        if (lead > 0 && raid.startsAt > now - 15 * 60_000) await remind(raid);
      }
    } catch (e) {
      console.error(`wow raid #${raid.id} job failed`, e);
    }
  }
}
