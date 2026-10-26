// The slash commands, and the Twitch chat command each one stands for.
//
// Every game command is answered by the Twitch bot's own handler (game/),
// which reads a chat line like "!dndduel party hunt classic crew goblin".
// Each entry here describes the Discord side (name, options) and `twitch`,
// which builds that chat line from the options the member filled in. A user
// option becomes "@login" (identity.ts), so handlers find their target the
// same way they do on Twitch.
//
// `local` commands (help, settings, the Twitch invite, WoW raids, go-live
// alerts) are answered by the Discord layer itself (interactions.ts, wow.ts,
// live.ts) instead.
//
// /gs takes any chat command as typed on Twitch ("/gs command:!pog"), so a
// command the Twitch bot gains reaches Discord with the next sync, before it
// gets a slash command of its own here.
//
// After changing this file, restart the bot: it registers the commands with
// Discord itself when they've changed (server.ts). `deno task register`
// still does it by hand.

import { TIMEZONES } from "./wow_time.ts";

export type OptionType = "string" | "integer" | "boolean" | "user" | "channel" | "role";

export interface Option {
  name: string;
  description: string;
  type?: OptionType; // default "string"
  required?: boolean;
  /** A value, or [label shown, value sent]. */
  choices?: Array<string | [string, string]>;
  /** Discord asks interactions.ts for suggestions as the member types (raid numbers, feature names). */
  autocomplete?: boolean;
  min?: number;
  max?: number;
}

/** Reads the options of one invocation. */
export interface Args {
  /** A string/integer option as text ("" when left out). */
  s(name: string): string;
  /** A user option as "@login" ("" when left out). */
  u(name: string): string;
  b(name: string): boolean;
  /** A user, role or channel option's Discord ID ("" when left out). */
  id(name: string): string;
}

export interface Leaf {
  name: string;
  description: string;
  options?: Option[];
  twitch?: (a: Args) => string;
  local?: string;
}

export interface Command extends Leaf {
  subcommands?: Leaf[];
  groups?: { name: string; description: string; subcommands: Leaf[] }[];
  /** Which subcommand a reply's "!word" hint means: bare, followed by an argument, or by an @-name. */
  hint?: { bare?: string; arg?: string; user?: string };
}

const user = (description = "Who", required = false): Option => ({ name: "user", description, type: "user", required });
const text = (name: string, description: string, required = false): Option => ({ name, description, required });
const flag = (name: string, description: string): Option => ({ name, description, type: "boolean" });
const raid = (): Option => ({ name: "raid", description: "Which raid (start typing its name or number)", type: "integer", required: true, autocomplete: true });
const streamer = (): Option => ({ name: "streamer", description: "Which streamer (start typing)", required: true, autocomplete: true });
const WOW_ZONES: Array<[string, string]> = TIMEZONES.map(([label, zone]) => [label, zone]);
const WOW_SIZES: Array<[string, string]> = [["Party (5)", "5"], ["10", "10"], ["20", "20"], ["25", "25"], ["40", "40"]];
const slot = (name: string, description: string): Option => ({ name, description, type: "integer", min: 0, max: 40 });

/** One subcommand per word, each sending "!<base> <word>". */
const words = (base: string, list: Array<[string, string]>): Leaf[] =>
  list.map(([name, description]) => ({ name, description, twitch: () => `!${base} ${name}` }));

/** A lookup command: "/spell fireball" → "!spell fireball". */
const lookup = (name: string, what: string, example: string, plus = false): Command => ({
  name,
  description: `Look up a ${what} in the archives`,
  options: [text("name", `e.g. ${example}`), ...(plus ? [{ name: "plus", description: "Magic bonus, e.g. 1 for +1", type: "integer" as const }] : [])],
  twitch: (a) => `!${name} ${a.s("name")} ${a.s("plus") ? `+${a.s("plus")}` : ""}`,
});

