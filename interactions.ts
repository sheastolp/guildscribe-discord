// The Interactions endpoint: every slash command lands here.
//
// A command is answered at once with a deferred response ("GuildScribe is
// thinking…"), then run through the game (router.ts) inside an interaction
// scope (game/scope.ts) that collects everything the game says. That
// becomes the reply: one message when it fits in 2,000 characters, a few
// follow-ups when it doesn't, and a fight's uncut battle log as a file.

import { type Args, resolveInvocation } from "./commands.ts";
import { InteractionType, ResponseType, EPHEMERAL, editOriginal, followUp, guildName, json, postToChannel, sendDm, splitMessage, verifyInteraction, type OutMessage } from "./discord.ts";
import { displayName, loginFor, rememberMember, toDiscordText, toPlainText } from "./identity.ts";
import { announceChannel, ensureGuild, featureStatus, isSwitchName, setAnnounceChannel, setFeature, switchChoices } from "./guild.ts";
import { handleWowButton, handleWowCommand, raidChoices } from "./wow.ts";
import { runGameCommand } from "./router.ts";
import { runInteraction, setSenders, type Reply } from "./game/scope.ts";
import { PUBLIC_BASE_URL } from "./game/config.ts";

// Discord permission bits on interaction.member.permissions.
const ADMINISTRATOR = 1n << 3n;
const MANAGE_GUILD = 1n << 5n;
const MANAGE_MESSAGES = 1n << 13n;

function isModerator(permissions: string | undefined): boolean {
  try {
    return permissions ? (BigInt(permissions) & (ADMINISTRATOR | MANAGE_GUILD | MANAGE_MESSAGES)) !== 0n : false;
  } catch {
    return false;
  }
}

const MAX_MESSAGES = 4;
const TWITCH_INVITE_URL = Deno.env.get("TWITCH_BOT_INVITE_URL") ?? "https://guildscribe.tavernworks.dev/connect";

// ── Turning what the game said into Discord messages ──

async function toMessages(guildId: string, replies: Reply[], ping: string[] = []): Promise<OutMessage[]> {
  const texts = await Promise.all(replies.map((r) => toDiscordText(guildId, r.text, { base: PUBLIC_BASE_URL })));
  const content = texts.join("\n").trim();
  const files: OutMessage["files"] = [];
  const logs = replies.filter((r) => r.detail && r.detail.trim() !== r.text.trim());
  if (logs.length) {
    const plain = await Promise.all(logs.map((r) => toDiscordText(guildId, r.detail!, { mentions: false })));
    files.push({ name: "battle-log.txt", content: plain.join("\n\n") });
  }
  let chunks = splitMessage(content || "…");
  if (chunks.length > MAX_MESSAGES) {
    const plain = await Promise.all(replies.map((r) => toDiscordText(guildId, r.text, { mentions: false })));
    files.push({ name: "reply.txt", content: plain.join("\n") });
    chunks = [...chunks.slice(0, MAX_MESSAGES - 1), "…the rest is in reply.txt."];
  }
  return chunks.map((c, i) => ({ content: c, ping, ...(i === chunks.length - 1 && files.length ? { files } : {}) }));
}

/** Posts made with no command to answer: merchant ads, autohunt reports, raid news. */
setSenders({
  channel: async (guildId, reply) => {
    const { channelId } = await announceChannel(guildId);
    if (!channelId) return false;
    // Ping the first member the post is addressed to (an autohunt report's hunter).
    const first = (await toDiscordText(guildId, reply.text)).match(/<@(\d+)>/)?.[1];
    let ok = true;
    for (const m of await toMessages(guildId, [reply], first ? [first] : [])) ok = (await postToChannel(channelId, m)) && ok;
    return ok;
  },
  dm: async (userId, text) => await sendDm(userId, { content: (await toPlainText(text)).slice(0, 2000) }),
});

// ── Local commands (answered here, not by the game) ──

