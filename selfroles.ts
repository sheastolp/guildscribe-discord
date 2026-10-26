// Self-assign roles: a post with a button per role that members press to
// take the role or give it back (Sapphire's reaction roles, as buttons).
//
//   /roles panel    (moderators) posts a panel: a title, a description and up
//                   to 10 roles. mode "single" lets members hold one role of
//                   the panel at a time (a colour, a region, a pronoun
//                   set); "toggle" (default) lets them take any.
//   /roles list     the panels in this server
//   /roles delete   removes a panel and its post
//
// Roles that carry moderator powers (Administrator, Manage Server/Roles/
// Channels/Messages, Ban, Kick) can't go on a panel. GuildScribe needs
// Manage Roles, with its role above the panel's roles.

import { isCommandGroupEnabled } from "./game/db.ts";
import { sqlite } from "./game/sqlite.ts";
import type { LocalCtx } from "./commands.ts";
import { addRole, createMessage, deleteMessage, editOriginal, EPHEMERAL, json, removeRole, ResponseType, type OutMessage } from "./discord.ts";
import { guildInfo, Perm } from "./guildcache.ts";
import { idList, msg } from "./helpers.ts";

export const ROLES_GROUP = "selfroles";
const DANGEROUS = Perm.ADMINISTRATOR | Perm.MANAGE_GUILD | Perm.MANAGE_ROLES | Perm.MANAGE_CHANNELS | Perm.MANAGE_MESSAGES | Perm.BAN_MEMBERS | Perm.KICK_MEMBERS | Perm.MODERATE_MEMBERS | Perm.MANAGE_WEBHOOKS;
const PANEL_COLOR = 0x5865f2;

export interface Panel { id: number; guildId: string; channelId: string; messageId: string | null; title: string; mode: "toggle" | "single"; roleIds: string[] }

