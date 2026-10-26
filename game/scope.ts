// Discord shim — not copied from the Twitch bot (see sync.ts).
//
// Per-interaction context. The Twitch game modules "say" things by calling
// sendChatMessage(text, broadcasterId); on Discord the broadcaster is the
// server (guild id), and anything said while answering a slash command is
// collected here and sent as that command's reply. Anything said with no
// interaction in progress (cron jobs: merchant ads, autohunt reports, raid
// launches) goes to the outbound sender the Discord layer registers.

import { AsyncLocalStorage } from "node:async_hooks";

export interface Reply {
  text: string;
  /** The uncut version (fights' full battle log), attached as a file when it differs from text. */
  detail?: string;
}

export interface InteractionScope {
  guildId: string;
  userId: string;
  login: string;
  display: string;
  replies: Reply[];
  deferred: Promise<unknown>[];
}

const storage = new AsyncLocalStorage<InteractionScope>();

export function runInteraction<T>(scope: Omit<InteractionScope, "replies" | "deferred">, fn: () => Promise<T>): Promise<{ result: T; replies: Reply[] }> {
  const store: InteractionScope = { ...scope, replies: [], deferred: [] };
  return storage.run(store, async () => {
    try {
      const result = await fn();
      return { result, replies: store.replies };
    } finally {
      await Promise.allSettled(store.deferred);
    }
  });
}

export function currentInteraction(): InteractionScope | undefined {
  return storage.getStore();
}

type OutboundSender = (guildId: string, reply: Reply) => Promise<boolean>;
type DirectSender = (userId: string, text: string) => Promise<boolean>;
let outbound: OutboundSender = async () => false;
let direct: DirectSender = async () => false;

/** The Discord layer registers how to post to a server's channel and how to DM a member. */
export function setSenders(senders: { channel: OutboundSender; dm: DirectSender }) {
  outbound = senders.channel;
  direct = senders.dm;
}

/** Collects the reply when it answers the current interaction, else posts it to the server. */
export async function deliver(guildId: string, reply: Reply): Promise<boolean> {
  if (!reply.text.trim()) return true;
  const scope = storage.getStore();
  if (scope && scope.guildId === guildId) {
    scope.replies.push(reply);
    return true;
  }
  return await outbound(guildId, reply);
}

export async function deliverDirect(userId: string, text: string): Promise<boolean> {
  return userId ? await direct(userId, text) : false;
}