function helpText(): string {
  const lines = [
    "📜 **GuildScribe** — the D&D guild hall, now on Discord. Start with `/createchar` (or `/newchar` step by step), check it with `/char`, then `/roll`, `/hunt`, `/duel monster` or `/party create`. New here? `/start`.",
    "",
    "**Parchment** `/createchar` `/newchar` `/bg3` `/answer` `/char` `/abilities` `/wildshape` `/levelup` `/hp` `/savechar` `/loadchar` `/resetchar` `/gear` `/shmash` `/hug`",
    "**Fate's dice** `/roll` `/d20` `/fate` `/save` `/saves` `/rollcall` `/oracle`",
    "**Archives** `/spell` `/item` `/class` `/feat` `/ability` `/race` `/subrace` `/rule` `/monster` `/bg3lookup` `/bg3roll` `/bg3companion` `/bg3origin` `/bg3loot` `/bg3camp` `/div2`",
    "**Arena & wilds** `/party` `/duel` `/turn` `/rob` `/bestiary` `/autohunt` `/huntcooldown` `/rally`",
    "**Hunt and Hoard** `/hoard` `/hunt` `/ledger` `/bounties` `/shop` `/buy` `/inv` `/sell` `/drop` `/purse`",
    "**Gold** `/gold` `/giveaway` `/bribe` `/gamble` · **Market** `/market` `/haggle` `/stall`",
    "**Tavern talk** `/fun` `/askme` `/quote` · any chat command from the Twitch bot: `/gs`",
    "**World of Warcraft: Forever** `/wow forever` · raids: `/wow raid create` `invite` `list` · `/wow character` `/wow stats` `/wow top`",
    "**Stewards** `/guildscribe status` · `/guildscribe feature` · `/guildscribe channel` · `/twitchinvite`",
  ];
  return lines.join("\n");
}

async function runLocal(kind: string, ctx: { guildId: string; moderator: boolean; a: Args }): Promise<OutMessage> {
  if (kind === "help") return { content: helpText() };
  if (kind === "twitchinvite") {
    return { content: `🏰 Bring GuildScribe to your Twitch channel: ${TWITCH_INVITE_URL}\nAfter you authorize it, type \`/mod GuildScribeBot\` in your Twitch chat so it can post.` };
  }
  if (kind === "settings.status") {
    const features = await featureStatus(ctx.guildId);
    const { channelId, chosen } = await announceChannel(ctx.guildId);
    const where = channelId ? `<#${channelId}>${chosen ? "" : " (where commands were last used — pick one with `/guildscribe channel`)"}` : "nowhere yet";
    return {
      content: [
        "⚙️ **GuildScribe in this server**",
        ...features.map((f) => `${f.on ? "🟢" : "⚫"} **${f.name}** — ${f.label}`),
        `📣 Posts on its own (merchant, raids, autohunt) in: ${where}`,
        "Moderators: `/guildscribe feature` switches a feature, `/market on` lets the merchant post.",
      ].join("\n"),
    };
  }
  if (!ctx.moderator) return { content: "Only moderators (Manage Server or Manage Messages) can change GuildScribe's settings." };
  if (kind === "settings.feature") {
    const name = ctx.a.s("name");
    const on = ctx.a.s("state") === "on";
    if (!isSwitchName(name)) return { content: `Unknown feature ${name}. \`/guildscribe status\` lists them.` };
    await setFeature(ctx.guildId, name, on);
    return { content: `${on ? "🟢" : "⚫"} **${name}** is now ${on ? "on" : "off"} in this server.` };
  }
  if (kind === "settings.channel") {
    const channelId = ctx.a.s("channel") || null;
    await setAnnounceChannel(ctx.guildId, channelId);
    return { content: channelId ? `📣 GuildScribe will post merchant, raid and autohunt news in <#${channelId}>.` : "📣 GuildScribe will post its news wherever commands were last used." };
  }
  return { content: "Unknown setting." };
}

// ── The endpoint ──

function argsFrom(options: any[]): Args {
  const get = (name: string) => options.find((o) => o.name === name)?.value;
  return {
    s: (name) => {
      const v = get(name);
      return v === undefined || v === null ? "" : String(v).replace(/\s+/g, " ").trim();
    },
    u: (name) => {
      const id = get(name);
      return id ? `@${loginFor(String(id))}` : "";
    },
    b: (name) => get(name) === true,
    id: (name) => {
      const v = get(name);
      return v === undefined || v === null ? "" : String(v);
    },
  };
}

