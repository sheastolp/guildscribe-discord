// World of Warcraft: Forever raid nights — the tables behind wow.ts.
//
//   wow_raids       one raid or party night: when, size, role slots, its signup post
//   wow_signups     who clicked what on it (yes with a role, maybe, no)
//   wow_invites     who was invited, by whom, and whether the DM got through
//   wow_attendance  after the raid: who showed up and who didn't
//   wow_loot        drops handed out on a raid
//   wow_chars       a member's main (name, class, role), shown on rosters
//   wow_settings    a server's default timezone and reminder lead time
//
// Discord-only: the Twitch bot has no raid signups, so none of this is
// synced from it (the launch countdown, game/wow_forever.ts, is).

import { sqlite } from "./game/sqlite.ts";
import { DEFAULT_TIMEZONE } from "./wow_time.ts";

export type Role = "tank" | "healer" | "dps";
export const ROLES: Role[] = ["tank", "healer", "dps"];
export type Answer = "yes" | "maybe" | "no";
export type RaidStatus = "open" | "done" | "cancelled";
export type Attendance = "present" | "noshow";

export interface Raid {
  id: number;
  guildId: string;
  title: string;
  startsAt: number;
  size: number;
  slots: Record<Role, number>;
  notes: string;
  leaderId: string;
  channelId: string | null;
  messageId: string | null;
  pingRoleId: string | null;
  timezone: string;
  status: RaidStatus;
  reminded: boolean;
  createdAt: number;
  closedAt: number | null;
}

export interface Signup {
  userId: string;
  display: string;
  role: Role | null;
  answer: Answer;
  signedAt: number;
}

export interface WowChar { name: string; cls: string; role: Role | null }

/** Role slots for a raid size when the leader doesn't set them. */
export function defaultSlots(size: number): Record<Role, number> {
  const table: Record<number, [number, number, number]> = { 5: [1, 1, 3], 10: [2, 2, 6], 20: [2, 4, 14], 25: [3, 5, 17], 40: [5, 10, 25] };
  const [tank, healer, dps] = table[size] ?? [Math.max(1, Math.round(size / 10)), Math.max(1, Math.round(size / 5)), 0];
  return { tank, healer, dps: dps || Math.max(0, size - tank - healer) };
}

export async function ensureWowTables() {
  await sqlite.batch([
    `CREATE TABLE IF NOT EXISTS wow_raids (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      title TEXT NOT NULL,
      starts_at INTEGER NOT NULL,
      size INTEGER NOT NULL,
      tanks INTEGER NOT NULL,
      healers INTEGER NOT NULL,
      dps INTEGER NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      leader_id TEXT NOT NULL,
      channel_id TEXT,
      message_id TEXT,
      ping_role_id TEXT,
      timezone TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      reminded INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      closed_at INTEGER
    )`,
    "CREATE INDEX IF NOT EXISTS wow_raids_guild ON wow_raids (guild_id, status, starts_at)",
    `CREATE TABLE IF NOT EXISTS wow_signups (
      raid_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      display TEXT NOT NULL,
      role TEXT,
      answer TEXT NOT NULL,
      signed_at INTEGER NOT NULL,
      PRIMARY KEY (raid_id, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS wow_invites (
      raid_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      invited_by TEXT NOT NULL,
      invited_at INTEGER NOT NULL,
      dm_ok INTEGER NOT NULL,
      PRIMARY KEY (raid_id, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS wow_attendance (
      raid_id INTEGER NOT NULL,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      display TEXT NOT NULL,
      role TEXT,
      status TEXT NOT NULL,
      PRIMARY KEY (raid_id, user_id)
    )`,
    "CREATE INDEX IF NOT EXISTS wow_attendance_member ON wow_attendance (guild_id, user_id)",
    `CREATE TABLE IF NOT EXISTS wow_loot (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      raid_id INTEGER NOT NULL,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      item TEXT NOT NULL,
      given_by TEXT NOT NULL,
      at INTEGER NOT NULL
    )`,
    "CREATE INDEX IF NOT EXISTS wow_loot_member ON wow_loot (guild_id, user_id, at)",
    `CREATE TABLE IF NOT EXISTS wow_chars (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      cls TEXT NOT NULL DEFAULT '',
      role TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS wow_settings (
      guild_id TEXT PRIMARY KEY,
      timezone TEXT NOT NULL,
      remind_minutes INTEGER NOT NULL DEFAULT 30
    )`,
  ]);
}

