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
  gear pages. It also runs the jobs: autohunt settlement, raid musters and
  WoW raid reminders and close-outs and Twitch go-live checks every minute,
  the merchant every 5. At
  start-up it registers the slash commands if they changed.
- **`wow.ts`** is Discord's own: WoW: Forever raid signups, invites and
  attendance (see below). The Twitch bot has nothing like it, so it isn't
  synced.

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
| Gold | `/gold balance\|top\|today\|give\|add\|remove\|set\|list` `/giveaway` `/bribe` `/gamble` |
| Market | `/market on\|off\|status\|now` (moderators) `/haggle` `/stall` |
| Tavern talk | `/fun coinflip\|flip\|jumble\|dadjoke\|fact\|pic…` `/askme` `/quote random\|show\|count\|add\|edit\|remove` |
| WoW: Forever | `/wow forever` `/wow raid create\|list\|view\|invite\|edit\|remove\|cancel\|complete\|attendance\|loot` `/wow character` `/wow stats` `/wow top` `/wow timezone` |
| Go-live alerts | `/live add\|remove\|list\|test` |
| Anything else | `/gs command:!<any chat command>`: every command the Twitch bot's game answers, typed as on Twitch |

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
- **Not here:** the character-sheet, roster and quotes pages (links to them
  are left out), the swear jar, channel-point boons, custom commands and
  triggers, timed messages, maps, game stats, NPCs and the chronicle, the
  Endless Delve, overlays, moderation tools, and everything else about Twitch
  chat or streams.
- **Discord only:** WoW: Forever raid signups and Twitch go-live alerts (below).

## World of Warcraft: Forever raids

`wow.ts` (tables in `wow_db.ts`, start times in `wow_time.ts`). Its own
feature, `wow`, on by default.

- **Post a raid:** `/wow raid create title:Molten Core when:fri 8pm size:40`.
  `when` takes `fri 8pm`, `tomorrow 19:30`, `11/8 8:30pm`, `2026-11-08 20:00`
  or `in 2h`, read in the server's timezone (`/wow timezone`, default
  `WOW_DEFAULT_TIMEZONE` or US Eastern) or the `timezone` you pick. Discord
  shows it to everyone in their own. Size 5 is a party. Role slots default by
  size (40: 5 tanks, 10 healers, 25 DPS) and can be set. `ping:@Raiders`
  pings a role on the post; `channel:` posts it somewhere else.
- **Sign up** with the buttons on the post: 🛡️ Tank, 💚 Healer, ⚔️ DPS,
  🤔 Maybe, ❌ Can't make it, Leave. Slots fill in the order people click.
  Past a role's slots, or the raid's size, you're on the bench, and you're
  moved in, with a DM, when a spot opens. Switching role puts you at the back
  of that role's line, so it never bumps anyone.
- **Invite:** `/wow raid invite raid:12 user:@Bob members:@Ann @Cy` DMs each
  of them the raid card with the same buttons, and pings them on the server.
  Members who don't take DMs from the server are named. The post lists who
  hasn't answered. The leader, moderators and anyone signed up can invite.
- **Reminders:** 30 minutes before (`/wow timezone remind:`), everyone in,
  on the bench or maybe gets a DM, and those in or maybe are pinged in the
  raid's channel.
- **Tracking:** `WOW_FINISH_AFTER_HOURS` (4) after the start, or with
  `/wow raid complete`, the raid closes: everyone in counts as having shown
  up. `/wow raid attendance` marks no-shows (or adds someone),
  `/wow raid loot` records drops. `/wow stats` shows a member's raids,
  no-shows, attendance rate, roles and loot; `/wow top` shows who's raided
  most.
- **Leaders:** the raid's creator and moderators can edit, remove a
  signup, cancel (signups get a DM), complete, fix attendance and give loot.
- `/wow character name:Thrall class:Shaman role:healer` sets your main,
  shown on rosters. `/wow forever` is the launch countdown, the Twitch
  bot's `!wow:forever`.

## Go-live alerts

`live.ts`. Its own feature, `live`, on by default. A post in a channel when a
Twitch streamer goes live, like Streamcord's.

- **Watch someone:** `/live add streamer:sheastolp channel:#streams ping:@Stream Alerts`
  (moderators). `streamer` takes a name or a `twitch.tv/…` link; `ping` can be
  `@everyone`; `message` is the text above the card, with `{streamer}`,
  `{title}`, `{game}` and `{url}` (default `🔴 **{streamer}** is live on Twitch! {url}`).
  Running it again for the same streamer changes their alert. Up to 25 per server.
