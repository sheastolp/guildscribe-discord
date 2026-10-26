// Discord shim — not copied from the Twitch bot (see sync.ts).
//
// The swear jar itself reads chat, which this bot doesn't see. Only the jar
// total survives: !rob @GuildScribe fines the robber into it (rob.ts). Same
// table as the Twitch bot's swearjar.ts.

import { sqlite } from "./sqlite.ts";
import { MAX_COPPER } from "./coins.ts";

export async function ensureSwearJarTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS swear_jar (
      broadcaster_id TEXT PRIMARY KEY,
      total INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER
    )`,
  );
}

export async function getJarTotal(broadcasterId: string): Promise<number> {
  const res = await sqlite.execute("SELECT total FROM swear_jar WHERE broadcaster_id = ?", [broadcasterId]);
  return Number(res.rows[0]?.total ?? 0);
}

/** Adds (or, with a negative delta, removes) copper; never below 0. Returns the new total. */
export async function adjustJar(broadcasterId: string, delta: number): Promise<number> {
  await sqlite.execute(
    `INSERT INTO swear_jar (broadcaster_id, total, updated_at)
     VALUES (?, MIN(?, MAX(0, ?)), ?)
     ON CONFLICT(broadcaster_id) DO UPDATE SET
       total = MIN(?, MAX(0, total + ?)),
       updated_at = excluded.updated_at`,
    [broadcasterId, MAX_COPPER, delta, Date.now(), MAX_COPPER, delta],
  );
  return await getJarTotal(broadcasterId);
}