export async function ensureSelfRoleTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS role_panels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message_id TEXT,
      title TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'toggle',
      role_ids TEXT NOT NULL
    )`,
  );
}

function toPanel(r: any): Panel {
  return { id: Number(r.id), guildId: String(r.guild_id), channelId: String(r.channel_id), messageId: r.message_id ? String(r.message_id) : null, title: String(r.title), mode: r.mode === "single" ? "single" : "toggle", roleIds: idList(r.role_ids) };
}

export async function getPanel(id: number): Promise<Panel | null> {
  const r = (await sqlite.execute("SELECT * FROM role_panels WHERE id = ?", [id])).rows[0];
  return r ? toPanel(r) : null;
}

/** The panel post: buttons in rows of five, labelled with the roles' names. */
export function panelMessage(p: Panel, description: string, names: Map<string, string>): OutMessage {
  const buttons = p.roleIds.map((id) => ({ type: 2, style: 2, label: (names.get(id) ?? "role").slice(0, 80), custom_id: `roles:${p.id}:${id}` }));
  const rows: unknown[] = [];
  for (let i = 0; i < buttons.length; i += 5) rows.push({ type: 1, components: buttons.slice(i, i + 5) });
  return {
    content: "",
    embeds: [{ title: p.title.slice(0, 256), description: [description, p.mode === "single" ? "*Pick one; picking another swaps it.*" : "*Press a button to take the role; press it again to give it back.*"].filter(Boolean).join("\n\n"), color: PANEL_COLOR }],
    components: rows,
  };
}

// ── The buttons ──

export async function handleRolesButton(interaction: any): Promise<Response> {
  const [, rawPanel, roleId] = String(interaction.data?.custom_id ?? "").split(":");
  const ephemeral = (content: string) => json({ type: ResponseType.CHANNEL_MESSAGE, data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } } });
  const p = await getPanel(Number(rawPanel));
  if (!p || String(interaction.guild_id) !== p.guildId || !p.roleIds.includes(roleId)) return ephemeral("That panel has changed. Ask a moderator for a new one.");
  if (!(await isCommandGroupEnabled(p.guildId, ROLES_GROUP))) return ephemeral("Self-assign roles are switched off in this server.");
  const userId = String(interaction.member.user.id);
  const has: string[] = (interaction.member.roles ?? []).map(String);
  const appId = String(interaction.application_id);
  const token = String(interaction.token);
  // The role changes can take longer than Discord's 3 seconds: answer "thinking…" (only they see it) first.
  setTimeout(async () => {
    let content: string;
    if (has.includes(roleId)) {
      content = (await removeRole(p.guildId, userId, roleId, "Self-assign roles")) ? `➖ Took away <@&${roleId}>.` : "Couldn't change your roles: GuildScribe needs Manage Roles, with its role above that one.";
    } else {
      const swapped = p.mode === "single" ? p.roleIds.filter((r) => r !== roleId && has.includes(r)) : [];
      for (const r of swapped) await removeRole(p.guildId, userId, r, "Self-assign roles (swap)");
      content = (await addRole(p.guildId, userId, roleId, "Self-assign roles"))
        ? `➕ You now have <@&${roleId}>.${swapped.length ? ` (Swapped from ${swapped.map((r) => `<@&${r}>`).join(", ")}.)` : ""}`
        : "Couldn't change your roles: GuildScribe needs Manage Roles, with its role above that one.";
    }
    await editOriginal(appId, token, { content });
  }, 500); // after Discord has the "thinking…" response, or there's nothing to edit yet
  return json({ type: ResponseType.DEFERRED_CHANNEL_MESSAGE, data: { flags: EPHEMERAL } });
}

// ── /roles ──

export async function handleRolesCommand(kind: string, ctx: LocalCtx): Promise<OutMessage> {
  if (!(await isCommandGroupEnabled(ctx.guildId, ROLES_GROUP))) {
    return msg("Self-assign roles are switched off in this server. A moderator can turn them on with `/guildscribe feature name:selfroles state:on`.");
  }
  if (!ctx.moderator) return msg("Only moderators (Manage Server or Manage Messages) can manage role panels.");
  const a = ctx.a;
  if (kind === "roles.list") {
    const res = await sqlite.execute("SELECT * FROM role_panels WHERE guild_id = ? ORDER BY id", [ctx.guildId]);
    if (!res.rows.length) return msg("🎭 No role panels yet. `/roles panel` posts one.");
    return msg(["🎭 **Role panels**", ...res.rows.map(toPanel).map((p) => `**#${p.id}** ${p.title} · <#${p.channelId}> · ${p.mode} · ${p.roleIds.map((r) => `<@&${r}>`).join(" ")}`)].join("\n"));
  }
  if (kind === "roles.delete") {
    const p = await getPanel(Number(a.s("panel")));
    if (!p || p.guildId !== ctx.guildId) return msg("There's no such panel here. `/roles list` shows them.");
    if (p.messageId) await deleteMessage(p.channelId, p.messageId, "Role panel removed");
    await sqlite.execute("DELETE FROM role_panels WHERE id = ?", [p.id]);
    return msg(`🎭 Panel #${p.id} is gone.`);
  }
  if (kind === "roles.panel") {
    const roleIds = [...new Set(Array.from({ length: 10 }, (_, i) => a.id(`role${i + 1}`)).filter((r) => r && r !== ctx.guildId))];
    if (!roleIds.length) return msg("Pick at least one role.");
    const g = await guildInfo(ctx.guildId);
    const risky = roleIds.filter((r) => ((g?.roles.get(r)?.permissions ?? 0n) & DANGEROUS) !== 0n);
    if (risky.length) return msg(`${risky.map((r) => `<@&${r}>`).join(", ")} can moderate or manage the server, so it can't be handed out by a button.`);
    const managed = roleIds.filter((r) => g?.roles.get(r)?.managed);
    if (managed.length) return msg(`${managed.map((r) => `<@&${r}>`).join(", ")} belongs to a bot or integration; Discord won't let anyone hand it out.`);
    const channelId = a.id("channel") || ctx.channelId;
    const mode = a.s("mode") === "single" ? "single" : "toggle";
    const title = a.s("title") || "Pick your roles";
    const res = await sqlite.execute("INSERT INTO role_panels (guild_id, channel_id, title, mode, role_ids) VALUES (?, ?, ?, ?, ?)", [ctx.guildId, channelId, title, mode, roleIds.join(",")]);
    const p = (await getPanel(Number(res.lastInsertRowid)))!;
    const names = new Map(roleIds.map((r) => [r, g?.roles.get(r)?.name ?? "role"]));
    const messageId = await createMessage(channelId, panelMessage(p, a.s("description").replace(/\\n/g, "\n"), names));
    if (!messageId) {
      await sqlite.execute("DELETE FROM role_panels WHERE id = ?", [p.id]);
      return msg(`Couldn't post in <#${channelId}>. GuildScribe needs View Channel, Send Messages and Embed Links there.`);
    }
    await sqlite.execute("UPDATE role_panels SET message_id = ? WHERE id = ?", [messageId, p.id]);
    return msg(`🎭 Panel #${p.id} is up in <#${channelId}> with ${roleIds.map((r) => `<@&${r}>`).join(" ")}. GuildScribe needs Manage Roles, with its role above these.`);
  }
  return msg("Unknown /roles command.");
}
