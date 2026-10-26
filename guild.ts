// Discord servers as the game sees them.
//
// The game code (game/) is per Twitch channel: it keys everything by a
// broadcaster ID and expects a `broadcasters` row for it that is connected
// and live (XP, chat gold, autohunts and raids only run while live). Each
// Discord server gets such a row the first time a command is used there,
// with is_live = 1 for good: a server has no stream to wait for.
//
// On Twitch every feature starts off so the bot is quiet when it joins a
// chat. Here the bot only ever speaks when a member uses a slash command,
// so every game feature starts on; moderators switch them with
// /guildscribe feature. The merchant still starts away (it posts on its own),
// and Dragon's Dice (STARTS_OFF) waits for a moderator to opt in.
//
// A feature added later (FEATURES grows, or a sync brings new game code)
// is switched to its starting state in servers set up before it, the next
// time they're seen (discord_guilds.features lists the ones already done).
// Any other Twitch dashboard switch can be flipped by its own name too
// (/guildscribe feature name:<group>), so a new Twitch command group that
// starts off is never out of reach.

import { sqlite } from "./game/sqlite.ts";
import { isCommandGroupEnabled, setCommandGroupEnabled } from "./game/db.ts";
import { isPointsEnabled, setPointsEnabled } from "./game/points_db.ts";
import { COMMAND_GROUPS } from "./game/commandgroups.ts";

/** Feature name (/guildscribe feature) → the Twitch dashboard switches it covers. */
export const FEATURES: Record<string, { label: string; groups: string[] }> = {
  characters: { label: "Characters (/createchar, /newchar, /bg3, /char, /levelup, /hp, /shmash, /hug)", groups: ["charcreate", "charprogress", "charsaves", "charfun", "bg3char", "hug"] },
  dice: { label: "Dice and fate (/roll, /d20, /save, /saves, /rollcall, /oracle)", groups: ["d20", "diceroll", "rollchecks", "rollfate", "rollcall", "oracle"] },
  lookups: { label: "Archives (/spell, /item, /class, /feat, /ability, /race, /rule, /monster)", groups: ["rules", "items", "races"] },
  bg3: { label: "Baldur's Gate 3 (/bg3lookup, /bg3roll, /bg3companion, /bg3loot…)", groups: ["bg3roll", "bg3companion", "bg3loot", "bg3lookup"] },
  div2: { label: "The Division 2 (/div2)", groups: ["div2build", "div2loot", "div2lookup"] },
  combat: { label: "Parties, duels and initiative (/party, /duel, /turn)", groups: ["party", "duels", "partyduels", "turn"] },
  hunts: { label: "Monster hunts (/duel monster, /duel hunt, /hunt, /autohunt, /bestiary, Hunt and Hoard)", groups: ["hunts", "partyhunts", "autohunt", "huntcooldown", "bestiary"] },
  raid: { label: "Raid quest (/rally)", groups: ["raid"] },
  gold: { label: "Gold (/gold, coin for using commands, monster loot)", groups: ["chatgold", "goldcheck", "goldgive", "leaderboard"] },
  giveaways: { label: "Giveaways (/giveaway)", groups: ["giveaways"] },
  rob: { label: "Robbing (/rob)", groups: ["rob"] },
  bribe: { label: "Bribing (/bribe)", groups: ["bribe"] },
  gamble: { label: "Dragon's Dice (/gamble)", groups: ["gamble"] },
  fun: { label: "Fun stuff (/fun: coinflip, flip, jumble, dad jokes, animal facts and pictures)", groups: ["funstuff"] },
  askme: { label: "Ask me anything (/askme: an AI answer with a source)", groups: ["askme"] },
  quotes: { label: "Quotes (/quote)", groups: ["quotes"] },
  wow: { label: "World of Warcraft: Forever (/wow: launch countdown, raid signups, invites, attendance)", groups: ["wowforever", "wowraid"] },
};

/** Features a new server starts with off anyway (gambling is opt-in, as on Twitch). */
const STARTS_OFF = new Set(["gamble"]);

