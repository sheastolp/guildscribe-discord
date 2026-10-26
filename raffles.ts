// Raffles: button giveaways for real prizes, the way GiveawayBot runs them.
// (/giveaway is the game's own, paid in gold; this is for anything else:
// Nitro, a game key, a shout-out.)
//
//   /raffle start    (moderators) a prize, how long ("1h", "2d", "30m"), how
//                    many winners, optionally a role entrants must have and
//                    the channel. Posts a card with a 🎉 button.
//   the button       enters you; pressed again, offers to take you out.
//                    The card counts entries.
//   the job          every minute (server.ts): when a raffle's time is up
//                    it draws its winners, turns the card into the result
//                    and announces them with a ping.
//   /raffle end      draws now; /raffle reroll draws again from the
//                    entrants who haven't won; /raffle cancel calls it off;
//                    /raffle list shows what's running.

import { isCommandGroupEnabled } from "./game/db.ts";
import { sqlite } from "./game/sqlite.ts";
import type { LocalCtx } from "./commands.ts";
import { createMessage, editMessage, followUp, json, messageData, ResponseType, type OutMessage } from "./discord.ts";
import { formatDuration, idList, mention, msg, parseDuration, pick } from "./helpers.ts";

export const RAFFLE_GROUP = "raffles";
const PARTY = 0xff73fa;
const ENDED_GREY = 0x2b2d31;
const MAX_DURATION = 30 * 86_400_000;

export interface Raffle {
  id: number;
  guildId: string;
  channelId: string;
  messageId: string | null;
  prize: string;
  description: string;
  winners: number;
  endsAt: number;
  hostId: string;
  requiredRoleId: string | null;
  status: "open" | "ended" | "cancelled";
  winnerIds: string[];
}

export async function ensureRaffleTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS raffles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message_id TEXT,
      prize TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      winners INTEGER NOT NULL,
      ends_at INTEGER NOT NULL,
      host_id TEXT NOT NULL,
      required_role_id TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      winner_ids TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    )`,
  );
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS raffle_entries (
      raffle_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      entered_at INTEGER NOT NULL,
      PRIMARY KEY (raffle_id, user_id)
    )`,
  );
}

function toRaffle(r: any): Raffle {
  return {
    id: Number(r.id),
    guildId: String(r.guild_id),
    channelId: String(r.channel_id),
    messageId: r.message_id ? String(r.message_id) : null,
    prize: String(r.prize),
    description: String(r.description ?? ""),
    winners: Number(r.winners),
    endsAt: Number(r.ends_at),
    hostId: String(r.host_id),
    requiredRoleId: r.required_role_id ? String(r.required_role_id) : null,
    status: String(r.status) as Raffle["status"],
    winnerIds: idList(r.winner_ids),
  };
}

export async function getRaffle(id: number): Promise<Raffle | null> {
  const r = (await sqlite.execute("SELECT * FROM raffles WHERE id = ?", [id])).rows[0];
  return r ? toRaffle(r) : null;
}

async function entries(raffleId: number): Promise<string[]> {
  return (await sqlite.execute("SELECT user_id FROM raffle_entries WHERE raffle_id = ? ORDER BY entered_at", [raffleId])).rows.map((r: any) => String(r.user_id));
}

const postLink = (r: Raffle) => `https://discord.com/channels/${r.guildId}/${r.channelId}/${r.messageId}`;

// ── The card ──

export async function raffleCard(r: Raffle): Promise<OutMessage> {
  const count = (await entries(r.id)).length;
  const t = Math.floor(r.endsAt / 1000);
  if (r.status !== "open") {
    const result = r.status === "cancelled" ? "Cancelled." : r.winnerIds.length ? `Winner${r.winnerIds.length > 1 ? "s" : ""}: ${r.winnerIds.map(mention).join(", ")}` : "Nobody entered, so nobody won.";
    return {
      content: r.status === "cancelled" ? "🚫 **RAFFLE CANCELLED** 🚫" : "🎉 **RAFFLE ENDED** 🎉",
      embeds: [{
        title: r.prize.slice(0, 256),
        description: [r.description, `Ended: <t:${t}:R> (<t:${t}:f>)`, `Hosted by: ${mention(r.hostId)}`, `Entries: **${count}**`, result].filter(Boolean).join("\n"),
        color: ENDED_GREY,
        footer: { text: `Raffle #${r.id}` },
        timestamp: new Date(r.endsAt).toISOString(),
      }],
      components: [],
    };
  }
  return {
    content: "🎉 **RAFFLE** 🎉",
    embeds: [{
      title: r.prize.slice(0, 256),
      description: [
        r.description,
        `Click 🎉 to enter!`,
        `Ends: <t:${t}:R> (<t:${t}:f>)`,
        `Hosted by: ${mention(r.hostId)}`,
        r.requiredRoleId ? `Must have: <@&${r.requiredRoleId}>` : "",
        `Entries: **${count}** · Winners: **${r.winners}**`,
      ].filter(Boolean).join("\n"),
      color: PARTY,
      footer: { text: `Raffle #${r.id}` },
      timestamp: new Date(r.endsAt).toISOString(),
    }],
    components: [{ type: 1, components: [{ type: 2, style: 1, emoji: { name: "🎉" }, label: String(count), custom_id: `raffle:${r.id}:enter` }] }],
  };
}

