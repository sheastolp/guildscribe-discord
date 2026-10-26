// GuildScribe for Discord — the always-on process on the Yoga laptop.
//
// Serves, on 127.0.0.1:PORT (default 8803), where a Cloudflare Tunnel
// brings the public hostname (PUBLIC_BASE_URL):
//   POST /interactions   Discord's Interactions endpoint (every slash command)
//   GET  /bestiary, /gold, /gear?channel=<server id>   the public pages the game links to
//   GET  /health
// and runs the game's scheduled jobs: autohunt settlement and raid musters
// every minute, the wandering merchant every 5 minutes, and WoW raid
// reminders and close-outs (wow.ts) and Twitch go-live checks (live.ts)
// every minute.
//
// At start-up it registers the slash commands with Discord when commands.ts
// has changed since the last time (AUTO_REGISTER=0 turns that off), so a
// deploy never leaves Discord showing yesterday's commands.
//
//   deno task start

import { handleInteraction } from "./interactions.ts";
import { ensureSchema } from "./schema.ts";
import { guildMembers, loginFor, slashHints } from "./identity.ts";
import { PUBLIC_BASE_URL, PUBLIC_ORIGIN } from "./game/config.ts";
import { getBroadcaster, listChannelCharacters } from "./game/db.ts";
import { isPointsEnabled, listChannelPurses } from "./game/points_db.ts";
import { getAdaptations, getChannelRoster } from "./game/bestiary.ts";
import { RAID_MIN_CR } from "./game/raid.ts";
import { renderBestiaryPage } from "./game/bestiary_page.ts";
import { renderGoldPage } from "./game/gold_page.ts";
import { renderGearPage } from "./game/gear_page.ts";
import { warmFivetools } from "./game/fivetools.ts";
import runAutohunt from "./game/autohunt_cron.ts";
import runMerchant from "./game/merchant_cron.ts";
import { runWowJobs } from "./wow.ts";
import { runLiveJobs } from "./live.ts";
import { registrationPayload } from "./commands.ts";
import { putCommands } from "./discord.ts";
import { sqlite } from "./game/sqlite.ts";

const PORT = Number(Deno.env.get("PORT") || 8803);
const HOST = Deno.env.get("HOST") || "127.0.0.1";

// The game spots "!rob @<the bot>" by login (rob.ts); the bot's user ID is its application ID.
const appId = Deno.env.get("DISCORD_APPLICATION_ID");
if (appId && !Deno.env.get("TWITCH_BOT_LOGIN")) Deno.env.set("TWITCH_BOT_LOGIN", loginFor(appId));

/** Runs `job` every `minutes`, never two at once; a failure is logged and the next tick tries again. */
function every(name: string, minutes: number, job: () => Promise<unknown>) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await job();
    } catch (e) {
      console.error(`${name} failed:`, e);
    } finally {
      running = false;
    }
  };
  setTimeout(tick, 30_000);
  setInterval(tick, minutes * 60_000);
}

const cronMinutes = (name: string, fallback: number) => Number(Deno.env.get(name) || fallback);

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The game's pages, made for Discord: member names instead of logins, slash commands
 * instead of chat commands, and no links to pages only the Twitch bot has. */