export async function ensureGuildTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS discord_guilds (
      guild_id TEXT PRIMARY KEY,
      name TEXT,
      announce_channel_id TEXT,
      last_channel_id TEXT,
      set_up_at INTEGER NOT NULL
    )`,
  );
  // Added after the first servers were set up; NULL means "the original features".
  try {
    await sqlite.execute("ALTER TABLE discord_guilds ADD COLUMN features TEXT");
  } catch { /* already there */ }
}

/** The features a server had before discord_guilds.features existed. */
const ORIGINAL_FEATURES = ["characters", "dice", "lookups", "bg3", "div2", "combat", "hunts", "raid", "gold", "giveaways", "rob", "bribe", "gamble"];

const ready = new Set<string>();
const lastChannel = new Map<string, string>();

/** Makes sure a server can play, the first time it's seen; remembers the channel commands are used in. */
export async function ensureGuild(guildId: string, channelId?: string, fetchName?: () => Promise<string | null>) {
  if (!ready.has(guildId)) {
    const res = await sqlite.execute("SELECT features FROM discord_guilds WHERE guild_id = ?", [guildId]);
    if (!res.rows.length) await setUpGuild(guildId, fetchName);
    else await addNewFeatures(guildId, (res.rows[0] as any).features);
    ready.add(guildId);
  }
  if (channelId && lastChannel.get(guildId) !== channelId) {
    lastChannel.set(guildId, channelId);
    await sqlite.execute("UPDATE discord_guilds SET last_channel_id = ? WHERE guild_id = ?", [channelId, guildId]);
  }
}

async function setUpGuild(guildId: string, fetchName?: () => Promise<string | null>) {
  const now = Date.now();
  const name = (await fetchName?.().catch(() => null)) || "Discord server";
  await sqlite.execute(
    `INSERT OR IGNORE INTO broadcasters (broadcaster_id, login, display_name, connected_at, connected, is_live, stream_status_subscribed)
     VALUES (?, ?, ?, ?, 1, 1, 1)`,
    [guildId, `discord-${guildId}`, name, now],
  );
  await sqlite.execute("UPDATE broadcasters SET connected = 1, is_live = 1 WHERE broadcaster_id = ?", [guildId]);
  for (const feature of Object.keys(FEATURES)) await setFeature(guildId, feature, !STARTS_OFF.has(feature));
  await sqlite.execute("INSERT OR IGNORE INTO discord_guilds (guild_id, name, set_up_at, features) VALUES (?, ?, ?, ?)", [guildId, name, now, Object.keys(FEATURES).join(",")]);
}

/** Switches features this server hasn't had yet to their starting state, leaving the rest as its moderators set them. */
async function addNewFeatures(guildId: string, recorded: unknown) {
  const done = new Set(recorded ? String(recorded).split(",") : ORIGINAL_FEATURES);
  const fresh = Object.keys(FEATURES).filter((f) => !done.has(f));
  if (!fresh.length) return;
  for (const feature of fresh) await setFeature(guildId, feature, !STARTS_OFF.has(feature));
  await sqlite.execute("UPDATE discord_guilds SET features = ? WHERE guild_id = ?", [[...done, ...fresh].join(","), guildId]);
}

/** A name /guildscribe feature accepts: one of FEATURES, or any Twitch dashboard switch. */
export function isSwitchName(name: string): boolean {
  return Boolean(FEATURES[name] || COMMAND_GROUPS[name]);
}

/** Choices for /guildscribe feature's name, matching what's typed so far (features first). */
export function switchChoices(typed: string): string[] {
  const q = typed.toLowerCase().trim();
  const names = [...Object.keys(FEATURES), ...Object.keys(COMMAND_GROUPS).filter((g) => !featureForGroup(g))];
  return names.filter((n) => n.includes(q)).slice(0, 25);
}

export async function setFeature(guildId: string, feature: string, on: boolean) {
  const def = FEATURES[feature] ?? (COMMAND_GROUPS[feature] ? { groups: [feature] } : null);
  if (!def) throw new Error(`unknown feature ${feature}`);
  for (const group of def.groups) await setCommandGroupEnabled(guildId, group, on);
  if (feature === "gold") await setPointsEnabled(guildId, on);
}

/** Which feature a dashboard switch belongs to, for "that's switched off" replies. */
export function featureForGroup(group: string): string | null {
  for (const [name, def] of Object.entries(FEATURES)) if (def.groups.includes(group)) return name;
  return null;
}

export async function featureStatus(guildId: string): Promise<Array<{ name: string; label: string; on: boolean }>> {
  const out: Array<{ name: string; label: string; on: boolean }> = [];
  for (const [name, def] of Object.entries(FEATURES)) {
    const states = await Promise.all(def.groups.map((g) => isCommandGroupEnabled(guildId, g)));
    let on = states.some(Boolean);
    if (name === "gold") on = on && await isPointsEnabled(guildId);
    out.push({ name, label: def.label, on });
  }
  return out;
}

export async function setAnnounceChannel(guildId: string, channelId: string | null) {
  await sqlite.execute("UPDATE discord_guilds SET announce_channel_id = ? WHERE guild_id = ?", [channelId, guildId]);
}

/** Where GuildScribe posts on its own: the chosen channel, else where commands were last used. */
export async function announceChannel(guildId: string): Promise<{ channelId: string | null; chosen: boolean }> {
  const res = await sqlite.execute("SELECT announce_channel_id, last_channel_id FROM discord_guilds WHERE guild_id = ?", [guildId]);
  const row: any = res.rows[0];
  if (row?.announce_channel_id) return { channelId: String(row.announce_channel_id), chosen: true };
  return { channelId: row?.last_channel_id ? String(row.last_channel_id) : null, chosen: false };
}
