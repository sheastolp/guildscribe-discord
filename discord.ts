// Discord's HTTP API: verifying interactions and sending messages.
//
// Slash commands arrive as HTTPS POSTs (the Interactions endpoint), so no
// Gateway connection is needed. Each is answered at once with "thinking…"
// (a deferred response, which Discord requires within 3 seconds) and the
// real reply is filled in afterwards through the interaction's webhook —
// fights and 5e.tools lookups can take longer than 3 seconds.
//
// Posts nobody asked for (merchant ads, autohunt reports, raid launches) and
// DMs use the bot token, and so do edits to the bot's own posts later on
// (a WoW raid signup post, wow.ts): an interaction's webhook only lasts 15 minutes.

const API = "https://discord.com/api/v10";

export const InteractionType = { PING: 1, APPLICATION_COMMAND: 2, MESSAGE_COMPONENT: 3, AUTOCOMPLETE: 4, MODAL_SUBMIT: 5 } as const;
export const ResponseType = { PONG: 1, CHANNEL_MESSAGE: 4, DEFERRED_CHANNEL_MESSAGE: 5, DEFERRED_UPDATE_MESSAGE: 6, UPDATE_MESSAGE: 7, AUTOCOMPLETE_RESULT: 8 } as const;
export const EPHEMERAL = 1 << 6;

export function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

let verifyKey: { hex: string; key: Promise<CryptoKey> } | null = null;

/** Checks the Ed25519 signature Discord puts on every interaction (DISCORD_PUBLIC_KEY). */
export async function verifyInteraction(body: string, signature: string | null, timestamp: string | null): Promise<boolean> {
  if (!signature || !timestamp || !/^[0-9a-f]+$/i.test(signature)) return false;
  const hex = env("DISCORD_PUBLIC_KEY");
  if (verifyKey?.hex !== hex) verifyKey = { hex, key: crypto.subtle.importKey("raw", hexToBytes(hex), { name: "Ed25519" }, false, ["verify"]) };
  try {
    return await crypto.subtle.verify({ name: "Ed25519" }, await verifyKey.key, hexToBytes(signature), new TextEncoder().encode(timestamp + body));
  } catch {
    return false;
  }
}

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export interface OutMessage {
  content: string;
  files?: { name: string; content: string }[];
  /** User IDs this message may ping; nobody else is pinged. */
  ping?: string[];
  /** Discord embed objects (wow.ts's raid cards). */
  embeds?: unknown[];
  /** Action rows of buttons; [] removes them. */
  components?: unknown[];
  /** Role IDs this message may ping (a raid post's "@Raiders"). */
  pingRoles?: string[];
  /** Only the member who used the command or button sees it (interaction replies and follow-ups). */
  ephemeral?: boolean;
}

function messageBody(m: OutMessage): BodyInit {
  const payload: Record<string, unknown> = {
    content: m.content.slice(0, 2000),
    allowed_mentions: { parse: [], users: m.ping ?? [], ...(m.pingRoles?.length ? { roles: m.pingRoles } : {}) },
  };
  if (m.ephemeral) payload.flags = EPHEMERAL;
  if (m.embeds) payload.embeds = m.embeds;
  if (m.components) payload.components = m.components;
  if (!m.files?.length) return JSON.stringify(payload);
  payload.attachments = m.files.map((f, i) => ({ id: i, filename: f.name }));
  const form = new FormData();
  form.append("payload_json", JSON.stringify(payload));
  m.files.forEach((f, i) => form.append(`files[${i}]`, new Blob([f.content], { type: "text/plain" }), f.name));
  return form;
}

