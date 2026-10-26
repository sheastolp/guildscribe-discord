// Discord shim — not copied from the Twitch bot (see sync.ts).
//
// PUBLIC_BASE_URL is this Discord bot's own public address (the Cloudflare
// Tunnel hostname on the Yoga laptop). It serves the bestiary, treasury and
// gear pages the game modules link to; see server.ts.

export const PUBLIC_BASE_URL = Deno.env.get("PUBLIC_BASE_URL") ?? "https://guildscribe-discord.tavernworks.dev";
/** PUBLIC_BASE_URL normalized to scheme://host (no trailing slash/path). */
export const PUBLIC_ORIGIN = new URL(PUBLIC_BASE_URL).origin;

// Permanent invite to the GuildScribe community Discord.
export const DISCORD_INVITE_URL = "https://discord.gg/BmdDXCrAzK";