async function handleCommand(interaction: any) {
  const appId = String(interaction.application_id);
  const token = String(interaction.token);
  const guildId = String(interaction.guild_id);
  const user = interaction.member?.user ?? interaction.user;
  const userId = String(user.id);
  const display = displayName(interaction.member, user);
  const login = loginFor(userId);
  const moderator = isModerator(interaction.member?.permissions);
  const found = resolveInvocation(interaction.data);
  if (!found) return void await editOriginal(appId, token, { content: "This command has changed — Discord may still be updating its list. Try again in a minute." });
  const { leaf, options } = found;
  const a = argsFrom(options);

  await ensureGuild(guildId, interaction.channel_id ? String(interaction.channel_id) : undefined, () => guildName(guildId));
  await rememberMember(guildId, { userId, login, display });
  for (const [id, u] of Object.entries<any>(interaction.data.resolved?.users ?? {})) {
    await rememberMember(guildId, { userId: id, login: loginFor(id), display: displayName(interaction.data.resolved?.members?.[id], u) });
  }

  if (leaf.local) {
    const m = leaf.local.startsWith("wow.")
      ? await handleWowCommand(leaf.local, { guildId, channelId: String(interaction.channel_id ?? ""), userId, display, moderator, a })
      : await runLocal(leaf.local, { guildId, moderator, a });
    await editOriginal(appId, token, m);
    return;
  }

  const text = leaf.twitch!(a).replace(/\s+/g, " ").trim();
  const { replies } = await runInteraction({ guildId, userId, login, display }, () =>
    runGameCommand({ guildId, login, display, isModerator: moderator, text }));
  const messages = replies.length
    ? await toMessages(guildId, replies)
    : [{ content: "Nothing happened — that may be switched off in this server (`/guildscribe status`)." }];
  await editOriginal(appId, token, messages[0]);
  for (const m of messages.slice(1)) await followUp(appId, token, m);
}

/** Suggestions while a member types: raid numbers (/wow raid …) and switch names (/guildscribe feature). */
async function autocomplete(interaction: any): Promise<Array<{ name: string; value: string | number }>> {
  if (!interaction.guild_id) return [];
  const found = resolveInvocation(interaction.data);
  const focused = found?.options.find((o: any) => o.focused);
  if (!found || !focused) return [];
  const typed = String(focused.value ?? "");
  try {
    if (found.command.name === "wow" && focused.name === "raid") return await raidChoices(String(interaction.guild_id), typed, found.leaf.name);
    if (found.command.name === "guildscribe" && focused.name === "name") return switchChoices(typed).map((n) => ({ name: n, value: n }));
  } catch (e) {
    console.error("autocomplete failed", e);
  }
  return [];
}

export async function handleInteraction(req: Request): Promise<Response> {
  const body = await req.text();
  if (!(await verifyInteraction(body, req.headers.get("X-Signature-Ed25519"), req.headers.get("X-Signature-Timestamp")))) {
    return new Response("invalid request signature", { status: 401 });
  }
  const interaction = JSON.parse(body);
  if (interaction.type === InteractionType.PING) return json({ type: ResponseType.PONG });
  // Raid signup buttons work in the server and in invite DMs (wow.ts).
  if (interaction.type === InteractionType.MESSAGE_COMPONENT && String(interaction.data?.custom_id ?? "").startsWith("wow:")) {
    return await handleWowButton(interaction);
  }
  if (interaction.type === InteractionType.AUTOCOMPLETE) return json({ type: ResponseType.AUTOCOMPLETE_RESULT, data: { choices: await autocomplete(interaction) } });
  if (interaction.type !== InteractionType.APPLICATION_COMMAND) return json({ type: ResponseType.CHANNEL_MESSAGE, data: { content: "That button has expired.", flags: EPHEMERAL } });
  if (!interaction.guild_id) {
    return json({ type: ResponseType.CHANNEL_MESSAGE, data: { content: "GuildScribe plays in servers — use its commands in a server it's in.", flags: EPHEMERAL } });
  }
  // Answer within Discord's 3 seconds; the real reply follows.
  handleCommand(interaction).catch(async (e) => {
    console.error("interaction failed", e);
    await editOriginal(String(interaction.application_id), String(interaction.token), { content: "Something went wrong handling that command." }).catch(() => {});
  });
  return json({ type: ResponseType.DEFERRED_CHANNEL_MESSAGE });
}

