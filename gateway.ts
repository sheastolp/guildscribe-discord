// The Discord Gateway: a WebSocket that tells GuildScribe what happens in its
// servers, not just which slash commands are used. Slash commands still come
// over HTTP (interactions.ts); the Gateway brings the rest:
//
//   MESSAGE_CREATE / UPDATE / DELETE    levels (XP for chatting), the honeypot,
//                                       anti-spam, message logs
//   GUILD_MEMBER_ADD / REMOVE           invite tracking, welcome and leave
//                                       messages, autoroles, anti-raid
//   INVITE_CREATE / DELETE              invite tracking
//   GUILD_AUDIT_LOG_ENTRY_CREATE        anti-nuke (mass channel/role deletes, bans)
//   GUILD_CREATE, GUILD_ROLE_*          roles and owner, for permissions (guildcache.ts)
//
// Each feature module registers what it wants with `on(event, handler)`;
// one handler failing never stops the others. The connection heartbeats,
// resumes after a drop, and reconnects with backoff.
//
// Two of the intents are privileged: Server Members (joins and leaves) and
// Message Content (anti-spam's invite-link filter, message logs). Switch both
// on under Developer Portal → Bot → Privileged Gateway Intents. If Discord
// refuses them, GuildScribe connects without them and says what's missing.
//
// GATEWAY=0 turns the connection off: only slash commands, as before.

import { api, env } from "./discord.ts";
import { adjustMemberCount, forgetGuild, rememberGuild, setSelfId } from "./guildcache.ts";

const VERSION = 10;

export const Intent = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1, // privileged
  GUILD_MODERATION: 1 << 2,
  GUILD_INVITES: 1 << 6,
  GUILD_MESSAGES: 1 << 9,
  MESSAGE_CONTENT: 1 << 15, // privileged
} as const;

const ALL = Intent.GUILDS | Intent.GUILD_MEMBERS | Intent.GUILD_MODERATION | Intent.GUILD_INVITES | Intent.GUILD_MESSAGES | Intent.MESSAGE_CONTENT;
const PRIVILEGED = Intent.GUILD_MEMBERS | Intent.MESSAGE_CONTENT;

type Handler = (data: any) => Promise<unknown> | unknown;
const handlers = new Map<string, Handler[]>();

/** Runs `handler` for every Gateway event of this type. */
export function on(event: string, handler: Handler) {
  handlers.set(event, [...(handlers.get(event) ?? []), handler]);
}

/** Hands an event to its handlers (the connection calls it; tests call it directly). */
export async function dispatch(event: string, data: any) {
  // The caches every feature relies on go first.
  if (event === "READY") setSelfId(String(data.user?.id ?? ""));
  else if (event === "GUILD_CREATE") rememberGuild(data);
  else if (event === "GUILD_ROLE_CREATE" || event === "GUILD_ROLE_UPDATE" || event === "GUILD_ROLE_DELETE" || event === "GUILD_UPDATE") forgetGuild(String(data.guild_id ?? data.id));
  else if (event === "GUILD_MEMBER_ADD") adjustMemberCount(String(data.guild_id), 1);
  else if (event === "GUILD_MEMBER_REMOVE") adjustMemberCount(String(data.guild_id), -1);
  for (const h of handlers.get(event) ?? []) {
    try {
      await h(data);
    } catch (e) {
      console.error(`gateway ${event} handler failed`, e);
    }
  }
}

/** Whether the connection has the privileged intents (false until READY, or when Discord refused them). */
export const gatewayState = { connected: false, privileged: true };