/** One API call, retried once after a rate limit. Returns the parsed body, or null on failure. */
async function call(method: string, path: string, body?: BodyInit, auth = true): Promise<any | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const headers: Record<string, string> = {};
    if (auth) headers.Authorization = `Bot ${env("DISCORD_BOT_TOKEN")}`;
    if (typeof body === "string") headers["Content-Type"] = "application/json";
    const res = await fetch(`${API}${path}`, { method, headers, body });
    if (res.status === 429 && attempt === 0) {
      const wait = Number((await res.json().catch(() => ({})))?.retry_after ?? 1);
      await new Promise((r) => setTimeout(r, Math.min(10, wait) * 1000 + 100));
      continue;
    }
    if (!res.ok) {
      console.error(`Discord ${method} ${path.replace(/\/webhooks\/\d+\/[^/]+/, "/webhooks/…")} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
      return null;
    }
    return res.status === 204 ? {} : await res.json().catch(() => ({}));
  }
  return null;
}

/** Fills in a deferred reply ("thinking…") with the real message. */
export async function editOriginal(appId: string, token: string, m: OutMessage) {
  return await call("PATCH", `/webhooks/${appId}/${token}/messages/@original`, messageBody(m), false);
}

/** A further message under the same reply. */
export async function followUp(appId: string, token: string, m: OutMessage) {
  return await call("POST", `/webhooks/${appId}/${token}`, messageBody(m), false);
}

/** Posts in a server channel as the bot. */
export async function postToChannel(channelId: string, m: OutMessage): Promise<boolean> {
  return (await call("POST", `/channels/${channelId}/messages`, messageBody(m))) !== null;
}

/** Posts in a channel as the bot; the new message's id, or null. */
export async function createMessage(channelId: string, m: OutMessage): Promise<string | null> {
  const msg = await call("POST", `/channels/${channelId}/messages`, messageBody(m));
  return msg?.id ? String(msg.id) : null;
}

/** Edits one of the bot's own messages. */
export async function editMessage(channelId: string, messageId: string, m: OutMessage): Promise<boolean> {
  return (await call("PATCH", `/channels/${channelId}/messages/${messageId}`, messageBody(m))) !== null;
}

/** The body of an interaction response that carries a message (reply or in-place update). */
export function messageData(m: OutMessage, ephemeral = m.ephemeral ?? false) {
  return {
    content: m.content.slice(0, 2000),
    allowed_mentions: { parse: [], users: m.ping ?? [], ...(m.pingRoles?.length ? { roles: m.pingRoles } : {}) },
    ...(m.embeds ? { embeds: m.embeds } : {}),
    ...(m.components ? { components: m.components } : {}),
    ...(ephemeral ? { flags: EPHEMERAL } : {}),
  };
}

const dmChannels = new Map<string, string>();

/** DMs a member; false when Discord refuses (they don't take DMs from the server's members). */
export async function sendDm(userId: string, m: OutMessage): Promise<boolean> {
  let channelId = dmChannels.get(userId);
  if (!channelId) {
    const ch = await call("POST", "/users/@me/channels", JSON.stringify({ recipient_id: userId }));
    if (!ch?.id) return false;
    channelId = String(ch.id);
    dmChannels.set(userId, channelId);
  }
  return await postToChannel(channelId, m);
}

export async function guildName(guildId: string): Promise<string | null> {
  const g = await call("GET", `/guilds/${guildId}`);
  return g?.name ? String(g.name) : null;
}

/** Replaces every slash command (PUT /applications/{id}/commands, or one test server's). */
export async function putCommands(appId: string, commands: unknown[], guildId?: string) {
  const path = guildId ? `/applications/${appId}/guilds/${guildId}/commands` : `/applications/${appId}/commands`;
  return await call("PUT", path, JSON.stringify(commands));
}

/** Splits text into messages of at most `max` characters, at line breaks, then " | ", then spaces. */
export function splitMessage(text: string, max = 2000): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf("\n");
    if (cut < max / 2) cut = window.lastIndexOf(" | ");
    if (cut < max / 2) cut = window.lastIndexOf(" ");
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\s*\|?\s*/, "");
  }
  if (rest) out.push(rest);
  return out;
}
