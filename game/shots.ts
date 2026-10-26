// Discord shim — not copied from the Twitch bot (see sync.ts).
// The shot counter is a Twitch overlay feature; its word option is never set here.

export function shotWordProblem(_word: string): string | null {
  return null;
}
