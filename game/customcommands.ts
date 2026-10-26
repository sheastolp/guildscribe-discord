// Discord shim — not copied from the Twitch bot (see sync.ts).
// Custom chat commands and keyword triggers are Twitch chat features.

export async function handleCustomCommandInvocation(_chatMessage: string, _display: string, _broadcasterId: string): Promise<boolean> {
  return false;
}

export async function handleTriggerMatch(_chatMessage: string, _display: string, _broadcasterId: string, _prefetched?: unknown): Promise<boolean> {
  return false;
}
