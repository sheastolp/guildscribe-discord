// The honeypot: a channel nobody should ever post in, the way the Honeypot
// bot does it. Real members read the warning and stay out; the spam bots and
// hacked accounts that post the same scam in every channel walk in, and are
// thrown out with their messages.
//
//   /honeypot setup   (moderators) makes a #honeypot channel with the warning
//                     (or uses the channel given) and picks what happens to
//                     whoever posts there:
//                       softban  (default) ban and unban at once: they're out,
//                                their last hour of messages everywhere is
//                                deleted, and a hacked account can rejoin
//                                once it's theirs again
//                       ban      the same, but they stay banned
//                       kick     out, messages stay (only the bait is deleted)
//                       timeout  a day's timeout, the bait deleted
//   /honeypot off     stops it (the channel stays)
//   /honeypot status  the channel, the action and how many it has caught
//
// Moderators and bots can post there safely. Each catch is a case in the mod
// record and the server log (moderation.ts, modlog.ts). Needs the Gateway
// (gateway.ts) and GuildScribe with Ban Members, Kick Members, Timeout
// Members and Manage Messages, its role above the members it catches.

import { isCommandGroupEnabled } from "./game/db.ts";
import { sqlite } from "./game/sqlite.ts";
import type { LocalCtx } from "./commands.ts";
import { api, createMessage, deleteMessage, sendDm, type OutMessage } from "./discord.ts";
import { on } from "./gateway.ts";
import { guildInfo, isModeratorMember, selfId } from "./guildcache.ts";
import { msg } from "./helpers.ts";
import { banMember, kickMember, recordCase, timeoutMember, unbanMember } from "./moderation.ts";

export const HONEYPOT_GROUP = "honeypot";
export type HoneypotAction = "softban" | "ban" | "kick" | "timeout";
const CLEAN_SECONDS = 3600;
const DONE: Record<HoneypotAction, string> = { softban: "softbanned", ban: "banned", kick: "kicked", timeout: "timed out" };

export async function ensureHoneypotTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS honeypot (
      guild_id TEXT PRIMARY KEY,
      channel_id TEXT,
      action TEXT NOT NULL DEFAULT 'softban',
      catches INTEGER NOT NULL DEFAULT 0
    )`,
  );
}

export async function getHoneypot(guildId: string): Promise<{ channelId: string | null; action: HoneypotAction; catches: number }> {
  const r: any = (await sqlite.execute("SELECT * FROM honeypot WHERE guild_id = ?", [guildId])).rows[0];
  return { channelId: r?.channel_id ? String(r.channel_id) : null, action: (r?.action ?? "softban") as HoneypotAction, catches: Number(r?.catches ?? 0) };
}

const warning = (action: HoneypotAction) =>
  [
    "# 🍯 Do not post here",
    "This channel is a trap for spam bots and hacked accounts.",
    `**Anything posted here gets the poster ${{ softban: "removed from the server, with their recent messages deleted", ban: "banned", kick: "kicked", timeout: "timed out for a day" }[action]}.**`,
    "Moderators are safe. Everyone else: just ignore this channel.",
  ].join("\n");

const busy = new Set<string>();

/** Someone posted in the honeypot. */
export async function caught(m: { guildId: string; channelId: string; messageId: string; userId: string; username: string }) {
  const key = `${m.guildId}:${m.userId}`;
  if (busy.has(key)) return void await deleteMessage(m.channelId, m.messageId, "Honeypot");
  busy.add(key);
  try {
    const { action } = await getHoneypot(m.guildId);
    const reason = `Posted in the honeypot channel (${action})`;
    const name = (await guildInfo(m.guildId))?.name || "the server";
    // Told first, while they still share a server with the bot.
    await sendDm(m.userId, {
      content: `🍯 You posted in **${name}**'s honeypot channel, a trap for spam bots, so you were ${action === "softban" ? "removed (you can rejoin)" : DONE[action]}.\nIf your account was hacked: change your password and turn on two-factor authentication.`,
    });
    let ok: boolean;
    if (action === "softban" || action === "ban") {
      ok = await banMember(m.guildId, m.userId, reason, CLEAN_SECONDS);
      if (ok && action === "softban") await unbanMember(m.guildId, m.userId, "Honeypot softban");
    } else {
      await deleteMessage(m.channelId, m.messageId, reason);
      ok = action === "kick" ? await kickMember(m.guildId, m.userId, reason) : await timeoutMember(m.guildId, m.userId, 86_400_000, reason);
    }
    if (!ok) {
      console.error(`honeypot in ${m.guildId} couldn't ${action} ${m.userId} (permissions or role order?)`);
      return;
    }
    await sqlite.execute("UPDATE honeypot SET catches = catches + 1 WHERE guild_id = ?", [m.guildId]);
    await recordCase(m.guildId, { userId: m.userId, modId: selfId, action: "honeypot", reason: `${m.username}: ${reason}` });
  } finally {
    setTimeout(() => busy.delete(key), 10_000);
  }
}

