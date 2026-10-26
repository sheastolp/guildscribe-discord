// Copies the game modules from the GuildScribe Twitch bot into game/.
//
// The Discord bot runs the Twitch bot's own game code (characters, combat,
// gold, Hunt and Hoard, raids…) instead of a rewrite, so it stays in step
// with it: run this after the Twitch bot changes, then `deno task check` and
// `deno task test`, and commit what changed.
//
//   deno task sync                     (Twitch repo at ../dnd-twitch-bot)
//   TWITCH_REPO=/path/to/repo deno task sync
//
// Starting from ENTRIES, every module they import (relative "./x.ts"
// imports, followed recursively) is copied unchanged — except SHIMS: those
// are Discord's own versions, kept in game/ and never overwritten (twitch.ts
// posts to Discord instead of Twitch chat, and so on). A module the Twitch
// bot no longer needs is removed again on the next sync.

const TWITCH_REPO = Deno.env.get("TWITCH_REPO") ?? new URL("../dnd-twitch-bot/", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
const GAME_DIR = new URL("./game/", import.meta.url);
const MANIFEST = new URL("./game/vendored.json", import.meta.url);

/** The Twitch modules the Discord bot calls into; the rest follow from their imports. */
export const ENTRIES = [
  "characters.ts", "bg3.ts", "combat.ts", "abilities_cmd.ts", "wildshape.ts",
  "points.ts", "rob.ts", "bribe.ts", "gamble.ts",
  "merchant.ts", "merchant_cron.ts", "haggle.ts",
  "autohunt.ts", "autohunt_cron.ts", "hoard.ts", "hoard_db.ts",
  "bestiary.ts", "huntcooldown.ts", "raid.ts", "oracle.ts",
  "chat_builtin.ts", "gear.ts", "savingthrows.ts",
  "bestiary_page.ts", "gold_page.ts", "gear_page.ts",
];

/** Discord's own stand-ins for Twitch-only modules (see the header of each). */
export const SHIMS = new Set([
  "twitch.ts", "whisper.ts", "config.ts", "scope.ts",
  "redemptions.ts", "swearjar.ts", "shots.ts",
  "chronicle.ts", "npcs.ts", "customcommands.ts", "commands_page.ts", "babushka.ts", "idle.ts",
]);

const IMPORT_RE = /(?:import|export)\s*(?:type\s+)?(?:\{[^}]*\}|\*(?:\s+as\s+\w+)?|\w+)?\s*(?:,\s*\{[^}]*\})?\s*from\s*"\.\/([^"]+)"/g;
const DYNAMIC_RE = /import\(\s*"\.\/([^"]+)"\s*\)/g;

function closure(): string[] {
  const seen = new Set<string>();
  const queue = [...ENTRIES];
  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file) || SHIMS.has(file)) continue;
    seen.add(file);
    const src = Deno.readTextFileSync(`${TWITCH_REPO}/${file}`);
    for (const m of [...src.matchAll(IMPORT_RE), ...src.matchAll(DYNAMIC_RE)]) queue.push(m[1]);
  }
  return [...seen].sort();
}

function twitchCommit(): string {
  try {
    const out = new Deno.Command("git", { args: ["-C", TWITCH_REPO, "rev-parse", "--short", "HEAD"], stdout: "piped", stderr: "null" }).outputSync();
    return new TextDecoder().decode(out.stdout).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

if (import.meta.main) {
  const files = closure();
  let previous: string[] = [];
  try { previous = JSON.parse(Deno.readTextFileSync(MANIFEST)).files ?? []; } catch { /* first sync */ }

  let changed = 0;
  for (const file of files) {
    const src = Deno.readTextFileSync(`${TWITCH_REPO}/${file}`);
    const dest = new URL(file, GAME_DIR);
    let old: string | null = null;
    try { old = Deno.readTextFileSync(dest); } catch { /* new file */ }
    if (old !== src) {
      Deno.writeTextFileSync(dest, src);
      console.log(`${old === null ? "added  " : "updated"} ${file}`);
      changed++;
    }
  }
  for (const file of previous) {
    if (files.includes(file) || SHIMS.has(file)) continue;
    try { Deno.removeSync(new URL(file, GAME_DIR)); console.log(`removed ${file}`); changed++; } catch { /* already gone */ }
  }
  for (const shim of SHIMS) {
    try { Deno.statSync(new URL(shim, GAME_DIR)); } catch { console.warn(`missing shim game/${shim}`); }
  }
  const commit = twitchCommit();
  Deno.writeTextFileSync(MANIFEST, JSON.stringify({ twitchCommit: commit, files }, null, 2) + "\n");
  console.log(`${files.length} modules from the Twitch bot (${commit}); ${changed} changed.`);
}