async function refresh(r: Raffle) {
  if (r.messageId) await editMessage(r.channelId, r.messageId, await raffleCard(r));
}

// ── Drawing ──

/** Ends a raffle: draws `count` winners from those who haven't won yet, updates the card, announces. */
export async function draw(r: Raffle, opts: { reroll?: boolean; count?: number } = {}): Promise<string[]> {
  const pool = (await entries(r.id)).filter((u) => !opts.reroll || !r.winnerIds.includes(u));
  const winners = pick(pool, opts.count ?? r.winners);
  const all = opts.reroll ? [...r.winnerIds, ...winners] : winners;
  const ended: Raffle = { ...r, status: "ended", winnerIds: all, endsAt: opts.reroll ? r.endsAt : Math.min(r.endsAt, Date.now()) };
  await sqlite.execute("UPDATE raffles SET status = 'ended', winner_ids = ?, ends_at = ? WHERE id = ?", [all.join(","), ended.endsAt, r.id]);
  await refresh(ended);
  const link = r.messageId ? ` ${postLink(r)}` : "";
  const content = !winners.length
    ? (opts.reroll ? `😢 Everyone who entered the raffle for **${r.prize}** has already won.` : `😢 Nobody entered the raffle for **${r.prize}**.`)
    : `${opts.reroll ? "🎲 New draw!" : "🎉"} Congratulations ${winners.map(mention).join(", ")}! You won **${r.prize}**!${link}`;
  await createMessage(r.channelId, { content, ping: winners });
  return winners;
}

export async function runRaffleJobs(now = Date.now()) {
  const due = await sqlite.execute("SELECT * FROM raffles WHERE status = 'open' AND ends_at <= ?", [now]);
  for (const row of due.rows) {
    const r = toRaffle(row);
    try {
      await draw(r);
    } catch (e) {
      console.error(`raffle ${r.id} failed to end`, e);
    }
  }
}

// ── The button ──

export async function handleRaffleButton(interaction: any): Promise<Response> {
  const [, rawId, action] = String(interaction.data?.custom_id ?? "").split(":");
  const r = await getRaffle(Number(rawId));
  const ephemeral = (content: string, components?: unknown[]) => json({ type: ResponseType.CHANNEL_MESSAGE, data: messageData({ content, components }, true) });
  if (!r || String(interaction.guild_id) !== r.guildId) return ephemeral("That raffle is gone.");
  if (r.status !== "open") return json({ type: ResponseType.UPDATE_MESSAGE, data: messageData(await raffleCard(r)) });
  const userId = String((interaction.member?.user ?? interaction.user).id);
  const entered = (await entries(r.id)).includes(userId);

  if (action === "leave") {
    if (entered) await sqlite.execute("DELETE FROM raffle_entries WHERE raffle_id = ? AND user_id = ?", [r.id, userId]);
    setTimeout(() => refresh(r).catch((e) => console.error("raffle refresh failed", e)), 300);
    return json({ type: ResponseType.UPDATE_MESSAGE, data: messageData({ content: `You've left the raffle for **${r.prize}**.`, components: [] }) });
  }
  if (entered) {
    return ephemeral(`You've already entered the raffle for **${r.prize}**.`, [{ type: 1, components: [{ type: 2, style: 4, label: "Leave raffle", custom_id: `raffle:${r.id}:leave` }] }]);
  }
  const roles: string[] = (interaction.member?.roles ?? []).map(String);
  if (r.requiredRoleId && !roles.includes(r.requiredRoleId)) return ephemeral(`This raffle is for members with <@&${r.requiredRoleId}>.`);
  await sqlite.execute("INSERT OR IGNORE INTO raffle_entries (raffle_id, user_id, entered_at) VALUES (?, ?, ?)", [r.id, userId, Date.now()]);
  const appId = String(interaction.application_id);
  const token = String(interaction.token);
  setTimeout(() => followUp(appId, token, { content: `🎉 You're in the raffle for **${r.prize}**! Good luck.`, ephemeral: true }).catch(() => {}), 500);
  return json({ type: ResponseType.UPDATE_MESSAGE, data: messageData(await raffleCard(r)) });
}

// ── /raffle ──

