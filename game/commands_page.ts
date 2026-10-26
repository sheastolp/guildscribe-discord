// Discord shim — not copied from the Twitch bot (see sync.ts).
// There's no per-channel commands page; /help lists the slash commands.

export function channelCommandsUrl(baseUrl: string, _broadcasterId: string): string {
  return `${baseUrl}/`;
}
