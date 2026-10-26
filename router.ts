// Runs one game command through the Twitch bot's handlers.
//
// Mirrors the command half of the Twitch bot's main.ts (handleNotification):
// the same dashboard-switch check, per-member cooldown and activity log, then
// the same handlers in the same order, ending with chat_builtin.ts. Only the
// game handlers are here; Twitch moderation, overlays, custom commands and
// the like aren't part of this bot.
//
// Gold: on Twitch, viewers earn copper for chatting while live. This bot
// never sees plain chat, so a member earns it for using a command instead,
// at the same rate and cooldown (POINTS_PER_MESSAGE, POINTS_EARN_COOLDOWN_SECONDS).

import { checkCommandRateLimit, isCommandGroupEnabled, recordActivity } from "./game/db.ts";
import { groupForMessage } from "./game/commandgroups.ts";
import { defer } from "./game/whisper.ts";
import { sendChatMessage } from "./game/twitch.ts";
import { PUBLIC_BASE_URL } from "./game/config.ts";
import { handleCreationCommand } from "./game/characters.ts";
import { handleBg3Command } from "./game/bg3.ts";
import { handleDuelCommand, handleInitiativeCommand, handleMonsterDuelCommand, handlePartyCommand, handlePartyDuelCommand } from "./game/combat.ts";
import { handlePeddlerAssault } from "./game/peddler_guard.ts";
import { handleMerchantCommand } from "./game/merchant.ts";
import { handleHaggleCommand } from "./game/haggle.ts";
import { handlePointsCommand, maybeAwardChatPoints } from "./game/points.ts";
import { handleRobCommand } from "./game/rob.ts";
import { handleBribeCommand } from "./game/bribe.ts";
import { handleGambleCommand } from "./game/gamble.ts";
import { handleAbilitiesCommand } from "./game/abilities_cmd.ts";
import { handleWildShapeCommand } from "./game/wildshape.ts";
import { handleAutohuntCommand } from "./game/autohunt.ts";
import { handleHoardCommand } from "./game/hoard.ts";
import { getChannelRoster, handleBestiaryCommand } from "./game/bestiary.ts";
import { handleHuntCooldownCommand } from "./game/huntcooldown.ts";
import { handleRaidCommand, maybeLaunchRaidSafe } from "./game/raid.ts";
import { handleOracleCommand } from "./game/oracle.ts";
import { handleBuiltinChatCommand } from "./game/chat_builtin.ts";
import { featureForGroup } from "./guild.ts";

const COMMAND_COOLDOWN_MS = Math.max(250, Number(Deno.env.get("COMMAND_COOLDOWN_MS") ?? "1200"));

export interface GameContext {
  guildId: string;
  login: string;
  display: string;
  isModerator: boolean;
  /** The Twitch chat line, e.g. "!dndduel party hunt crew goblin". */
  text: string;
}

export async function runGameCommand(ctx: GameContext): Promise<void> {
  const { guildId: broadcasterId, login: chatter, display, isModerator } = ctx;
  const chatMessage = ctx.text.replace(/\s+/g, " ").trim();

  defer(maybeLaunchRaidSafe(broadcasterId)); // due raid musters launch on any command

  const group = groupForMessage(chatMessage, /^!dndduel\s/i.test(chatMessage) ? await getChannelRoster(broadcasterId) : undefined);
  const [allowed, groupOn] = await Promise.all([
    isModerator ? true : checkCommandRateLimit(broadcasterId, chatter, COMMAND_COOLDOWN_MS),
    group ? isCommandGroupEnabled(broadcasterId, group) : true,
  ]);
  if (!allowed) {
    await sendChatMessage(`@${display} easy there — one command at a time.`, broadcasterId);
    return;
  }
  const commandWord = chatMessage.split(/\s+/)[0].toLowerCase();
  defer(recordActivity(chatter, broadcasterId, commandWord, chatMessage));
  if (!groupOn) {
    const feature = group ? featureForGroup(group) : null;
    await sendChatMessage(
      `@${display} that's switched off in this server.${feature ? ` A moderator can turn it on with /guildscribe feature name:${feature} state:on.` : ""}`,
      broadcasterId,
    );
    return;
  }
  defer((async () => {
    if (await isCommandGroupEnabled(broadcasterId, "chatgold")) await maybeAwardChatPoints(chatMessage, chatter, display, broadcasterId);
  })());

  // Same order as the Twitch bot's main.ts.
  if (await handleCreationCommand(chatter, display, broadcasterId, chatMessage)) return;
  if (await handleBg3Command(chatter, display, broadcasterId, chatMessage, PUBLIC_BASE_URL)) return;
  if (await handleInitiativeCommand(chatMessage, broadcasterId, display, isModerator, chatter)) return;
  if (await handlePartyCommand(chatMessage, chatter, display, broadcasterId)) return;
  if (await handlePartyDuelCommand(chatMessage, chatter, display, broadcasterId)) return;
  if (await handlePeddlerAssault(chatMessage, display, broadcasterId)) return;
  if (await handleMonsterDuelCommand(chatMessage, chatter, display, broadcasterId)) return;
  if (await handleDuelCommand(chatMessage, chatter, display, broadcasterId)) return;
  if (await handleMerchantCommand(chatMessage, display, broadcasterId, isModerator)) return;
  if (await handleHaggleCommand(chatMessage, chatter, display, broadcasterId)) return;
  if (await handlePointsCommand(chatMessage, chatter, display, broadcasterId, isModerator)) return;
  if (await handleRobCommand(chatMessage, chatter, display, broadcasterId)) return;
  if (await handleBribeCommand(chatMessage, chatter, display, broadcasterId)) return;
  if (await handleGambleCommand(chatMessage, chatter, display, broadcasterId)) return;
  if (await handleAbilitiesCommand(chatMessage, chatter, display, broadcasterId)) return;
  if (await handleWildShapeCommand(chatMessage, chatter, display, broadcasterId)) return;
  if (await handleAutohuntCommand(chatMessage, chatter, display, broadcasterId)) return;
  if (await handleHoardCommand(chatMessage, chatter, display, broadcasterId)) return;
  if (await handleBestiaryCommand(chatMessage, chatter, display, broadcasterId, isModerator, PUBLIC_BASE_URL)) return;
  if (await handleHuntCooldownCommand(chatMessage, chatter, display, broadcasterId, isModerator)) return;
  if (await handleRaidCommand(chatMessage, chatter, display, broadcasterId, isModerator)) return;
  if (await handleOracleCommand(chatMessage, chatter, display, broadcasterId)) return;
  await handleBuiltinChatCommand({ chatMessage, chatter, display, broadcasterId, isModerator, baseUrl: PUBLIC_BASE_URL });
}