export async function raffleChoices(guildId: string, typed: string, sub: string): Promise<Array<{ name: string; value: number }>> {
  const status = sub === "reroll" ? "ended" : "open";
  const res = await sqlite.execute("SELECT * FROM raffles WHERE guild_id = ? AND status = ? ORDER BY id DESC LIMIT 25", [guildId, status]);
  const q = typed.toLowerCase().replace(/^#/, "").trim();
  return res.rows.map(toRaffle)
    .filter((r) => !q || String(r.id).startsWith(q) || r.prize.toLowerCase().includes(q))
    .map((r) => ({ name: `#${r.id} ${r.prize}`.slice(0, 100), value: r.id }));
}

export async function handleRaffleCommand(kind: string, ctx: LocalCtx): Promise<OutMessage> {
  if (!(await isCommandGroupEnabled(ctx.guildId, RAFFLE_GROUP))) {
    return msg("Raffles are switched off in this server. A moderator can turn them on with `/guildscribe feature name:raffles state:on`.");
  }
  const a = ctx.a;
  if (kind === "raffle.list") {
    const res = await sqlite.execute("SELECT * FROM raffles WHERE guild_id = ? AND status = 'open' ORDER BY ends_at", [ctx.guildId]);
    if (!res.rows.length) return msg("🎉 No raffles running. A moderator starts one with `/raffle start`.");
    const lines = await Promise.all(res.rows.map(toRaffle).map(async (r) => `**#${r.id}** ${r.prize} · ${(await entries(r.id)).length} entries · ends <t:${Math.floor(r.endsAt / 1000)}:R> · <#${r.channelId}>`));
    return msg(["🎉 **Raffles running**", ...lines].join("\n"));
  }
  if (!ctx.moderator) return msg("Only moderators (Manage Server or Manage Messages) can run raffles.");

  if (kind === "raffle.start") {
    const ms = parseDuration(a.s("duration"));
    if (!ms) return msg(`"${a.s("duration")}" isn't a length of time. Try \`30m\`, \`2h\`, \`1d12h\` or \`1w\`.`);
    if (ms > MAX_DURATION) return msg("A raffle can run for at most 30 days.");
    const channelId = a.id("channel") || ctx.channelId;
    const roleId = a.id("role") && a.id("role") !== ctx.guildId ? a.id("role") : null;
    const res = await sqlite.execute(
      `INSERT INTO raffles (guild_id, channel_id, prize, description, winners, ends_at, host_id, required_role_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ctx.guildId, channelId, a.s("prize").slice(0, 200), a.s("description").slice(0, 1000), Number(a.s("winners") || 1), Date.now() + ms, ctx.userId, roleId, Date.now()],
    );
    const r = (await getRaffle(Number(res.lastInsertRowid)))!;
    const messageId = await createMessage(channelId, await raffleCard(r));
    if (!messageId) {
      await sqlite.execute("DELETE FROM raffles WHERE id = ?", [r.id]);
      return msg(`Couldn't post in <#${channelId}>. GuildScribe needs View Channel, Send Messages and Embed Links there.`);
    }
    await sqlite.execute("UPDATE raffles SET message_id = ? WHERE id = ?", [messageId, r.id]);
    return msg(`🎉 Raffle **#${r.id}** for **${r.prize}** is up in <#${channelId}>; it ends in ${formatDuration(ms)}.`);
  }

  const r = await getRaffle(Number(a.s("raffle")));
  if (!r || r.guildId !== ctx.guildId) return msg("There's no such raffle here. `/raffle list` shows the running ones.");
  if (kind === "raffle.end") {
    if (r.status !== "open") return msg(`Raffle #${r.id} is already over.`);
    const winners = await draw(r);
    return msg(winners.length ? `🎉 Raffle #${r.id} drawn: ${winners.map(mention).join(", ")}.` : `Raffle #${r.id} is over; nobody entered.`);
  }
  if (kind === "raffle.reroll") {
    if (r.status !== "ended") return msg(`Raffle #${r.id} hasn't ended yet. \`/raffle end\` draws it now.`);
    const winners = await draw(r, { reroll: true, count: Number(a.s("winners") || 1) });
    return msg(winners.length ? `🎲 Rerolled raffle #${r.id}: ${winners.map(mention).join(", ")}.` : `Everyone who entered raffle #${r.id} has already won.`);
  }
  if (kind === "raffle.cancel") {
    if (r.status !== "open") return msg(`Raffle #${r.id} is already over.`);
    await sqlite.execute("UPDATE raffles SET status = 'cancelled', ends_at = ? WHERE id = ?", [Date.now(), r.id]);
    await refresh({ ...r, status: "cancelled", endsAt: Date.now() });
    return msg(`🚫 Raffle #${r.id} for **${r.prize}** is cancelled.`);
  }
  return msg("Unknown /raffle command.");
}
