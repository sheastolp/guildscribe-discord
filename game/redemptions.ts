// Discord shim — not copied from the Twitch bot (see sync.ts).
// Channel-point rewards are Twitch-only, so nobody ever has a robbery shield.

export async function robShieldRemainingMs(_broadcasterId: string, _target: string): Promise<number> {
  return 0;
}
