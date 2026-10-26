// Discord shim — not copied from the Twitch bot (see sync.ts).
//
// The Twitch bot's twitch.ts posts to Twitch chat through Helix. Here the
// same functions hand their text to scope.ts, which turns it into the slash
// command's reply (or a post in the server's channel when no command is
// being answered). Twitch's 500-character message splitting, reply pages
// and whispers don't apply: Discord replies are split by the Discord layer.

import { deliver } from "./scope.ts";

export const env = (name: string) => {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
};

export async function sendChatMessage(text: string, broadcasterId: string, _names: string[] = [], _opts?: { log?: boolean; keepNames?: boolean }) {
  return await deliver(broadcasterId, { text });
}

export async function sendChatMessages(
  text: string,
  broadcasterId: string,
  opts?: { maxParts?: number; names?: string[]; summary?: string; detail?: string },
): Promise<boolean> {
  return await deliver(broadcasterId, { text, detail: opts?.detail });
}

export async function sendSpellSections(sections: string[], display: string, broadcasterId: string) {
  await deliver(broadcasterId, { text: `@${display} ${sections.join("\n")}` });
}

/** A Discord server is always "live": there is no stream to wait for. */
export async function fetchIsChannelLiveNow(_broadcasterId: string): Promise<boolean> {
  return true;
}

/** A server has no Twitch category or stream title (askme.ts, quotes.ts read them for context). */
export async function getChannelInfo(_broadcasterId: string): Promise<{ gameName: string; title: string } | null> {
  return null;
}

/** Twitch shoutouts (!so) have no Discord counterpart. */
export async function getShoutoutProfile(_login: string): Promise<{
  displayName: string;
  broadcasterType: string;
  bio: string;
  gameName: string;
  title: string;
  live: { viewers: number; startedAt: string } | null;
} | null> {
  return null;
}
