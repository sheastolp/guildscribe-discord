# GuildScribe for Discord

GuildScribe's D&D guild hall as Discord slash commands: characters, dice,
the archives, parties, duels, monster hunts, the raid boss, gold, Hunt and
Hoard and the wandering merchant. It plays exactly like the Twitch bot,
because it **runs the Twitch bot's own game code**.

It's a standalone bot with its own database. Discord characters, gold and
parties are separate from Twitch ones, and each Discord server is its own
guild, the way each Twitch channel is.

It runs on the Yoga laptop next to the Twitch bot and UndercoverBurn, as
`tavernworks-guildscribe-discord` on port 8803, reached through the
Cloudflare Tunnel at `guildscribe-discord.tavernworks.dev`.

## How it works

```
Discord ──POST /interactions──▶ interactions.ts ──▶ commands.ts   /duel hunt start party:crew → "!dndduel party hunt crew"
                                      │
                                      ▼
                                 router.ts  ──▶  game/*.ts  (the Twitch bot's handlers, unchanged)
                                      │                │ sendChatMessage(...)
                                      ▼                ▼
                         Discord reply ◀── game/scope.ts ◀── game/twitch.ts (Discord shim)
```

- **`game/`** holds the Twitch bot's modules, copied unchanged by
  `sync.ts`. The exceptions are a few **shims**, Discord's own versions of
  Twitch-only modules. Each one says so in its first line:
  - `twitch.ts` collects what the game says, instead of posting to Twitch chat.
  - `whisper.ts`: a whisper is a DM.
  - `config.ts`: links point at this bot's own pages.
  - `scope.ts`: the per-command context.
  - The swear jar, channel points, chronicle, NPCs, custom commands, the
    Delve and Babushka are stubs, because they read Twitch chat or live in
    overlays.
- **`commands.ts`** lists every slash command and the Twitch chat line it
  stands for. User options become `@login`, so the game finds its target the
  same way it does on Twitch.
- **`identity.ts`**: a member's game login is `u` + their user ID in base 36
  (e.g. `u2k9d1x0q7p3a`). It never changes, so a member keeps their
  character when they rename. Replies are rewritten on the way out:
  - `@login` and `@Name` become Discord mentions (they don't ping in replies).
  - A bare login becomes the member's name.
  - `!dndduel party hunt` becomes `/duel hunt`.
  - Links to pages only the Twitch bot has are dropped.
- **`router.ts`** follows the command half of the Twitch bot's `main.ts`:
  the same feature switches, cooldown and activity log, and the same
  handlers in the same order.
- **`guild.ts`**: every server gets the Twitch bot's per-channel row, marked
  connected and live for good (a server has no stream to wait for). Game
  features start **on**, because the bot only speaks when someone uses a
  command. The merchant starts away.
- **`server.ts`** runs the endpoint and the public bestiary, treasury and
  gear pages. It also runs the jobs: autohunt settlement and raid musters
  every minute, the merchant every 5.

Every command is answered at once with "GuildScribe is thinking…", then
filled in. Fights and first-time 5e.tools lookups can take longer than
Discord's 3 seconds. Long replies continue in follow-up messages, and a
fight's uncut battle log comes attached as `battle-log.txt`.

## Commands

| Area | Commands |
|------|----------|
| Guild hall | `/help` `/start` `/guildscribe status` · `feature` · `channel` (moderators) `/twitchinvite` |
| Parchment | `/createchar` `/newchar` `/bg3` `/answer` `/cancel` `/char` `/abilities` `/wildshape` `/levelup` `/hp` `/savechar` `/loadchar` `/resetchar` `/gear` `/shmash` `/hug` |
| Fate's dice | `/roll` (dice, skills, or a question?) `/d20` `/fate` `/save` `/saves` `/rollcall` `/oracle` |
| Archives | `/spell` `/item` `/class` `/feat` `/ability` `/race` `/subrace` `/rule` `/monster` `/bg3lookup` `/bg3roll` `/bg3companion` `/bg3origin` `/bg3loot` `/bg3camp` `/div2` |
| Arena & wilds | `/party` `/duel player\|monster\|accept\|attack…` `/duel party …` `/duel hunt …` `/turn` `/rob` `/bestiary` `/autohunt` `/huntcooldown` `/rally` |
| Hunt and Hoard | `/hoard` `/hunt` `/ledger` `/bounties` `/shop` `/buy` `/inv` `/sell` `/drop` `/purse` |
| Gold | `/gold balance\|top\|today\|give\|add\|remove\|set\|list` `/giveaway` `/bribe` |
| Market | `/market on\|off\|status\|now` (moderators) `/haggle` `/stall` |

Moderator means **Manage Server**, **Manage Messages** or **Administrator**.
That's where the Twitch bot checks "broadcaster or mod".

### Differences from Twitch

- **Gold:** on Twitch, viewers earn copper for chatting while live. This bot
  never sees plain chat, so members earn it for each command they use
  instead, at the same rate and cooldown (`POINTS_PER_MESSAGE`,
  `POINTS_EARN_COOLDOWN_SECONDS`).
- **Raid quest:** Twitch posts one when the stream goes live. Here a
  moderator posts one with `/rally new`.
- **Posts nobody asked for** (merchant ads, raid launches and reminders,
  autohunt reports set to chat) go to the channel set with
  `/guildscribe channel`. Without one, they go wherever commands were last
  used. Autohunt reports go by DM by default (Twitch whispers them), and fall
  back to the channel when a member doesn't take DMs.
- **Switched-off features** say so, instead of staying silent.
- **Not here:** the character-sheet and roster pages (links to them are left
  out), the swear jar, channel-point boons, custom commands and triggers,
  timed messages, maps, NPCs and the chronicle, the Endless Delve, overlays,
  moderation tools, and everything else about Twitch chat or streams.

## Setting it up

### 1. The Discord application

1. https://discord.com/developers/applications → your GuildScribe app (or
   **New Application**).
