// Creates every table the game modules and the Discord layer use, once at
// start-up. Same functions the Twitch bot's main.ts runs, for the modules
// this bot has, plus the Discord bot's own tables.

import { ensureTables } from "./game/db.ts";
import { ensureSocialTables } from "./game/social_db.ts";
import { ensurePointsTables } from "./game/points_db.ts";
import { ensureSwearJarTables } from "./game/swearjar.ts";
import { ensureAutohuntTables } from "./game/autohunt_db.ts";
import { ensureHuntCooldownTables } from "./game/huntcooldown.ts";
import { ensureWildShapeTables } from "./game/wildshape.ts";
import { ensureRaidTables } from "./game/raid.ts";
import { ensureBestiaryTables } from "./game/bestiary.ts";
import { ensureHoardTables } from "./game/hoard_db.ts";
import { ensureBattleLogTables } from "./game/battle_log.ts";
import { ensureSavingThrowTables } from "./game/savingthrows.ts";
import { ensureChannelOptionTables } from "./game/channel_options.ts";
import { ensureQuoteTables } from "./game/quotes.ts";
import { ensureWowTables } from "./wow_db.ts";
import { ensureLiveTables } from "./live.ts";
import { ensureLevelTables } from "./levels.ts";
import { ensureBirthdayTables } from "./birthdays.ts";
import { ensureRaffleTables } from "./raffles.ts";
import { ensureInviteTables } from "./invites.ts";
import { ensureNotifyTables } from "./notify.ts";
import { ensureWelcomeTables } from "./welcome.ts";
import { ensureSelfRoleTables } from "./selfroles.ts";
import { ensureModerationTables } from "./moderation.ts";
import { ensureModlogTables } from "./modlog.ts";
import { ensureHoneypotTables } from "./honeypot.ts";
import { ensureSecurityTables } from "./security.ts";
import { ensureMemberTables } from "./identity.ts";
import { ensureGuildTables } from "./guild.ts";

let ready: Promise<void> | null = null;

export function ensureSchema(): Promise<void> {
  ready ??= (async () => {
    await ensureTables();
    await Promise.all([
      ensureSocialTables(), ensurePointsTables(), ensureSwearJarTables(), ensureAutohuntTables(),
      ensureHuntCooldownTables(), ensureWildShapeTables(), ensureRaidTables(), ensureBestiaryTables(),
      ensureHoardTables(), ensureBattleLogTables(), ensureSavingThrowTables(), ensureChannelOptionTables(),
      ensureMemberTables(), ensureGuildTables(), ensureQuoteTables(), ensureWowTables(), ensureLiveTables(),
      ensureLevelTables(), ensureBirthdayTables(), ensureRaffleTables(), ensureInviteTables(), ensureNotifyTables(),
      ensureWelcomeTables(), ensureSelfRoleTables(), ensureModerationTables(), ensureModlogTables(), ensureHoneypotTables(),
      ensureSecurityTables(),
    ]);
  })().catch((e) => {
    ready = null;
    throw e;
  });
  return ready;
}