export const COMMANDS: Command[] = [
  // ── Guild hall ──
  { name: "help", description: "What GuildScribe can do on this server", local: "help" },
  {
    name: "start",
    description: "Beginner's quick-start: how to get playing",
    options: [{ name: "topic", description: "One step in more detail", choices: ["char", "dice", "fight", "party", "coin"] }],
    twitch: (a) => `!start ${a.s("topic")}`,
  },
  {
    name: "guildscribe",
    description: "Server settings for GuildScribe",
    subcommands: [
      { name: "status", description: "Which features are on in this server", local: "settings.status" },
      {
        name: "feature",
        description: "Turn a feature on or off (moderators)",
        options: [
          { name: "name", description: "Which feature (or any Twitch dashboard switch by name)", required: true, autocomplete: true },
          { name: "state", description: "On or off", required: true, choices: ["on", "off"] },
        ],
        local: "settings.feature",
      },
      {
        name: "channel",
        description: "Where GuildScribe posts on its own: merchant, raid and autohunt news (moderators)",
        options: [{ name: "channel", description: "The channel (leave out to use wherever commands were last used)", type: "channel" }],
        local: "settings.channel",
      },
    ],
  },
  { name: "twitchinvite", description: "Add GuildScribe to your Twitch channel", local: "twitchinvite" },
  {
    name: "gs",
    description: "Any GuildScribe chat command, typed as on Twitch (e.g. !wow:forever)",
    options: [text("command", "The chat command, e.g. !coinflip or !quote 12", true)],
    twitch: (a) => a.s("command").replace(/^\/+/, "").replace(/^(?!!)/, "!"),
  },

  // ── Adventurer's parchment ──
  { name: "createchar", description: "Roll an instant level 1 character", options: [user("Make one for someone else (moderators)")], twitch: (a) => `!createchar ${a.u("user")}` },
  { name: "newchar", description: "Make a character step by step (answer with /answer)", twitch: () => "!newchar" },
  { name: "bg3", description: "Random BG3 race and class; you assign scores by point-buy (answer with /answer)", twitch: () => "!bg3" },
  { name: "answer", description: "Answer the character wizard", options: [text("choice", "Your answer", true)], twitch: (a) => `!answer ${a.s("choice")}` },
  { name: "cancel", description: "Stop the character wizard", twitch: () => "!cancel" },
  { name: "char", description: "Your character sheet, or someone else's", options: [user()], twitch: (a) => `!char ${a.u("user")}` },
  { name: "abilities", description: "Combat kit: attack, AC, class abilities and racial traits", options: [user()], twitch: (a) => `!abilities ${a.u("user")}` },
  {
    name: "wildshape",
    description: "Druid Wild Shape (2024 rules)",
    options: [text("action", "A beast to become, or: info, list, forms, forget <beast>, end, shortrest, rest, circle moon")],
    twitch: (a) => `!wildshape ${a.s("action")}`,
  },
  {
    name: "levelup",
    description: "Change level (moderators)",
    options: [text("amount", "e.g. +2 or -1 (default +1)"), user("Whose character")],
    twitch: (a) => `!levelup ${a.u("user")} ${a.s("amount")}`,
  },
  { name: "hp", description: "Change your HP", options: [text("change", "e.g. +5 or -3", true)], twitch: (a) => `!hp ${a.s("change")}` },
  { name: "savechar", description: "Back up your character", twitch: () => "!savechar" },
  { name: "loadchar", description: "Restore your backed-up character", twitch: () => "!loadchar" },
  { name: "resetchar", description: "Delete your character (moderators can reset someone else's)", options: [user("Whose (moderators)")], twitch: (a) => `!resetchar ${a.u("user")}` },
  { name: "gear", description: "Gear on a character sheet", options: [user(), flag("all", "Link the page of every ware and who carries it")], twitch: (a) => a.b("all") ? "!gear list" : `!gear ${a.u("user")}` },
  { name: "shmash", description: "A narrated (harmless) smash against someone", options: [user("Target")], twitch: (a) => `!shmash ${a.u("user")}` },
  { name: "hug", description: "Hug someone", options: [user("Who to hug")], twitch: (a) => `!hug ${a.u("user")}` },

  // ── Fate's dice ──
  {
    name: "roll",
    description: "Roll dice (2d6+3), a skill check (stealth), or ask a question?",
    options: [text("what", "Dice, a skill, or a yes/no question ending in ?"), user("Roll for someone else")],
    twitch: (a) => `!roll ${a.u("user")} ${a.s("what")}`,
  },
  { name: "d20", description: "Roll a d20", options: [user("Roll for someone else")], twitch: (a) => `!d20 ${a.u("user")}` },
  {
    name: "fate",
    description: "Ask fate a yes/no question",
    options: [text("question", "e.g. will the dragon win?", true)],
    twitch: (a) => `!roll ${a.s("question").replace(/\?*$/, "?")}`,
  },
  {
    name: "save",
    description: "Saving throw: dex, wis dc15 — or +3 against the bot",
    options: [text("check", "e.g. dex, strength dc15, +3, -1 +1d4"), user("Call for someone else's save")],
    twitch: (a) => `!save ${a.u("user")} ${a.s("check")}`,
  },
  { name: "saves", description: "Saving throws tally", options: [flag("reset", "Start the tally over (moderators)")], twitch: (a) => a.b("reset") ? "!saves reset" : "!saves" },
  {
    name: "rollcall",
    description: "Natural 1/20 leaderboard, or one player's counts",
    options: [{ name: "kind", description: "Which naturals", choices: ["nat20", "nat1"] }, { name: "window", description: "Time frame", choices: ["hour", "day", "week"] }, user("One player's own counts")],
    twitch: (a) => `!rollcall ${a.u("user")} ${a.u("user") ? "" : a.s("kind")} ${a.s("window")}`,
  },
  { name: "oracle", description: "Ask the oracle; the answer is a member of the guild", options: [text("question", "e.g. who should lead the party?", true)], twitch: (a) => `!oracle ${a.s("question")}` },

  // ── Guild archives ──
  lookup("spell", "spell", "fireball", true),
  lookup("item", "magic item or piece of equipment", "longsword", true),
  lookup("class", "class", "wizard"),
  lookup("feat", "feat", "grappler"),
  lookup("ability", "ability score", "dexterity"),
  lookup("race", "race", "elf"),
  lookup("subrace", "subrace", "high elf"),
  lookup("rule", "rule", "advantage"),
  lookup("monster", "monster", "adult red dragon"),
  { name: "bg3lookup", description: "Baldur's Gate 3 knowledgebase", options: [text("query", "e.g. astarion, location grymforge, faction zhentarim")], twitch: (a) => `!bg3lookup ${a.s("query")}` },
  { name: "bg3roll", description: "Random BG3 character (flavor only)", twitch: () => "!bg3roll" },
  { name: "bg3companion", description: "Which BG3 companion you're traveling with", twitch: () => "!bg3companion" },
  { name: "bg3origin", description: "Cast as a BG3 origin character", twitch: () => "!bg3origin" },
  { name: "bg3loot", description: "Random BG3-style magic item drop", twitch: () => "!bg3loot" },
  { name: "bg3camp", description: "A BG3 camp-night vignette", twitch: () => "!bg3camp" },
  {
    name: "div2",
    description: "The Division 2 companion",
    subcommands: [
      { name: "list", description: "The Division 2 commands", twitch: () => "!div2" },
      { name: "build", description: "Random agent build", twitch: () => "!div2build" },
      { name: "loot", description: "Random loot drop", twitch: () => "!div2loot" },
      { name: "mission", description: "Tonight's activity and a challenge", twitch: () => "!div2mission" },
      { name: "lookup", description: "Division 2 knowledgebase", options: [text("query", "e.g. striker, exotic chameleon")], twitch: (a) => `!div2lookup ${a.s("query")}` },
    ],
  },

  // ── Guild company & arena ──
  {
    name: "party",
    description: "Form and manage a company",
    subcommands: [
      { name: "create", description: "Found a company (you lead it)", options: [text("name", "Company name", true)], twitch: (a) => `!party create ${a.s("name")}` },
      { name: "join", description: "Join a company", options: [text("name", "Company name", true)], twitch: (a) => `!party join ${a.s("name")}` },
      { name: "invite", description: "Invite someone", options: [user("Who to invite", true), text("name", "Company (if you have more than one)")], twitch: (a) => `!party invite ${a.u("user")} ${a.s("name")}` },
      { name: "accept", description: "Accept an invitation", options: [text("name", "Company (if invited to more than one)")], twitch: (a) => `!party accept ${a.s("name")}` },
      { name: "decline", description: "Decline an invitation", options: [text("name", "Company (if invited to more than one)")], twitch: (a) => `!party decline ${a.s("name")}` },
      { name: "list", description: "Your companies, or one company's roster", options: [text("name", "One company")], twitch: (a) => `!party list ${a.s("name")}` },
      { name: "leave", description: "Leave a company", options: [text("name", "Company name", true)], twitch: (a) => `!party leave ${a.s("name")}` },
      { name: "disband", description: "Dissolve your company (leader)", options: [text("name", "Company name", true)], twitch: (a) => `!party disband ${a.s("name")}` },
    ],
  },
  {
    name: "duel",
    description: "Fight: other players, monsters, or party against party",
    hint: { arg: "monster", user: "player" },
    subcommands: [
      {
        name: "player",
        description: "Challenge another player",
        options: [user("Who to challenge", true), flag("classic", "Turn by turn with /duel attack instead of resolved at once")],
        twitch: (a) => `!dndduel ${a.b("classic") ? "classic " : ""}${a.u("user")}`,
      },
      {
        name: "monster",
        description: "Fight a monster alone: a level-fit one, or name it",
        options: [text("monster", "e.g. goblin, beholder"), flag("classic", "Turn by turn with /duel attack")],
        twitch: (a) => a.b("classic") ? `!dndduel monster classic ${a.s("monster")}` : `!dndduel ${a.s("monster")}`,
      },
      ...words("dndduel", [["accept", "Accept a challenge"], ["decline", "Decline a challenge"], ["attack", "Take your turn (classic)"], ["status", "How the fight stands"], ["end", "End the fight"]]),
    ],
    groups: [
      {
        name: "party",
        description: "Company against company",
        subcommands: [
          {
            name: "challenge",
            description: "Your company challenges another (leader)",
            options: [text("yours", "Your company", true), text("theirs", "Their company", true), flag("classic", "Turn by turn")],
            twitch: (a) => `!dndduel party ${a.b("classic") ? "classic " : ""}${a.s("yours")} ${a.s("theirs")}`,
          },
          ...words("dndduel party", [["accept", "Accept"], ["decline", "Decline"], ["attack", "Take your turn (classic)"], ["status", "How it stands"], ["end", "End it"]]),
        ],
      },
      {
        name: "hunt",
        description: "Your company against one monster",
        subcommands: [
          {
            name: "start",
            description: "Start a party hunt",
            options: [text("party", "Your company", true), text("monster", "A monster to hunt (default: level-fit)"), flag("classic", "Turn by turn")],
            twitch: (a) => `!dndduel party hunt ${a.b("classic") ? "classic " : ""}${a.s("party")} ${a.s("monster")}`,
          },
          ...words("dndduel party hunt", [["attack", "Take your turn (classic)"], ["status", "How it stands"], ["end", "End it"]]),
        ],
      },
    ],
  },
  {
    name: "turn",
    description: "Initiative tracker (rolling is open to all; the rest is for moderators)",
    subcommands: [
      { name: "roll", description: "Roll initiative (1d20 + DEX)", twitch: () => "!turn roll" },
      { name: "add", description: "Add a combatant", options: [text("name", "Who", true), { name: "initiative", description: "Initiative", type: "integer", required: true }], twitch: (a) => `!turn add ${a.s("name")} ${a.s("initiative")}` },
      { name: "remove", description: "Remove a combatant", options: [text("name", "Who", true)], twitch: (a) => `!turn remove ${a.s("name")}` },
      ...words("turn", [["start", "Start an encounter"], ["next", "Next turn"], ["prev", "Previous turn"], ["show", "Show the order"], ["end", "End the encounter"]]),
    ],
  },
  { name: "rob", description: "Robbery duel: the loser pays the winner 1–9% of their coin", options: [user("Who to rob", true)], twitch: (a) => `!rob ${a.u("user")}` },
  {
    name: "bestiary",
    description: "The monsters this server can hunt",
    hint: { bare: "page", arg: "show" },
    subcommands: [
      { name: "page", description: "Link to the bestiary page", twitch: () => "!bestiary" },
      { name: "show", description: "One monster's stat block and record", options: [text("monster", "Which monster", true)], twitch: (a) => `!bestiary ${a.s("monster")}` },
      { name: "learn", description: "Teach the bestiary a monster", options: [text("monster", "Which monster", true)], twitch: (a) => `!bestiary learn ${a.s("monster")}` },
      { name: "forget", description: "Strike a learned monster (moderators)", options: [text("monster", "Which monster", true)], twitch: (a) => `!bestiary forget ${a.s("monster")}` },
      { name: "reset", description: "Clear what monsters have learned (moderators)", options: [text("monster", "A monster, or all", true)], twitch: (a) => `!bestiary reset ${a.s("monster")}` },
    ],
  },
  {
    name: "autohunt",
    description: "Send your hero hunting on their own for a while",
    hint: { bare: "start", arg: "start" },
    subcommands: [
      { name: "start", description: "Start a timed hunt", options: [text("duration", "e.g. 20m, 1h, 1hr 30min (default 15m)")], twitch: (a) => `!autohunt ${a.s("duration")}` },
      { name: "status", description: "Progress so far", twitch: () => "!autohunt status" },
      { name: "stop", description: "Recall your hero", twitch: () => "!autohunt stop" },
    ],
  },
  { name: "huntcooldown", description: "The hunting cooldown (moderators can set it)", options: [text("time", "e.g. 90s, 5m, off")], twitch: (a) => `!huntcooldown ${a.s("time")}` },
  {
    name: "rally",
    description: "Raid quest against the server's raid boss",
    hint: { bare: "join" },
    subcommands: [
      { name: "join", description: "Sound the war horn, or join the muster", twitch: () => "!rally" },
      { name: "go", description: "Launch the muster now (its leader or a moderator)", twitch: () => "!rally go" },
      { name: "status", description: "Boss HP, muster and cooldown", twitch: () => "!rally status" },
      { name: "cooldown", description: "Raid cooldown (moderators can set it)", options: [text("time", "e.g. 10m, 1h, off")], twitch: (a) => `!rally cooldown ${a.s("time")}` },
      { name: "new", description: "Post a fresh raid quest (moderators)", twitch: () => "!rally new" },
    ],
  },

  // ── Hunt and Hoard ──
  { name: "hoard", description: "Your Hunt and Hoard sheet", twitch: () => "!hoard" },
  { name: "hunt", description: "Hunt a level-fit monster, or name one", options: [text("monster", "e.g. goblin")], twitch: (a) => `!hunt ${a.s("monster")}` },
  { name: "ledger", description: "Level, HP, AC, XP, coin and gear", options: [user()], twitch: (a) => `!ledger ${a.u("user")}` },
  { name: "bounties", description: "The shared bounty board", twitch: () => "!bounties" },
  { name: "shop", description: "The stall's wares, or one ware's details", options: [text("item", "A ware's number or name")], twitch: (a) => `!shop ${a.s("item")}` },
  { name: "buy", description: "Buy from the stall", options: [text("items", "e.g. 1, 1 3, or all", true)], twitch: (a) => `!buy ${a.s("items")}` },
  { name: "inv", description: "Your gear and leftover potions", twitch: () => "!inv" },
  { name: "sell", description: "Sell a leftover potion for half its price", options: [text("potion", "Which potion", true)], twitch: (a) => `!sell ${a.s("potion")}` },
  { name: "drop", description: "Throw away a leftover potion", options: [text("potion", "Which potion", true)], twitch: (a) => `!drop ${a.s("potion")}` },
  { name: "purse", description: "Your coin and the cheapest ware it buys", twitch: () => "!purse" },

  // ── Gold & giveaways ──
  {
    name: "gold",
    description: "Coin: purses, the leaderboard, gifts",
    hint: { bare: "balance", user: "balance" },
    subcommands: [
      { name: "balance", description: "Your purse and rank, or someone else's", options: [user()], twitch: (a) => `!gold ${a.u("user")}` },
      { name: "top", description: "Richest adventurers", options: [{ name: "count", description: "How many (max 10)", type: "integer" }], twitch: (a) => `!gold top ${a.s("count")}` },
      { name: "today", description: "Gold gained or lost today", options: [user(), flag("all", "Everyone, biggest gains first")], twitch: (a) => a.b("all") ? "!gold today all" : `!gold today ${a.u("user")}` },
      { name: "give", description: "Gift some of your coin", options: [user("To whom", true), text("amount", "e.g. 50, 5sp, 1gp 2sp", true)], twitch: (a) => `!gold give ${a.u("user")} ${a.s("amount")}` },
      { name: "add", description: "Add to a purse (moderators)", options: [user("Whose", true), text("amount", "e.g. 2gp", true)], twitch: (a) => `!gold add ${a.u("user")} ${a.s("amount")}` },
      { name: "remove", description: "Take from a purse (moderators)", options: [user("Whose", true), text("amount", "e.g. 2gp", true)], twitch: (a) => `!gold remove ${a.u("user")} ${a.s("amount")}` },
      { name: "set", description: "Set a purse (moderators)", options: [user("Whose", true), text("amount", "e.g. 2gp", true)], twitch: (a) => `!gold set ${a.u("user")} ${a.s("amount")}` },
      { name: "list", description: "Link to the treasury page", twitch: () => "!gold list" },
    ],
  },
  {
    name: "giveaway",
    description: "Giveaways paid in coin",
    hint: { bare: "show" },
    subcommands: [
      { name: "show", description: "The current giveaway", twitch: () => "!giveaway" },
      { name: "enter", description: "Enter", options: [{ name: "tickets", description: "How many tickets (paid giveaways)", type: "integer" }], twitch: (a) => `!giveaway enter ${a.s("tickets")}` },
      {
        name: "start",
        description: "Open a giveaway (moderators)",
        options: [text("prize", "The prize", true), text("cost", "Ticket price, e.g. 5sp"), { name: "max", description: "Most tickets per person", type: "integer" }],
        twitch: (a) => `!giveaway start ${a.s("cost") ? `cost=${a.s("cost").replace(/\s+/g, "")}` : ""} ${a.s("max") ? `max=${a.s("max")}` : ""} ${a.s("prize")}`,
      },
      ...words("giveaway", [["draw", "Pick a winner (moderators)"], ["reroll", "Draw again (moderators)"], ["cancel", "Call it off and refund (moderators)"]]),
    ],
  },
  {
    name: "gamble",
    description: "Dragon's Dice: bet gold and out-roll the dragon (ties go to the dragon)",
    options: [
      text("amount", "e.g. 50, 5sp, 1gp, or all", true),
      { name: "die", description: "Small dice tie more but pay more: d4 1.5x … d20 even money", required: true, choices: ["d4", "d6", "d8", "d10", "d12", "d20"] },
    ],
    twitch: (a) => `!gamble ${a.s("amount")} ${a.s("die")}`,
  },
  { name: "bribe", description: "Bribe someone. It never works.", options: [text("whom", "Whom to bribe (default: the town guard)")], twitch: (a) => `!bribe ${a.s("whom")}` },

  // ── Fun, questions and quotes ──
  {
    name: "fun",
    description: "Coin flips, table flips, dad jokes, animal facts and pictures",
    subcommands: [
      { name: "coinflip", description: "Heads or tails", twitch: () => "!coinflip" },
      { name: "flip", description: "Flip a table, or some text upside down", options: [text("text", "Text to flip (default: the table)")], twitch: (a) => `!flip ${a.s("text")}` },
      { name: "angryflip", description: "Flip it, angrily", options: [text("text", "Text to flip")], twitch: (a) => `!angryflip ${a.s("text")}` },
      { name: "unflip", description: "Put the table back", twitch: () => "!unflip" },
      { name: "jumble", description: "Scramble the letters of each word", options: [text("text", "What to jumble", true)], twitch: (a) => `!jumble ${a.s("text")}` },
      { name: "dadjoke", description: "A dad joke", twitch: () => "!dadjoke" },
      { name: "tempc", description: "°F to °C", options: [text("fahrenheit", "e.g. 72", true)], twitch: (a) => `!tempc ${a.s("fahrenheit")}` },
      { name: "tempf", description: "°C to °F", options: [text("celsius", "e.g. 22", true)], twitch: (a) => `!tempf ${a.s("celsius")}` },
      {
        name: "fact",
        description: "An animal fact",
        options: [{ name: "animal", description: "Which animal (default: any)", choices: ["cat", "dog", "otter", "penguin", "sloth", "owl", "shark", "frog", "cow", "duck", "fox", "panda", "capybara", "axolotl", "bee", "dolphin", "wolf", "raccoon", "octopus"] }],
        twitch: (a) => a.s("animal") ? `!${a.s("animal")}fact` : "!animalfact",
      },
      {
        name: "pic",
        description: "A random animal picture",
        options: [{ name: "animal", description: "Which animal", required: true, choices: ["cat", "dog", "fox", "duck", "capybara"] }],
        twitch: (a) => `!${a.s("animal")}pic`,
      },
    ],
  },
  { name: "askme", description: "Ask anything: a short answer from Wikipedia (and game wikis), with the source", options: [text("question", "e.g. how far away is the moon?", true)], twitch: (a) => `!askme ${a.s("question")}` },
  {
    name: "quote",
    description: "The server's book of memorable lines",
    hint: { bare: "random", arg: "show" },
    subcommands: [
      { name: "random", description: "A random quote", twitch: () => "!quote" },
      { name: "show", description: "A quote by number, or a random one with these words", options: [text("which", "A number or some words", true)], twitch: (a) => `!quote ${a.s("which")}` },
      { name: "count", description: "How many quotes there are", twitch: () => "!quotes" },
      { name: "add", description: "Add a quote (moderators)", options: [text("text", "The quote, e.g. \"I meant to do that\" — Bob", true)], twitch: (a) => `!quote add ${a.s("text")}` },
      {
        name: "edit",
        description: "Reword a quote (moderators)",
        options: [{ name: "number", description: "Which quote", type: "integer", required: true }, text("text", "The new wording", true)],
        twitch: (a) => `!quote edit ${a.s("number")} ${a.s("text")}`,
      },
      { name: "remove", description: "Delete a quote (moderators)", options: [{ name: "number", description: "Which quote", type: "integer", required: true }], twitch: (a) => `!quote remove ${a.s("number")}` },
    ],
  },

  // ── World of Warcraft: Forever (wow.ts) ──
  {
    name: "wow",
    description: "World of Warcraft: Forever: launch countdown, raid signups, invites and attendance",
    subcommands: [
      { name: "forever", description: "Countdown to the World of Warcraft: Forever launch", twitch: () => "!wow:forever" },
      {
        name: "character",
        description: "Set your main, shown on raid rosters",
        options: [text("name", "Character name", true), text("class", "e.g. Warrior, Priest, Shaman"), { name: "role", description: "What you usually play", choices: ["tank", "healer", "dps"] }],
        local: "wow.character",
      },
      { name: "stats", description: "Raids attended, no-shows, roles and loot", options: [user("Whose (default: yours)")], local: "wow.stats" },
      { name: "top", description: "Most raids attended in this server", local: "wow.top" },
      {
        name: "timezone",
        description: "The server's default raid timezone and reminder time (moderators change them)",
        options: [
          { name: "zone", description: "Default timezone for raid times", choices: WOW_ZONES },
          { name: "remind", description: "Minutes before a raid to remind signups (0 = off)", type: "integer", min: 0, max: 1440 },
        ],
        local: "wow.timezone",
      },
    ],
    groups: [
      {
        name: "raid",
        description: "Raid and party nights",
        subcommands: [
          {
            name: "create",
            description: "Post a raid or party with signup buttons",
            options: [
              text("title", "e.g. Molten Core, Onyxia, Deadmines run", true),
              text("when", "e.g. fri 8pm, tomorrow 19:30, 11/8 8:30pm, in 2h", true),
              { name: "size", description: "How many (default 10)", choices: WOW_SIZES },
              { name: "timezone", description: "Timezone for when (default: the server's, see /wow timezone)", choices: WOW_ZONES },
              slot("tanks", "Tank slots (default by size)"),
              slot("healers", "Healer slots (default by size)"),
              slot("dps", "DPS slots (default by size)"),
              text("notes", "Anything else: requirements, meeting spot, consumables"),
              { name: "ping", description: "A role to ping on the post, e.g. @Raiders", type: "role" },
              { name: "channel", description: "Where to post it (default: here)", type: "channel" },
            ],
            local: "wow.raid.create",
          },
          { name: "list", description: "Upcoming raids and the last few", local: "wow.raid.list" },
          { name: "view", description: "A raid's card", options: [raid()], local: "wow.raid.view" },
          {
            name: "invite",
            description: "Invite members: a DM with signup buttons, and a ping here",
            options: [raid(), user("Who to invite"), text("members", "Or several at once: paste @mentions")],
            local: "wow.raid.invite",
          },
          {
            name: "edit",
            description: "Change a raid's time, name, notes or slots (leader)",
            options: [
              raid(), text("when", "New start time"), { name: "timezone", description: "Timezone for when", choices: WOW_ZONES }, text("title", "New name"),
              text("notes", "New notes (- clears them)"), { name: "size", description: "New size", choices: WOW_SIZES },
              slot("tanks", "Tank slots"), slot("healers", "Healer slots"), slot("dps", "DPS slots"),
            ],
            local: "wow.raid.edit",
          },
          { name: "remove", description: "Take someone off the signups (leader)", options: [raid(), user("Who", true)], local: "wow.raid.remove" },
          { name: "cancel", description: "Call a raid off; signups get a DM (leader)", options: [raid(), text("reason", "Why (goes in the DM)")], local: "wow.raid.cancel" },
          { name: "complete", description: "Close a raid out now: everyone in counts as there (leader)", options: [raid()], local: "wow.raid.complete" },
          {
            name: "attendance",
            description: "Fix who showed up, after a raid (leader)",
            options: [raid(), user("Who", true), { name: "status", description: "What happened", required: true, choices: [["Showed up", "present"], ["No-show", "noshow"], ["Take off the list", "remove"]] }],
            local: "wow.raid.attendance",
          },
          { name: "loot", description: "Record a drop handed out (leader)", options: [raid(), user("Who got it", true), text("item", "e.g. Thunderfury", true)], local: "wow.raid.loot" },
        ],
      },
    ],
  },

  // ── Go-live alerts (live.ts) ──
  {
    name: "live",
    description: "Post in a channel when a Twitch streamer goes live",
    subcommands: [
      {
        name: "add",
        description: "Watch a streamer, or change their alert (moderators)",
        options: [
          text("streamer", "Their Twitch name or channel link, e.g. twitch.tv/name", true),
          { name: "channel", description: "Where the alert goes (default: here)", type: "channel" },
          { name: "ping", description: "A role to ping, e.g. @Stream Alerts (pick @everyone for everyone)", type: "role" },
          text("message", "Text above the card: {streamer} {title} {game} {url} (- for the default)"),
        ],
        local: "live.add",
      },
      { name: "remove", description: "Stop watching a streamer (moderators)", options: [streamer()], local: "live.remove" },
      { name: "list", description: "Who this server watches, and who's live now", local: "live.list" },
      { name: "test", description: "Post a streamer's alert now, to see how it looks (moderators)", options: [streamer()], local: "live.test" },
    ],
  },

  // ── Market ──
  {
    name: "market",
    description: "The wandering merchant who posts wares in the server (moderators)",
    subcommands: words("market", [["on", "Let the merchant post"], ["off", "Send the merchant away"], ["status", "Is the merchant around?"], ["now", "Post a ware now"]]),
  },
  { name: "haggle", description: "Haggle with the merchant over the ware on offer", options: [text("pitch", "Your offer and your best argument", true)], twitch: (a) => `!haggle ${a.s("pitch")}` },
  { name: "stall", description: "The ware on offer and your haggle attempts left", twitch: () => "!stall" },
];

