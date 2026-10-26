// Discord shim — not copied from the Twitch bot (see sync.ts).
// The Endless Delve is an OBS overlay game played through Twitch chat.

export type DelveOptions = { bossSeconds: number; killsPerFloor: number; bigWord: string; bigCooldown: number; buffWord: string; buffCooldown: number };

const DEFAULT_DELVE: DelveOptions = { bossSeconds: 30, killsPerFloor: 5, bigWord: "fireball", bigCooldown: 60, buffWord: "bless", buffCooldown: 90 };

export async function getDelveOptions(_channelId: string): Promise<DelveOptions> {
  return DEFAULT_DELVE;
}

export function delveHelpText(display: string, _o: DelveOptions = DEFAULT_DELVE): string {
  return `@${display} 🕯️ The Endless Delve is played in Twitch chat on stream, not on Discord.`;
}