function toRaid(r: any): Raid {
  return {
    id: Number(r.id),
    guildId: String(r.guild_id),
    title: String(r.title),
    startsAt: Number(r.starts_at),
    size: Number(r.size),
    slots: { tank: Number(r.tanks), healer: Number(r.healers), dps: Number(r.dps) },
    notes: String(r.notes ?? ""),
    leaderId: String(r.leader_id),
    channelId: r.channel_id ? String(r.channel_id) : null,
    messageId: r.message_id ? String(r.message_id) : null,
    pingRoleId: r.ping_role_id ? String(r.ping_role_id) : null,
    timezone: String(r.timezone),
    status: String(r.status) as RaidStatus,
    reminded: Number(r.reminded) === 1,
    createdAt: Number(r.created_at),
    closedAt: r.closed_at === null || r.closed_at === undefined ? null : Number(r.closed_at),
  };
}

// ── Settings ──

export async function getSettings(guildId: string): Promise<{ timezone: string; remindMinutes: number }> {
  const res = await sqlite.execute("SELECT timezone, remind_minutes FROM wow_settings WHERE guild_id = ?", [guildId]);
  const r: any = res.rows[0];
  return { timezone: r ? String(r.timezone) : DEFAULT_TIMEZONE, remindMinutes: r ? Number(r.remind_minutes) : 30 };
}

export async function setSettings(guildId: string, patch: { timezone?: string; remindMinutes?: number }) {
  const cur = await getSettings(guildId);
  await sqlite.execute(
    "INSERT OR REPLACE INTO wow_settings (guild_id, timezone, remind_minutes) VALUES (?, ?, ?)",
    [guildId, patch.timezone ?? cur.timezone, patch.remindMinutes ?? cur.remindMinutes],
  );
}

// ── Raids ──