// ── Building the Discord registration payload ──

const OPTION_TYPES: Record<OptionType, number> = { string: 3, integer: 4, boolean: 5, user: 6, channel: 7, role: 8 };

function optionPayload(o: Option) {
  const value = (v: string) => o.type === "integer" ? Number(v) : v;
  return {
    type: OPTION_TYPES[o.type ?? "string"],
    name: o.name,
    description: o.description.slice(0, 100),
    required: o.required ?? false,
    ...(o.choices ? { choices: o.choices.map((c) => Array.isArray(c) ? { name: c[0], value: value(c[1]) } : { name: c, value: value(c) }) } : {}),
    ...(o.autocomplete ? { autocomplete: true } : {}),
    ...(o.min !== undefined ? { min_value: o.min } : {}),
    ...(o.max !== undefined ? { max_value: o.max } : {}),
    ...(o.type === "channel" ? { channel_types: [0, 5] } : {}),
  };
}

function leafPayload(l: Leaf, type?: number) {
  // Required options must come before optional ones.
  const opts = [...(l.options ?? [])].sort((a, b) => Number(b.required ?? false) - Number(a.required ?? false));
  return { ...(type ? { type } : {}), name: l.name, description: l.description.slice(0, 100), options: opts.map(optionPayload) };
}

/** The JSON body for PUT /applications/{id}/commands. */
export function registrationPayload() {
  return COMMANDS.map((c) => {
    const base = { name: c.name, description: c.description.slice(0, 100), contexts: [0], integration_types: [0] };
    if (!c.subcommands && !c.groups) return { ...base, ...leafPayload(c) };
    return {
      ...base,
      options: [
        ...(c.subcommands ?? []).map((s) => leafPayload(s, 1)),
        ...(c.groups ?? []).map((g) => ({ type: 2, name: g.name, description: g.description, options: g.subcommands.map((s) => leafPayload(s, 1)) })),
      ],
    };
  });
}

