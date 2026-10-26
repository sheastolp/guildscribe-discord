// Discord shim — not copied from the Twitch bot (see sync.ts).
// NPC chatter answers plain chat, which this bot never sees.

export async function isNpcChatterActive(_broadcasterId: string): Promise<boolean> {
  return false;
}

export async function maybeNpcChatter(_chatMessage: string, _display: string, _broadcasterId: string, _active?: boolean): Promise<boolean> {
  return false;
}