on("MESSAGE_CREATE", async (m: any) => {
  if (!m.guild_id || m.author?.bot || m.webhook_id || String(m.author?.id) === selfId) return;
  const guildId = String(m.guild_id);
  const { channelId } = await getHoneypot(guildId);
  if (channelId !== String(m.channel_id)) return;
  if (!(await isCommandGroupEnabled(guildId, HONEYPOT_GROUP))) return;
  if (await isModeratorMember(guildId, String(m.author.id), (m.member?.roles ?? []).map(String))) return;
  await caught({ guildId, channelId, messageId: String(m.id), userId: String(m.author.id), username: String(m.author.username ?? m.author.id) });
});

// ── /honeypot ──

export async function handleHoneypotCommand(kind: string, ctx: LocalCtx): Promise<OutMessage> {
  if (!(await isCommandGroupEnabled(ctx.guildId, HONEYPOT_GROUP))) {
    return msg("The honeypot is switched off in this server. A moderator can turn it on with `/guildscribe feature name:honeypot state:on`.");
  }
  const hp = await getHoneypot(ctx.guildId);
  if (kind === "honeypot.status") {
    if (!hp.channelId) return msg("🍯 No honeypot yet. A moderator sets one up with `/honeypot setup`.");
    return msg(`🍯 Honeypot: <#${hp.channelId}> · whoever posts there is **${DONE[hp.action]}** · ${hp.catches} caught so far.`);
  }
  if (!ctx.moderator) return msg("Only moderators (Manage Server or Manage Messages) can set up the honeypot.");
  if (kind === "honeypot.off") {
    await sqlite.execute("UPDATE honeypot SET channel_id = NULL WHERE guild_id = ?", [ctx.guildId]);
    return msg(hp.channelId ? `🍯 The honeypot is off. <#${hp.channelId}> is an ordinary channel again (delete it if you like).` : "There's no honeypot to switch off.");
  }
  if (kind === "honeypot.setup") {
    const action = (ctx.a.s("action") || hp.action) as HoneypotAction;
    let channelId = ctx.a.id("channel");
    if (!channelId) {
      const ch = await api("POST", `/guilds/${ctx.guildId}/channels`, { name: "honeypot", type: 0, position: 0, topic: "🍯 Do not post here: a trap for spam bots." }, `Honeypot set up by ${ctx.display}`);
      if (!ch?.id) return msg("Couldn't make the channel. GuildScribe needs Manage Channels, or pick an existing `channel`.");
      channelId = String(ch.id);
    }
    await sqlite.execute(
      "INSERT INTO honeypot (guild_id, channel_id, action) VALUES (?, ?, ?) ON CONFLICT (guild_id) DO UPDATE SET channel_id = excluded.channel_id, action = excluded.action",
      [ctx.guildId, channelId, action],
    );
    const posted = await createMessage(channelId, { content: warning(action) });
    return msg([
      `🍯 The honeypot is <#${channelId}>: whoever posts there (moderators and bots aside) is **${DONE[action]}**${action === "softban" ? " (banned and unbanned, their last hour of messages deleted)" : ""}.`,
      posted ? "The warning is posted there." : "Couldn't post the warning there: GuildScribe needs Send Messages in it.",
      "GuildScribe needs Ban Members, Kick Members, Timeout Members and Manage Messages, its role above members', and the Gateway running.",
    ].join("\n"));
  }
  return msg("Unknown /honeypot command.");
}
