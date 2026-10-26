// What GuildScribe knows about a server's roles and owner, for working out a
// member's permissions outside a slash command (the Gateway's messages and
// joins carry a member's roles, not their permissions) and for role
// hierarchy (moderation can't act on someone at or above you).
//
// The Gateway fills it when a server comes online (GUILD_CREATE) and drops a
// server's entry when its roles change; anything missing is fetched over
// the API and kept for a few minutes.

import { api } from "./discord.ts";

export const Perm = {
  KICK_MEMBERS: 1n << 1n,
  BAN_MEMBERS: 1n << 2n,
  ADMINISTRATOR: 1n << 3n,
  MANAGE_CHANNELS: 1n << 4n,
  MANAGE_GUILD: 1n << 5n,
  VIEW_AUDIT_LOG: 1n << 7n,
  MANAGE_MESSAGES: 1n << 13n,
  MANAGE_ROLES: 1n << 28n,
  MANAGE_WEBHOOKS: 1n << 29n,
  MODERATE_MEMBERS: 1n << 40n,
} as const;

/** Manage Server, Manage Messages or Administrator: who GuildScribe treats as a moderator. */
export const MODERATOR_PERMS = Perm.ADMINISTRATOR | Perm.MANAGE_GUILD | Perm.MANAGE_MESSAGES;

export interface RoleInfo { id: string; name: string; permissions: bigint; position: number; managed: boolean }
export interface GuildInfo { ownerId: string; name: string; roles: Map<string, RoleInfo>; at: number }

const TTL_MS = 5 * 60_000;
const guilds = new Map<string, GuildInfo>();
/** Members in each server, from GUILD_CREATE and kept up by joins and leaves ({count} in welcome messages). */
const memberCounts = new Map<string, number>();
/** The bot's own user ID (READY), so it never acts on itself. */
export let selfId = Deno.env.get("DISCORD_APPLICATION_ID") ?? "";

export function setSelfId(id: string) {
  selfId = id;
}

function toRoles(list: any[]): Map<string, RoleInfo> {
  return new Map(list.map((r) => [String(r.id), { id: String(r.id), name: String(r.name), permissions: BigInt(r.permissions ?? "0"), position: Number(r.position ?? 0), managed: Boolean(r.managed) }]));
}

/** From a GUILD_CREATE (or a GET /guilds/{id}). */
export function rememberGuild(g: any) {
  guilds.set(String(g.id), { ownerId: String(g.owner_id), name: String(g.name ?? ""), roles: toRoles(g.roles ?? []), at: Date.now() });
  if (g.member_count !== undefined) memberCounts.set(String(g.id), Number(g.member_count));
}

export function forgetGuild(guildId: string) {
  guilds.delete(guildId);
}

export function adjustMemberCount(guildId: string, by: number) {
  const n = memberCounts.get(guildId);
  if (n !== undefined) memberCounts.set(guildId, Math.max(0, n + by));
}

export const memberCount = (guildId: string): number | null => memberCounts.get(guildId) ?? null;

export async function guildInfo(guildId: string): Promise<GuildInfo | null> {
  const hit = guilds.get(guildId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;
  const g = await api("GET", `/guilds/${guildId}?with_counts=true`);
  if (!g?.id) return hit ?? null;
  rememberGuild({ ...g, member_count: g.approximate_member_count ?? memberCounts.get(guildId) });
  return guilds.get(guildId)!;
}

/** A member's server-wide permissions from their roles (channel overrides aside). */
export async function permissionsOf(guildId: string, userId: string, roleIds: string[]): Promise<bigint> {
  const g = await guildInfo(guildId);
  if (!g) return 0n;
  if (g.ownerId === userId) return ~0n;
  let p = g.roles.get(guildId)?.permissions ?? 0n; // @everyone's role has the server's ID
  for (const id of roleIds) p |= g.roles.get(id)?.permissions ?? 0n;
  return (p & Perm.ADMINISTRATOR) ? ~0n : p;
}

export async function isModeratorMember(guildId: string, userId: string, roleIds: string[]): Promise<boolean> {
  return ((await permissionsOf(guildId, userId, roleIds)) & MODERATOR_PERMS) !== 0n;
}

/** The highest role position among `roleIds` (0 for none); the owner outranks everyone. */
export async function topPosition(guildId: string, userId: string, roleIds: string[]): Promise<number> {
  const g = await guildInfo(guildId);
  if (!g) return 0;
  if (g.ownerId === userId) return Number.MAX_SAFE_INTEGER;
  return Math.max(0, ...roleIds.map((id) => g.roles.get(id)?.position ?? 0));
}