- **The post:** a card with the stream's title, game, viewers and a preview,
  and a **Watch Stream** button. While live it follows title and game changes.
  When the stream ends it turns grey: "was live", and for how long. A stream
  that drops and is back within 10 minutes reuses the post, so nobody is
  pinged twice.
- `/live list` shows who's watched and who's live; `/live test` posts the
  alert now; `/live remove` stops it.
- Twitch is checked every minute, so an alert comes within a minute or so of
  going live. It needs `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` (the same
  Twitch app the Twitch bot uses works) and, in the alert channel, Send
  Messages and Embed Links. To ping `@everyone` the bot also needs Mention
  Everyone there.

## Setting it up

### 1. The Discord application

1. https://discord.com/developers/applications → your GuildScribe app (or
   **New Application**).
2. **General Information:** copy the **Application ID** and **Public Key**.
3. **Bot:** **Reset Token** and copy it. No privileged intents are needed.
4. **Installation:** under Guild Install, add the scopes `applications.commands`
   and `bot`, with the permissions **Send Messages**, **Embed Links** and
   **Attach Files** (raid cards are embeds).
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

### 4. The slash commands

The bot registers them with Discord itself when it starts and `commands.ts`
has changed since the last registration (the hash is kept in the database's
`discord_meta`). Set `AUTO_REGISTER=0` to stop that. By hand:

```sh
deno task register              # every server; can take up to an hour to show up
deno task register <server id>  # one test server, right away
```

Both need `DISCORD_BOT_TOKEN` and `DISCORD_APPLICATION_ID`.

### Running it on this PC

```sh
deno task start   # reads the environment; serves 127.0.0.1:8803
```

Discord can only reach it through a public HTTPS address, for example a
quick `cloudflared tunnel --url http://127.0.0.1:8803`. Use that address as
the Interactions Endpoint URL and `PUBLIC_BASE_URL` while testing.

## Keeping up with the Twitch bot

It happens on its own. Every 15 minutes the **Sync game from the Twitch
bot** workflow (`.github/workflows/sync-from-twitch.yml`) runs `sync.ts`
against `sheastolp/dnd-twitch-bot` main. When a module changed, it
type-checks and runs the tests, and only if both pass commits the sync to
`main`. The Yoga deploys it within 3 minutes. A sync that breaks the Discord
side fails the workflow (GitHub emails you) and nothing is committed, so the
bot stays on its last good version. **Actions → Sync game from the Twitch
bot → Run workflow** syncs right away.

GitHub turns off scheduled workflows in a repo with no commits for 60 days.
If the Twitch bot goes quiet that long, re-enable it on the Actions tab.

By hand, from this folder:

```sh
deno task sync    # copies the changed modules from ../dnd-twitch-bot (or TWITCH_REPO=...)
deno task check
deno task test
```

`game/vendored.json` records which Twitch commit was copied.

- **A new Twitch command** works right away as `/gs command:!thatcommand`
  when its handler is in a module the router already calls. It gets its own
  slash command once it has an entry in `commands.ts`. A handler in a **new**
  module needs that module in `ENTRIES` in `sync.ts` and its call added to
  `router.ts`.
- **A new Twitch dashboard switch** can be flipped with
  `/guildscribe feature name:<switch>`, even before it's in `FEATURES`
  (`guild.ts`). A feature added to `FEATURES` is switched to its starting
  state in existing servers the next time they're used.
- **The check fails** when a game module starts importing something
  Twitch-only. Add a shim for it in `game/` and list it in `SHIMS` in
  `sync.ts`. A shim must export the names the game imports from it.

## Tests

`deno task test` runs real slash commands against a throwaway database, with
Discord's API stubbed. That covers characters, dice, lookups (these need the
internet), parties, duels, hunts, gold, robbing, Hunt and Hoard, autohunt,
raids, giveaways, the wizard, feature switches and the reply rewriting. It
also signs a request the way Discord does and runs it through the endpoint,
and checks posts made outside a command and the three pages.
`test/wow_test.ts` runs a WoW raid from post to attendance against a fake
Discord API: buttons, the bench, DM invites, reminders, the close-out,
loot and stats, plus start-time parsing across daylight saving.
`test/live_test.ts` runs go-live alerts against a fake Twitch: going live,
a game change, a dropped stream coming back, the end card and `@everyone`.
`SHOW=1` prints every reply.

## The old Val Town version

The first Discord port (dice, lookups, characters and its own combat engine,
on Val Town) is replaced by this one. Its database isn't carried over:
characters made there need to be made again.
