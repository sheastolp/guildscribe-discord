// Discord shim — not copied from the Twitch bot (see sync.ts).
// The chronicle quotes plain chat back, which this bot never sees.

export async function maybeChronicleQuote(_chatMessage: string, _display: string, _broadcasterId: string, _enabled?: boolean): Promise<boolean> {
  return false;
}