async function discordPage(guildId: string, html: string): Promise<Response> {
  const names = new Map((await guildMembers(guildId)).map((m) => [m.login, m.display]));
  const base = PUBLIC_BASE_URL.replace(/\/+$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  html = html
    .replace(new RegExp(`<a href="${base}/(?!bestiary|gold|gear)[^"]*">([\\s\\S]*?)</a>`, "g"), "$1")
    .replace(/\bu[0-9a-z]{6,13}\b/g, (login) => names.has(login) ? escapeHtml(names.get(login)!) : login)
    .replace(/(From |from |Hunt from )Twitch chat/g, "$1Discord")
    .replace(/<code>(!\w[^<]*)<\/code>/g, (_m, cmd: string) => `<code>${slashHints(cmd)}</code>`);
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

async function handlePage(path: string, url: URL): Promise<Response | null> {
  if (path !== "/bestiary" && path !== "/gold" && path !== "/gear") return null;
  const guildId = url.searchParams.get("channel") ?? "";
  if (!/^\d+$/.test(guildId)) return new Response("Missing or invalid server.", { status: 400 });
  const guild = await getBroadcaster(guildId);
  if (!guild) return new Response("GuildScribe hasn't been used in that server yet.", { status: 404 });
  const name = String(guild.display_name || "This server");
  if (path === "/bestiary") {
    const [roster, adapt] = await Promise.all([getChannelRoster(guildId), getAdaptations(guildId)]);
    return await discordPage(guildId, renderBestiaryPage(name, roster, adapt, RAID_MIN_CR, PUBLIC_BASE_URL));
  }
  if (path === "/gold") {
    if (!(await isPointsEnabled(guildId))) return new Response("Gold is switched off in this server.", { status: 404 });
    const purses = await listChannelPurses(guildId);
    return await discordPage(guildId, renderGoldPage(name, purses, guildId, PUBLIC_BASE_URL));
  }
  const characters = await listChannelCharacters(guildId, 1000);
  return await discordPage(guildId, renderGearPage(name, guildId, characters, PUBLIC_BASE_URL));
}

/** Registers the slash commands globally when they differ from the last registration. True when it registered. */
export async function registerIfChanged(): Promise<boolean> {
  const appId = Deno.env.get("DISCORD_APPLICATION_ID");
  if (!appId || !Deno.env.get("DISCORD_BOT_TOKEN") || Deno.env.get("AUTO_REGISTER") === "0") return false;
  const payload = JSON.stringify(registrationPayload());
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(appId + payload)));
  const hash = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
  await sqlite.execute("CREATE TABLE IF NOT EXISTS discord_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const res = await sqlite.execute("SELECT value FROM discord_meta WHERE key = 'commands_hash'");
  if ((res.rows[0] as any)?.value === hash) return false;
  const result = await putCommands(appId, JSON.parse(payload));
  if (!result) {
    console.error("Registering slash commands failed; trying again at the next start.");
    return false;
  }
  await sqlite.execute("INSERT OR REPLACE INTO discord_meta (key, value) VALUES ('commands_hash', ?)", [hash]);
  console.log(`Registered ${result.length} slash commands with Discord (they can take a few minutes to show everywhere).`);
  return true;
}

export async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  try {
    if (req.method === "POST" && (path === "/interactions" || path === "/")) return await handleInteraction(req);
    if (req.method === "GET" && path === "/health") return new Response("ok");
    if (req.method === "GET") {
      const page = await handlePage(path, url);
      if (page) return page;
      if (path === "/") return new Response("GuildScribe for Discord is running. Discord sends slash commands to POST /interactions.");
    }
    return new Response("Not found", { status: 404 });
  } catch (e) {
    console.error("request failed", e);
    return new Response("Internal error", { status: 500 });
  }
}

if (import.meta.main) {
  await ensureSchema();
  every("autohunt_cron", cronMinutes("AUTOHUNT_CRON_MINUTES", 1), () => runAutohunt());
  every("merchant_cron", cronMinutes("MERCHANT_CRON_MINUTES", 5), () => runMerchant());
  every("wow_cron", 1, () => runWowJobs());
  every("live_cron", 1, () => runLiveJobs());
  registerIfChanged().catch((e) => console.error("command registration failed", e));
  // Download the 5e.tools archive in the background so the first lookup that needs it doesn't wait.
  warmFivetools();
  Deno.serve({ port: PORT, hostname: HOST }, (req) => {
    // The tunnel hands requests over as plain http://127.0.0.1; use the public URL.
    const url = new URL(req.url);
    return handler(new Request(new URL(url.pathname + url.search, PUBLIC_ORIGIN), req));
  });
}
