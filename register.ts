// Registers (or updates) the slash commands with Discord. Run once after
// setting up, and again whenever commands.ts changes:
//
//   deno task register                 every server (can take up to an hour to show)
//   deno task register <server id>     one test server, instantly
//
// Needs DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID.

import { registrationPayload } from "./commands.ts";
import { env, putCommands } from "./discord.ts";

const guildId = Deno.args[0];
const commands = registrationPayload();
const result = await putCommands(env("DISCORD_APPLICATION_ID"), commands, guildId);
if (!result) {
  console.error("Registration failed (see the error above).");
  Deno.exit(1);
}
console.log(`Registered ${result.length} commands${guildId ? ` in server ${guildId}` : " globally"}: ${result.map((c: any) => c.name).join(", ")}`);
