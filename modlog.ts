// The server log: one channel where GuildScribe reports what its safety
// features do (moderation actions, honeypot catches, anti-spam, anti-raid,
// anti-nuke) and, if wanted, deleted and edited messages and members
// joining and leaving, the way Sapphire's logging works.
//
// Deleted and edited messages need their text from before, so the last
// MESSAGE_CACHE messages GuildScribe has seen are kept in memory (Message
// Content intent). A message from before a restart is logged without it.
// Set with /mod log (moderation.ts).

import { sqlite } from "./game/sqlite.ts";
import { createMessage } from "./discord.ts";
import { on } from "./gateway.ts";
import { selfId } from "./guildcache.ts";

export type LogKind = "mod" | "messages" | "members";

export const LOG_RED = 0xed4245;
export const LOG_ORANGE = 0xf0b232;
export const LOG_GREEN = 0x57f287;
export const LOG_BLUE = 0x5865f2;

export interface LogSettings { channelId: string | null; messages: boolean; members: boolean }

export async function ensureModlogTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS modlog_settings (
      guild_id TEXT PRIMARY KEY,
      channel_id TEXT,
      messages INTEGER NOT NULL DEFAULT 1,
      members INTEGER NOT NULL DEFAULT 1
    )`,
  );
}

export async function getLogSettings(guildId: string): Promise<LogSettings> {
  const r: any = (await sqlite.execute("SELECT * FROM modlog_settings WHERE guild_id = ?", [guildId])).rows[0];
  return { channelId: r?.channel_id ? String(r.channel_id) : null, messages: r ? Number(r.messages) === 1 : true, members: r ? Number(r.members) === 1 : true };
}

export async function setLogSettings(guildId: string, s: LogSettings) {
  await sqlite.execute("INSERT OR REPLACE INTO modlog_settings (guild_id, channel_id, messages, members) VALUES (?, ?, ?, ?)", [guildId, s.channelId, s.messages ? 1 : 0, s.members ? 1 : 0]);
}

/** Posts an embed in the server's log channel, when it has one that takes this kind. */
export async function logEvent(guildId: string, kind: LogKind, embed: Record<string, unknown>): Promise<boolean> {
  const s = await getLogSettings(guildId);
  if (!s.channelId || (kind === "messages" && !s.messages) || (kind === "members" && !s.members)) return false;
  return (await createMessage(s.channelId, { content: "", embeds: [{ timestamp: new Date().toISOString(), ...embed }] })) !== null;
}

// ── Deleted and edited messages ──

interface Seen { guildId: string; channelId: string; authorId: string; content: string; attachments: number }
const MESSAGE_CACHE = Number(Deno.env.get("MESSAGE_CACHE") || 5000);
const seen = new Map<string, Seen>();

function remember(id: string, m: Seen) {
  seen.delete(id);
  seen.set(id, m);
  if (seen.size > MESSAGE_CACHE) seen.delete(seen.keys().next().value!);
}

const quote = (text: string) => text ? text.slice(0, 1000) : "*(no text)*";

on("MESSAGE_CREATE", (m: any) => {
  if (!m.guild_id || m.author?.bot || m.webhook_id) return;
  remember(String(m.id), { guildId: String(m.guild_id), channelId: String(m.channel_id), authorId: String(m.author.id), content: String(m.content ?? ""), attachments: (m.attachments ?? []).length });
});

on("MESSAGE_UPDATE", async (m: any) => {
  if (!m.guild_id || m.content === undefined || m.author?.bot) return;
  const before = seen.get(String(m.id));
  if (!before || before.content === m.content) return;
  remember(String(m.id), { ...before, content: String(m.content) });
  if ((await getLogSettings(before.guildId)).channelId === before.channelId) return;
  await logEvent(before.guildId, "messages", {
    color: LOG_ORANGE,
    title: "✏️ Message edited",
    description: `By <@${before.authorId}> in <#${before.channelId}> · [jump](https://discord.com/channels/${before.guildId}/${before.channelId}/${m.id})`,
    fields: [{ name: "Before", value: quote(before.content) }, { name: "After", value: quote(String(m.content)) }],
  });
});

on("MESSAGE_DELETE", async (m: any) => {
  if (!m.guild_id) return;
  const before = seen.get(String(m.id));
  seen.delete(String(m.id));
  const guildId = String(m.guild_id);
  const channelId = String(m.channel_id);
  if ((await getLogSettings(guildId)).channelId === channelId) return;
  if (!before) return; // the bot's own, or from before a restart: nothing worth saying
  if (before.authorId === selfId) return;
  await logEvent(guildId, "messages", {
    color: LOG_RED,
    title: "🗑️ Message deleted",
    description: `By <@${before.authorId}> in <#${channelId}>`,
    fields: [{ name: "Message", value: quote(before.content) + (before.attachments ? `\n📎 ${before.attachments} attachment(s)` : "") }],
  });
});

on("MESSAGE_DELETE_BULK", async (m: any) => {
  if (!m.guild_id) return;
  const ids: string[] = (m.ids ?? []).map(String);
  for (const id of ids) seen.delete(id);
  const guildId = String(m.guild_id);
  if ((await getLogSettings(guildId)).channelId === String(m.channel_id)) return;
  await logEvent(guildId, "messages", { color: LOG_RED, title: "🗑️ Messages purged", description: `${ids.length} messages in <#${m.channel_id}>` });
});