/** Finds what an invocation ran: the leaf and its own options. */
export function resolveInvocation(data: any): { command: Command; leaf: Leaf; path: string[]; options: any[] } | null {
  const command = COMMANDS.find((c) => c.name === data?.name);
  if (!command) return null;
  let options: any[] = data.options ?? [];
  const path = [command.name];
  let leaf: Leaf = command;
  const group = options[0]?.type === 2 ? command.groups?.find((g) => g.name === options[0].name) : undefined;
  if (group) {
    path.push(group.name);
    options = options[0].options ?? [];
  }
  if (options[0]?.type === 1) {
    const list = group ? group.subcommands : command.subcommands ?? [];
    const sub = list.find((s) => s.name === options[0].name);
    if (!sub) return null;
    path.push(sub.name);
    leaf = sub;
    options = options[0].options ?? [];
  } else if (command.subcommands || command.groups) {
    return null;
  }
  return { command, leaf, path, options };
}

// ── "!command" hints in replies → slash commands ──

/** Multi-word and renamed Twitch commands first; then every command named the same on both. */
const RENAMES: Array<[string, string]> = [
  ["!dndduel party hunt", "/duel hunt"],
  ["!party hunt", "/duel hunt"],
  ["!dndduel party", "/duel party"],
  ["!dndduel monster", "/duel monster"],
  ["!dndduel classic", "/duel player"],
  ["!dndduel", "/duel"],
  ["!gold on", "/guildscribe feature name:gold state:on"],
  ["!gold off", "/guildscribe feature name:gold state:off"],
  ["!autohuntstatus", "/autohunt status"],
  ["!autohuntstop", "/autohunt stop"],
  ["!goldboard", "/gold top"],
  ["!treasury", "/gold list"],
  ["!huntcd", "/huntcooldown"],
  ["!quests", "/bounties"],
  ["!merchant", "/shop"],
  ["!inventory", "/inv"],
  ["!coinpurse", "/purse"],
  ["!rules", "/rule"],
  ["!r", "/roll"],
  ["!dndbothelp", "/help"],
  ["!guide", "/help"],
  ["!link", "/help"],
  ["!commands", "/help"],
  ["!div2build", "/div2 build"],
  ["!div2loot", "/div2 loot"],
  ["!div2mission", "/div2 mission"],
  ["!div2lookup", "/div2 lookup"],
  ["!div2", "/div2 list"],
  ["!wow:forever", "/wow forever"],
  ["!wowforever", "/wow forever"],
  ["!quote add", "/quote add"],
  ["!quote edit", "/quote edit"],
  ["!quote remove", "/quote remove"],
  ["!addquote", "/quote add"],
  ["!delquote", "/quote remove"],
  ["!quotes", "/quote count"],
  ["!coinflip", "/fun coinflip"],
  ["!angryflip", "/fun angryflip"],
  ["!unflip", "/fun unflip"],
  ["!flip", "/fun flip"],
  ["!jumble", "/fun jumble"],
  ["!dadjoke", "/fun dadjoke"],
  ["!tempc", "/fun tempc"],
  ["!tempf", "/fun tempf"],
  ["!animalfact", "/fun fact"],
];

