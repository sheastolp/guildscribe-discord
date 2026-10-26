// Discord shim — not copied from the Twitch bot (see sync.ts).
//
// On Twitch, long replies become a summary plus a whisper. On Discord a
// "whisper" is a DM from the bot (autohunt reports use it), and the person
// a reply answers is the member who ran the slash command (scope.ts).

import { currentInteraction, deliverDirect } from "./scope.ts";

export const LONG_REPLY_PARTS = 2;
// Discord's message limit, so a whispered report is one DM.
export const WHISPER_MAX = 2000;

export interface ReplyInitiator { userId: string; login: string; display: string; broadcasterId: string }

export function getReplyInitiator(): ReplyInitiator | undefined {
  const s = currentInteraction();
  return s ? { userId: s.userId, login: s.login, display: s.display, broadcasterId: s.guildId } : undefined;
}

/** Bookkeeping the reply doesn't depend on; awaited before the interaction finishes. */
export function defer(work: Promise<unknown>) {
  const guarded = work.catch((e) => console.error("deferred work failed", e));
  currentInteraction()?.deferred.push(guarded);
}

/** DMs the member every part as one message; false when Discord refuses (DMs closed). */
export async function sendWhisperParts(toUserId: string, parts: string[]): Promise<boolean> {
  return await deliverDirect(toUserId, parts.join("\n"));
}

/** Chat summary for a long fight: who fought whom, how it ended, and
 * the loot won ("none" when there was none, e.g. PvP or a loss). */
export function fightSummary(f: { fighter: string; enemy: string; outcome: string; loot?: string; hp?: string }): string {
  return `⚔️ ${f.fighter} vs ${f.enemy} — ${f.outcome}${f.hp ? ` ❤️ HP left: ${f.hp}.` : ""} 🪙 Loot: ${f.loot || "none"}.`;
}

/** "Bob 20/28, Goblin 0/20" for a fight summary's HP-left note. */
export function hpLeft(entries: Array<[string, number, number]>): string {
  return entries.map(([name, hp, max]) => `${name} ${Math.max(0, hp)}/${max}`).join(", ");
}