2. **General Information:** copy the **Application ID** and **Public Key**.
3. **Bot:** **Reset Token** and copy it. No privileged intents are needed.
4. **Installation:** under Guild Install, add the scopes `applications.commands`
   and `bot`, with the permissions **Send Messages** and **Attach Files**.
   Open the install link to add it to a server.

### 2. Run it on the Yoga laptop

Follow **Adding GuildScribe for Discord** in the tavernworks repo's
[`bot-host/README.md`](https://github.com/sheastolp/tavernworks/blob/main/bot-host/README.md).
In short: push this repo to `sheastolp/guildscribe-discord`, then run
`setup.sh` again. Fill in `/etc/tavernworks/guildscribe-discord.env` (see
`.env.example`), route the tunnel hostname, and start the service. After that,
pushing to `main` deploys, the same as the other bots.

### 3. Point Discord at it

In the Developer Portal, **General Information → Interactions Endpoint URL**:
`https://guildscribe-discord.tavernworks.dev/interactions`. Discord sends a
signed test request when you save. If the bot is running and
`DISCORD_PUBLIC_KEY` is right, it saves.

### 4. Register the slash commands

```sh
deno task register              # every server; can take up to an hour to show up
deno task register <server id>  # one test server, right away
```

Run it again whenever `commands.ts` changes. It needs `DISCORD_BOT_TOKEN`
and `DISCORD_APPLICATION_ID`.

### Running it on this PC

```sh
deno task start   # reads the environment; serves 127.0.0.1:8803
```

Discord can only reach it through a public HTTPS address, for example a
quick `cloudflared tunnel --url http://127.0.0.1:8803`. Use that address as
the Interactions Endpoint URL and `PUBLIC_BASE_URL` while testing.

## Keeping up with the Twitch bot

When the Twitch bot's game changes:

```sh
deno task sync    # copies the changed modules from ../dnd-twitch-bot (or TWITCH_REPO=...)
deno task check
deno task test
```

Then commit and push; the Yoga picks it up within 3 minutes.
`game/vendored.json` records which Twitch commit was copied.

- **A new Twitch command** needs an entry in `commands.ts` (and
  `deno task register`), and its handler added to `router.ts` if it's in a
  new module (add the module to `ENTRIES` in `sync.ts` too).
- **The check fails** when a game module starts importing something
  Twitch-only. Add a shim for it in `game/` and list it in `SHIMS` in
  `sync.ts`. A shim must export the names the game imports from it.

## Tests

`deno task test` runs real slash commands against a throwaway database, with
Discord's API stubbed. That covers characters, dice, lookups (these need the
internet), parties, duels, hunts, gold, robbing, Hunt and Hoard, autohunt,
raids, giveaways, the wizard, feature switches and the reply rewriting. It
also signs a request the way Discord does and runs it through the endpoint,
and checks posts made outside a command and the three pages. `SHOW=1`
prints every reply.

## The old Val Town version

The first Discord port (dice, lookups, characters and its own combat engine,
on Val Town) is replaced by this one. Its database isn't carried over:
characters made there need to be made again.