/** Connects and stays connected; the returned function disconnects for good (tests). */
export function startGateway(): () => void {
  if (Deno.env.get("GATEWAY") === "0" || !Deno.env.get("DISCORD_BOT_TOKEN")) return () => {};
  let stopped = false;
  let intents = ALL;
  let ws: WebSocket | null = null;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let acked = true;
  let seq: number | null = null;
  let sessionId: string | null = null;
  let resumeUrl: string | null = null;
  let failures = 0;

  const send = (op: number, d: unknown) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ op, d }));

  const identify = () =>
    send(2, { token: env("DISCORD_BOT_TOKEN"), intents, properties: { os: "linux", browser: "guildscribe", device: "guildscribe" } });

  const connect = async () => {
    let url = resumeUrl;
    if (!url) {
      const info = await api("GET", "/gateway/bot").catch(() => null);
      url = String(info?.url ?? "wss://gateway.discord.gg");
    }
    ws = new WebSocket(`${url}/?v=${VERSION}&encoding=json`);
    ws.onmessage = (ev) => {
      // An exception escaping here would end the whole process: log it and carry on.
      try {
        receive(JSON.parse(String(ev.data)));
      } catch (e) {
        console.error("Gateway message failed", e);
      }
    };
    const receive = (msg: any) => {
      if (msg.s !== null && msg.s !== undefined) seq = msg.s;
      switch (msg.op) {
        case 10: { // Hello
          clearInterval(heartbeat);
          acked = true;
          const every = Number(msg.d.heartbeat_interval);
          setTimeout(() => send(1, seq), Math.random() * every);
          heartbeat = setInterval(() => {
            if (!acked) return ws?.close(4000, "no heartbeat ack"); // a zombie connection: reconnect and resume
            acked = false;
            send(1, seq);
          }, every);
          if (sessionId && seq !== null) send(6, { token: env("DISCORD_BOT_TOKEN"), session_id: sessionId, seq });
          else identify();
          break;
        }
        case 11:
          acked = true;
          break;
        case 1:
          send(1, seq);
          break;
        case 7: // Reconnect: resume elsewhere
          ws?.close(4000, "reconnect requested");
          break;
        case 9: // Invalid session: resumable or not
          if (!msg.d) {
            sessionId = null;
            seq = null;
            resumeUrl = null;
          }
          setTimeout(() => (msg.d ? ws?.close(4000, "resume") : identify()), 1000 + Math.random() * 4000);
          break;
        case 0:
          if (msg.t === "READY") {
            sessionId = String(msg.d.session_id);
            resumeUrl = String(msg.d.resume_gateway_url ?? "") || null;
            failures = 0;
            gatewayState.connected = true;
            gatewayState.privileged = (intents & PRIVILEGED) === PRIVILEGED;
            console.log(`Gateway connected as ${msg.d.user?.username ?? "the bot"} in ${msg.d.guilds?.length ?? 0} servers.`);
          }
          if (msg.t === "RESUMED") failures = 0;
          dispatch(String(msg.t), msg.d).catch((e) => console.error(`gateway ${msg.t} failed`, e));
          break;
      }
    };
    ws.onclose = (ev) => {
      clearInterval(heartbeat);
      gatewayState.connected = false;
      if (stopped) return;
      const code = ev.code;
      if (code === 4004) return console.error("Gateway: Discord rejected DISCORD_BOT_TOKEN. Not reconnecting.");
      if (code === 4014 && (intents & PRIVILEGED)) {
        console.error(
          "Gateway: Discord refused the privileged intents. Switch on Server Members Intent and Message Content Intent " +
            "(Developer Portal → Bot). Until then: no invite tracking, welcome messages, autoroles, anti-raid, invite-link filter or message logs.",
        );
        intents &= ~PRIVILEGED;
      }
      // These mean the session can't be resumed: start fresh.
      if ([4007, 4009, 4010, 4011, 4012, 4013, 4014].includes(code)) {
        sessionId = null;
        seq = null;
        resumeUrl = null;
      }
      retry();
    };
    ws.onerror = () => {}; // onclose follows and reconnects
  };

  const retry = () => {
    failures++;
    const wait = Math.min(60_000, 1000 * 2 ** Math.min(failures, 6)) + Math.random() * 1000;
    setTimeout(start, wait);
  };
  const start = () => {
    if (stopped) return;
    connect().catch((e) => {
      console.error("Gateway connect failed", e);
      retry();
    });
  };
  start();
  return () => {
    stopped = true;
    clearInterval(heartbeat);
    ws?.close(1000, "shutting down");
  };
}
