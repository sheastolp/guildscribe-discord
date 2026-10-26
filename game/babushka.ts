// Discord shim — not copied from the Twitch bot (see sync.ts).
// Babushka answers plain chat that @-tags the bot, which this bot never sees.

export function mentionsBot(_message: string): boolean {
  return false;
}

export async function maybeReplyToMention(_chatMessage: string, _chatter: string, _display: string, _broadcasterId: string, _isModerator: boolean): Promise<boolean> {
  return false;
}