export async function createRaid(r: Omit<Raid, "id" | "status" | "reminded" | "createdAt" | "closedAt" | "messageId">): Promise<Raid> {
  const res = await sqlite.execute(
    `INSERT INTO wow_raids (guild_id, title, starts_at, size, tanks, healers, dps, notes, leader_id, channel_id, ping_role_id, timezone, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [r.guildId, r.title, r.startsAt, r.size, r.slots.tank, r.slots.healer, r.slots.dps, r.notes, r.leaderId, r.channelId, r.pingRoleId, r.timezone, Date.now()],
  );
  return (await getRaid(Number(res.lastInsertRowid)))!;
}

export async function getRaid(id: number): Promise<Raid | null> {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const res = await sqlite.execute("SELECT * FROM wow_raids WHERE id = ?", [id]);
  return res.rows[0] ? toRaid(res.rows[0]) : null;
}

/** A server's raid by number, or null when it's another server's. */
export async function getGuildRaid(guildId: string, id: number): Promise<Raid | null> {
  const raid = await getRaid(id);
  return raid && raid.guildId === guildId ? raid : null;
}

export async function updateRaid(id: number, patch: Partial<Pick<Raid, "title" | "startsAt" | "notes" | "size" | "slots" | "status" | "reminded" | "closedAt" | "messageId" | "channelId">>) {
  const cols: string[] = [];
  const args: any[] = [];
  const set = (col: string, v: unknown) => { cols.push(`${col} = ?`); args.push(v); };
  if (patch.title !== undefined) set("title", patch.title);
  if (patch.startsAt !== undefined) set("starts_at", patch.startsAt);
  if (patch.notes !== undefined) set("notes", patch.notes);
  if (patch.size !== undefined) set("size", patch.size);
  if (patch.slots) { set("tanks", patch.slots.tank); set("healers", patch.slots.healer); set("dps", patch.slots.dps); }
  if (patch.status !== undefined) set("status", patch.status);
  if (patch.reminded !== undefined) set("reminded", patch.reminded ? 1 : 0);
  if (patch.closedAt !== undefined) set("closed_at", patch.closedAt);
  if (patch.messageId !== undefined) set("message_id", patch.messageId);
  if (patch.channelId !== undefined) set("channel_id", patch.channelId);
  if (!cols.length) return;
  await sqlite.execute(`UPDATE wow_raids SET ${cols.join(", ")} WHERE id = ?`, [...args, id]);
}

/** Open raids first (soonest first), then the latest finished ones. */
export async function listRaids(guildId: string, opts: { status?: RaidStatus; limit?: number } = {}): Promise<Raid[]> {
  const limit = Math.min(50, opts.limit ?? 10);
  const res = opts.status
    ? await sqlite.execute(
      `SELECT * FROM wow_raids WHERE guild_id = ? AND status = ? ORDER BY ${opts.status === "open" ? "starts_at ASC" : "starts_at DESC"} LIMIT ?`,
      [guildId, opts.status, limit],
    )
    : await sqlite.execute(
      "SELECT * FROM wow_raids WHERE guild_id = ? ORDER BY status = 'open' DESC, CASE WHEN status = 'open' THEN starts_at ELSE -starts_at END LIMIT ?",
      [guildId, limit],
    );
  return res.rows.map(toRaid);
}

/** Open raids (any server) whose reminder is due, or that should be closed out. */
export async function raidsDue(now: number): Promise<Raid[]> {
  const res = await sqlite.execute(
    `SELECT r.* FROM wow_raids r LEFT JOIN wow_settings s ON s.guild_id = r.guild_id
     WHERE r.status = 'open' AND ((r.reminded = 0 AND r.starts_at - COALESCE(s.remind_minutes, 30) * 60000 <= ?) OR r.starts_at + ? <= ?)`,
    [now, FINISH_AFTER_MS, now],
  );
  return res.rows.map(toRaid);
}

/** A raid closes itself out this long after it starts: signups become attendance. */
export const FINISH_AFTER_MS = Math.max(1, Number(Deno.env.get("WOW_FINISH_AFTER_HOURS") ?? "4")) * 3_600_000;

// ── Signups ──

export async function getSignups(raidId: number): Promise<Signup[]> {
  const res = await sqlite.execute("SELECT * FROM wow_signups WHERE raid_id = ? ORDER BY signed_at, rowid", [raidId]);
  return res.rows.map((r: any) => ({
    userId: String(r.user_id),
    display: String(r.display),
    role: r.role ? String(r.role) as Role : null,
    answer: String(r.answer) as Answer,
    signedAt: Number(r.signed_at),
  }));
}

/** Records a click. Changing role or answer moves the member to the back of the queue, so it never bumps someone already in. */
export async function setSignup(raidId: number, s: { userId: string; display: string; role: Role | null; answer: Answer }): Promise<"new" | "changed" | "same"> {
  const res = await sqlite.execute("SELECT role, answer FROM wow_signups WHERE raid_id = ? AND user_id = ?", [raidId, s.userId]);
  const old: any = res.rows[0];
  if (old && String(old.answer) === s.answer && (old.role ?? null) === s.role) {
    await sqlite.execute("UPDATE wow_signups SET display = ? WHERE raid_id = ? AND user_id = ?", [s.display, raidId, s.userId]);
    return "same";
  }
  await sqlite.execute(
    "INSERT OR REPLACE INTO wow_signups (raid_id, user_id, display, role, answer, signed_at) VALUES (?, ?, ?, ?, ?, ?)",
    [raidId, s.userId, s.display, s.role, s.answer, Date.now()],
  );
  return old ? "changed" : "new";
}

export async function removeSignup(raidId: number, userId: string): Promise<boolean> {
  const res = await sqlite.execute("DELETE FROM wow_signups WHERE raid_id = ? AND user_id = ?", [raidId, userId]);
  return res.rowsAffected > 0;
}

// ── Invites ──

export async function recordInvite(raidId: number, userId: string, invitedBy: string, dmOk: boolean) {
  await sqlite.execute(
    "INSERT OR REPLACE INTO wow_invites (raid_id, user_id, invited_by, invited_at, dm_ok) VALUES (?, ?, ?, ?, ?)",
    [raidId, userId, invitedBy, Date.now(), dmOk ? 1 : 0],
  );
}

export async function getInvites(raidId: number): Promise<Array<{ userId: string; invitedBy: string; dmOk: boolean }>> {
  const res = await sqlite.execute("SELECT user_id, invited_by, dm_ok FROM wow_invites WHERE raid_id = ? ORDER BY invited_at", [raidId]);
  return res.rows.map((r: any) => ({ userId: String(r.user_id), invitedBy: String(r.invited_by), dmOk: Number(r.dm_ok) === 1 }));
}

// ── Attendance ──

export async function setAttendance(raid: Raid, rows: Array<{ userId: string; display: string; role: Role | null; status: Attendance }>) {
  if (!rows.length) return;
  await sqlite.batch(rows.map((a) => ({
    sql: "INSERT OR REPLACE INTO wow_attendance (raid_id, guild_id, user_id, display, role, status) VALUES (?, ?, ?, ?, ?, ?)",
    args: [raid.id, raid.guildId, a.userId, a.display, a.role, a.status],
  })));
}

export async function removeAttendance(raidId: number, userId: string): Promise<boolean> {
  const res = await sqlite.execute("DELETE FROM wow_attendance WHERE raid_id = ? AND user_id = ?", [raidId, userId]);
  return res.rowsAffected > 0;
}

export async function getAttendance(raidId: number): Promise<Array<{ userId: string; display: string; role: Role | null; status: Attendance }>> {
  const res = await sqlite.execute("SELECT * FROM wow_attendance WHERE raid_id = ? ORDER BY status, display", [raidId]);
  return res.rows.map((r: any) => ({ userId: String(r.user_id), display: String(r.display), role: r.role ? String(r.role) as Role : null, status: String(r.status) as Attendance }));
}

export interface MemberStats {
  present: number;
  noshow: number;
  signups: number;
  loot: number;
  lastRaid: { id: number; title: string; startsAt: number } | null;
  byRole: Record<Role, number>;
}

export async function memberStats(guildId: string, userId: string): Promise<MemberStats> {
  const [att, sign, loot, last] = await Promise.all([
    sqlite.execute("SELECT status, role, COUNT(*) AS n FROM wow_attendance WHERE guild_id = ? AND user_id = ? GROUP BY status, role", [guildId, userId]),
    sqlite.execute(
      "SELECT COUNT(*) AS n FROM wow_signups s JOIN wow_raids r ON r.id = s.raid_id WHERE r.guild_id = ? AND s.user_id = ? AND s.answer = 'yes' AND r.status != 'cancelled'",
      [guildId, userId],
    ),
    sqlite.execute("SELECT COUNT(*) AS n FROM wow_loot WHERE guild_id = ? AND user_id = ?", [guildId, userId]),
    sqlite.execute(
      "SELECT r.id, r.title, r.starts_at FROM wow_attendance a JOIN wow_raids r ON r.id = a.raid_id WHERE a.guild_id = ? AND a.user_id = ? AND a.status = 'present' ORDER BY r.starts_at DESC LIMIT 1",
      [guildId, userId],
    ),
  ]);
  const out: MemberStats = { present: 0, noshow: 0, signups: Number((sign.rows[0] as any)?.n ?? 0), loot: Number((loot.rows[0] as any)?.n ?? 0), lastRaid: null, byRole: { tank: 0, healer: 0, dps: 0 } };
  for (const r of att.rows as any[]) {
    const n = Number(r.n);
    if (r.status === "present") {
      out.present += n;
      if (r.role && r.role in out.byRole) out.byRole[r.role as Role] += n;
    } else if (r.status === "noshow") out.noshow += n;
  }
  const l: any = last.rows[0];
  if (l) out.lastRaid = { id: Number(l.id), title: String(l.title), startsAt: Number(l.starts_at) };
  return out;
}

/** Most raids attended in this server. */
export async function attendanceBoard(guildId: string, limit = 10): Promise<Array<{ userId: string; display: string; present: number; noshow: number }>> {
  const res = await sqlite.execute(
    `SELECT user_id, MAX(display) AS display,
            SUM(status = 'present') AS present, SUM(status = 'noshow') AS noshow
     FROM wow_attendance WHERE guild_id = ? GROUP BY user_id
     HAVING present > 0 ORDER BY present DESC, noshow ASC LIMIT ?`,
    [guildId, limit],
  );
  return res.rows.map((r: any) => ({ userId: String(r.user_id), display: String(r.display), present: Number(r.present), noshow: Number(r.noshow) }));
}

// ── Loot ──

export async function addLoot(raid: Raid, userId: string, item: string, givenBy: string) {
  await sqlite.execute(
    "INSERT INTO wow_loot (raid_id, guild_id, user_id, item, given_by, at) VALUES (?, ?, ?, ?, ?, ?)",
    [raid.id, raid.guildId, userId, item, givenBy, Date.now()],
  );
}

export async function raidLoot(raidId: number): Promise<Array<{ userId: string; item: string }>> {
  const res = await sqlite.execute("SELECT user_id, item FROM wow_loot WHERE raid_id = ? ORDER BY at", [raidId]);
  return res.rows.map((r: any) => ({ userId: String(r.user_id), item: String(r.item) }));
}

export async function memberLoot(guildId: string, userId: string, limit = 10): Promise<Array<{ item: string; raidId: number; title: string; at: number }>> {
  const res = await sqlite.execute(
    "SELECT l.item, l.raid_id, l.at, r.title FROM wow_loot l JOIN wow_raids r ON r.id = l.raid_id WHERE l.guild_id = ? AND l.user_id = ? ORDER BY l.at DESC LIMIT ?",
    [guildId, userId, limit],
  );
  return res.rows.map((r: any) => ({ item: String(r.item), raidId: Number(r.raid_id), title: String(r.title), at: Number(r.at) }));
}

// ── Characters ──

export async function setChar(guildId: string, userId: string, c: WowChar) {
  await sqlite.execute(
    "INSERT OR REPLACE INTO wow_chars (guild_id, user_id, name, cls, role, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    [guildId, userId, c.name, c.cls, c.role, Date.now()],
  );
}

export async function getChars(guildId: string, userIds: string[]): Promise<Map<string, WowChar>> {
  if (!userIds.length) return new Map();
  const res = await sqlite.execute(
    `SELECT user_id, name, cls, role FROM wow_chars WHERE guild_id = ? AND user_id IN (${userIds.map(() => "?").join(",")})`,
    [guildId, ...userIds],
  );
  return new Map(res.rows.map((r: any) => [String(r.user_id), { name: String(r.name), cls: String(r.cls ?? ""), role: r.role ? String(r.role) as Role : null }]));
}