function hintRegex(twitch: string): RegExp {
  const body = twitch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // After start, whitespace or opening punctuation; a word must end where the command does.
  return new RegExp(`(^|[\\s(\\[“"'‘—|:])${body}${/[\w]$/.test(twitch) ? "(?![\\w])" : ""}`, "gi");
}

export const TWITCH_TO_SLASH: Array<[RegExp, string]> = (() => {
  const pairs: Array<[string, string]> = [...RENAMES];
  // "!gold give" → "/gold give", "!party join" → "/party join": a subcommand word after the command stays.
  const renamed = new Set(RENAMES.map(([t]) => t));
  for (const c of COMMANDS) {
    if (c.local || renamed.has(`!${c.name}`)) continue;
    pairs.push([`!${c.name}`, `/${c.name}`]);
  }
  // Longest first so "!dndduel party hunt" wins over "!dndduel".
  pairs.sort((a, b) => b[0].length - a[0].length);
  return pairs.map(([t, s]) => [hintRegex(t), s]);
})();

const SUBCOMMANDS = new Map(COMMANDS.map((c) => [c.name, new Set([...(c.subcommands ?? []), ...(c.groups ?? [])].map((s) => s.name))]));
const HINTS = new Map(COMMANDS.filter((c) => c.hint).map((c) => [c.name, c.hint!]));

/** "!dndduel party hunt" → "/duel hunt", "!rally" → "/rally join", "!dndduel goblin" → "/duel monster goblin". */
export function slashHints(text: string): string {
  for (const [re, slash] of TWITCH_TO_SLASH) text = text.replace(re, (_m, pre: string) => `${pre}${slash}`);
  // A command with subcommands needs one; pick it from what follows the hint.
  return text.replace(/(^|[\s(\[“"'‘—|:])\/([a-z0-9]+)(?:(\s+)(\S+))?/g, (whole, pre: string, name: string, sp?: string, next?: string) => {
    const hint = HINTS.get(name);
    if (!hint || (next && SUBCOMMANDS.get(name)!.has(next.toLowerCase()))) return whole;
    const tail = next ? `${sp}${next}` : "";
    const sub = next && /^(?:@|<@)/.test(next) ? hint.user : next && /^[\w]/.test(next) && hint.arg ? hint.arg : hint.bare;
    return sub ? `${pre}/${name} ${sub}${tail}` : whole;
  });
}
