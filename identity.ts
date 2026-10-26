// Who is who: Discord members as the game modules see them, and turning the
// game's Twitch-flavored replies into Discord text.
//
// The game code (game/) keys every player by a Twitch-style login —
// lowercase letters, digits and underscores, at most 25 characters — and
// finds targets in "@login" arguments. A Discord username can change and may
// contain dots, so each member's login is derived from their user ID
// instead: "u" + the ID in base 36 (e.g. u2k9d1x0q7p3a). It never changes,
// so a renamed member keeps their character, gold and party.
//
// Replies are rewritten on the way out: "@login" and "@Display Name" become
// real Discord mentions, a bare login becomes the member's display name, and
// "!command" hints become the matching slash command.

import { sqlite } from "./game/sqlite.ts";
import { slashHints } from "./commands.ts";

export function loginFor(userId: string): string {
  return "u" + BigInt(userId).toString(36);
}

export function userIdFor(login: string): string | null {
  const m = login.toLowerCase().match(/^u([0-9a-z]{1,13})$/);
  if (!m) return null;
  let n = 0n;
  for (const ch of m[1]) n = n * 36n + BigInt(parseInt(ch, 36));
  return n.toString();
}

export interface Member { userId: string; login: string; display: string }

/** A member's name as the server shows it: server nickname, then global display name, then username. */
export function displayName(member: any, user: any): string {
  const name = String(member?.nick || user?.global_name || user?.username || "adventurer");
  return name.replace(/\s+/g, " ").trim().slice(0, 40) || "adventurer";
}

export async function ensureMemberTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS discord_members (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      login TEXT NOT NULL,
      display TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    )`,
  );
}

const cache = new Map<string, { at: number; members: Member[] }>();
const CACHE_MS = 60_000;

/** Records the name a member goes by in this server (called for everyone an interaction names). */
export async function rememberMember(guildId: string, m: Member) {
  await sqlite.execute(
    `INSERT INTO discord_members (guild_id, user_id, login, display, updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT (guild_id, user_id) DO UPDATE SET display = excluded.display, login = excluded.login, updated_at = excluded.updated_at`,
    [guildId, m.userId, m.login, m.display, Date.now()],
  );
  const hit = cache.get(guildId);
  if (hit) {
    hit.members = hit.members.filter((x) => x.userId !== m.userId);
    hit.members.push(m);
  }
}

export async function guildMembers(guildId: string): Promise<Member[]> {
  const hit = cache.get(guildId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.members;
  const res = await sqlite.execute("SELECT user_id, login, display FROM discord_members WHERE guild_id = ?", [guildId]);
  const members = res.rows.map((r: any) => ({ userId: String(r.user_id), login: String(r.login), display: String(r.display) }));
  cache.set(guildId, { at: Date.now(), members });
  return members;
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export { slashHints };

/** For a DM, which belongs to no server: "@login" and bare logins become the name the member last used anywhere. */
export async function toPlainText(text: string): Promise<string> {
  const logins = [...new Set(text.match(/\bu[0-9a-z]{6,13}\b/g) ?? [])];
  if (!logins.length) return slashHints(text);
  const res = await sqlite.execute(
    `SELECT login, display FROM discord_members WHERE login IN (${logins.map(() => "?").join(",")}) ORDER BY updated_at`,
    logins,
  );
  const names = new Map(res.rows.map((r: any) => [String(r.login), String(r.display)]));
  return slashHints(text.replace(/\bu[0-9a-z]{6,13}\b/g, (login) => names.get(login) ?? login));
}

// Pages this bot serves (server.ts). The game also links a character sheet
// and a roster page, which only the Twitch bot has; those links are dropped.
const SERVED_PAGES = new Set(["/bestiary", "/gold", "/gear"]);

function dropUnservedLinks(text: string, base: string): string {
  const origin = escapeRe(base.replace(/\/+$/, ""));
  return text.replace(new RegExp(`(\\s*(?:—|-|:|🔗)?\\s*)${origin}(/[^\\s?|]*)?(\\?[^\\s|]*)?`, "g"), (whole, _lead, path = "/") =>
    SERVED_PAGES.has(path) ? whole : "");
}

/** Discord-ready text: mentions for @-names (or plain "@Name" with mentions off, for files),
 * display names for bare logins, slash-command hints, and no links to pages this bot lacks. */
export async function toDiscordText(guildId: string, text: string, opts: { mentions?: boolean; base?: string } = {}): Promise<string> {
  const mentions = opts.mentions ?? true;
  // Links first, while the logins in their query strings are still logins.
  if (opts.base) text = dropUnservedLinks(text, opts.base);
  const members = await guildMembers(guildId);
  const byLogin = new Map(members.map((m) => [m.login, m]));
  // @login (any case) → <@id>: a member seen here, or anything that decodes to
  // a snowflake (17-20 digits, and the login has a digit, so "@unbelievable" stays a word).
  text = text.replace(/@(u[0-9a-z]{1,13})\b/gi, (whole, raw: string) => {
    const login = raw.toLowerCase();
    const known = byLogin.get(login);
    if (known) return mentions ? `<@${known.userId}>` : `@${known.display}`;
    const id = userIdFor(login);
    return mentions && id && /\d/.test(login) && /^\d{17,20}$/.test(id) ? `<@${id}>` : whole;
  });
  // @Display Name → <@id>, longest names first so "Bo" never eats "Bob".
  if (mentions) {
    const byDisplay = [...members].sort((a, b) => b.display.length - a.display.length);
    for (const m of byDisplay) {
      if (!text.includes(`@${m.display}`)) continue;
      text = text.replace(new RegExp(`@${escapeRe(m.display)}(?![\\w])`, "g"), `<@${m.userId}>`);
    }
  }
  // A bare login (battle logs, rosters, initiative order) → the member's name.
  text = text.replace(/\bu[0-9a-z]{6,13}\b/g, (login) => byLogin.get(login)?.display ?? login);
  return slashHints(text);
}
