// Runs real slash commands through the whole pipeline — option parsing,
// the Twitch game handlers, reply rewriting — against a throwaway database,
// with no Discord connection. `deno task test`; set SHOW=1 to print replies.

import { assert, assertEquals, assertMatch } from "@std/assert";

const dir = Deno.makeTempDirSync({ prefix: "guildscribe-discord-test-" });
Deno.env.set("DB_PATH", `${dir}/test.sqlite`);
Deno.env.set("PUBLIC_BASE_URL", "https://discord.example.test");
Deno.env.set("COMMAND_COOLDOWN_MS", "250");

const { ensureSchema } = await import("../schema.ts");
const { COMMANDS, resolveInvocation, registrationPayload } = await import("../commands.ts");
const { ensureGuild } = await import("../guild.ts");
const { loginFor, rememberMember, toDiscordText, userIdFor } = await import("../identity.ts");
const { runInteraction } = await import("../game/scope.ts");
const { runGameCommand } = await import("../router.ts");
const { handler } = await import("../server.ts");

await ensureSchema();

const GUILD = "111111111111111111";
const ALICE = { userId: "222222222222222222", display: "Alice" };
const BOB = { userId: "333333333333333333", display: "Bob the Bold" };
const show = Deno.env.get("SHOW") === "1";

await ensureGuild(GUILD, "444444444444444444");
for (const m of [ALICE, BOB]) await rememberMember(GUILD, { ...m, login: loginFor(m.userId) });

/** Builds an interaction's data the way Discord sends it: "/duel party challenge yours:a theirs:b". */
function data(path: string, opts: Record<string, string | number | boolean> = {}) {
  const [name, ...rest] = path.split(" ");
  const options = Object.entries(opts).map(([k, v]) => ({ name: k, type: typeof v === "boolean" ? 5 : typeof v === "number" ? 4 : 3, value: v }));
  if (!rest.length) return { name, options };
  if (rest.length === 1) return { name, options: [{ type: 1, name: rest[0], options }] };
  return { name, options: [{ type: 2, name: rest[0], options: [{ type: 1, name: rest[1], options }] }] };
}

/** Runs one slash command as `who` and returns the Discord text of the reply. */
async function run(who: typeof ALICE, path: string, opts: Record<string, string | number | boolean> = {}, moderator = true): Promise<string> {
  const found = resolveInvocation(data(path, opts));
  assert(found, `no such command: /${path}`);
  const a = {
    s: (n: string) => (opts[n] === undefined ? "" : String(opts[n])),
    u: (n: string) => (opts[n] ? `@${loginFor(String(opts[n]))}` : ""),
    b: (n: string) => opts[n] === true,
    id: (n: string) => (opts[n] === undefined ? "" : String(opts[n])),
  };
  const text = found.leaf.twitch!(a);
  const login = loginFor(who.userId);
  const { replies } = await runInteraction({ guildId: GUILD, userId: who.userId, login, display: who.display }, () =>
    runGameCommand({ guildId: GUILD, login, display: who.display, isModerator: moderator, text }));
  const out = (await Promise.all(replies.map((r) => toDiscordText(GUILD, r.text, { base: "https://discord.example.test" })))).join("\n");
  if (show) console.log(`\n/${path} ${JSON.stringify(opts)}  →  ${text}\n${out}`);
  await new Promise((r) => setTimeout(r, 260)); // the per-member command cooldown
  return out;
}

Deno.test("logins round-trip through user IDs and fit Twitch's login shape", () => {
  for (const id of ["80351110224678912", "1234567890123456789", "18446744073709551615"]) {
    const login = loginFor(id);
    assertMatch(login, /^[a-z0-9_]{1,25}$/);
    assertEquals(userIdFor(login), id);
  }
});

Deno.test("every command registers within Discord's limits", () => {
  const payload = registrationPayload();
  assert(payload.length <= 100, `${payload.length} commands`);
  for (const c of payload as any[]) {
    assertMatch(c.name, /^[a-z0-9_-]{1,32}$/);
    assert(c.description.length <= 100, c.name);
    assert((c.options ?? []).length <= 25, c.name);
  }
  assertEquals(new Set(COMMANDS.map((c) => c.name)).size, COMMANDS.length);
});

Deno.test("characters, dice and lookups", async () => {
  const created = await run(ALICE, "createchar", {}, false);
  assertMatch(created, /<@222222222222222222> created a level 1/);
  assert(!created.includes("?user="), "character-sheet links are dropped");
  assertMatch(await run(BOB, "createchar", {}, false), /created a level 1/);
  assertMatch(await run(ALICE, "char", {}, false), /level 1|Lv ?1|L1/i);
  const bobSheet = await run(ALICE, "char", { user: BOB.userId }, false);
  assertMatch(bobSheet, /<@333333333333333333>/);
  assert(!/&channel=|\?user=/.test(bobSheet), bobSheet);
  assertMatch(await run(ALICE, "abilities", {}, false), /AC/);
  assertMatch(await run(ALICE, "roll", { what: "2d6+3" }, false), /\d/);
  assertMatch(await run(ALICE, "save", { check: "dex" }, false), /Saving Throw/);
  assertMatch(await run(ALICE, "fate", { question: "will the dragon win" }, false), /./);
  assertMatch(await run(ALICE, "d20", {}, false), /\d/);
  assertMatch(await run(ALICE, "rollcall", {}, false), /./);
  assertMatch(await run(ALICE, "bg3lookup", { query: "astarion" }, false), /Astarion/i);
  assertMatch(await run(ALICE, "bg3roll", {}, false), /./);
  assertMatch(await run(ALICE, "div2 build", {}, false), /./);
  assertMatch(await run(ALICE, "oracle", { question: "who leads?" }, false), /who leads\?/);
});

Deno.test("parties, duels, hunts and the bestiary", async () => {
  assertMatch(await run(ALICE, "party create", { name: "crew" }, false), /crew/i);
  assertMatch(await run(ALICE, "party invite", { user: BOB.userId, name: "crew" }, false), /invit/i);
  assertMatch(await run(BOB, "party accept", { name: "crew" }, false), /crew/i);
  assertMatch(await run(ALICE, "party list", {}, false), /crew/i);
  const pvp = await run(ALICE, "duel player", { user: BOB.userId }, false);
  assertMatch(pvp, /challenge|duel/i);
  assertMatch(await run(BOB, "duel accept", {}, false), /wins|won|victor|defeat/i);
  assertMatch(await run(ALICE, "duel monster", { monster: "goblin" }, false), /goblin/i);
  assertMatch(await run(ALICE, "bestiary show", { monster: "goblin" }, false), /goblin/i);
  const page = await run(ALICE, "bestiary page", {}, false);
  assertMatch(page, /https:\/\/discord\.example\.test\/bestiary\?channel=111111111111111111/);
  assertMatch(await run(ALICE, "turn start", {}), /initiative|encounter/i);
  assertMatch(await run(ALICE, "turn roll", {}, false), /initiative/i);
  assertMatch(await run(BOB, "turn roll", {}, false), /Bob the Bold|<@333333333333333333>/);
  assertMatch(await run(ALICE, "turn end", {}), /ended/i);
});

Deno.test("gold, rob, Hunt and Hoard, autohunt, raids", async () => {
  assertMatch(await run(ALICE, "gold add", { user: ALICE.userId, amount: "5gp" }), /gp/);
  assertMatch(await run(ALICE, "gold add", { user: BOB.userId, amount: "5gp" }), /gp/);
  assertMatch(await run(ALICE, "gold balance", {}, false), /gp/);
  assertMatch(await run(ALICE, "gold give", { user: BOB.userId, amount: "1gp" }, false), /gp/);
  assertMatch(await run(ALICE, "gold top", {}, false), /Alice|Bob/);
  assertMatch(await run(ALICE, "rob", { user: BOB.userId }, false), /./);
  assertMatch(await run(ALICE, "hoard", {}, false), /./);
  assertMatch(await run(ALICE, "shop", {}, false), /./);
  assertMatch(await run(ALICE, "bounties", {}, false), /./);
  assertMatch(await run(ALICE, "purse", {}, false), /./);
  assertMatch(await run(ALICE, "autohunt start", { duration: "20m" }, false), /./);
  assertMatch(await run(ALICE, "autohunt stop", {}, false), /./);
  assertMatch(await run(ALICE, "rally new", {}), /raid|boss/i);
  assertMatch(await run(ALICE, "rally status", {}, false), /HP|boss/i);
  assertMatch(await run(ALICE, "giveaway start", { prize: "a shiny sword", cost: "1sp" }), /giveaway/i);
  assertMatch(await run(BOB, "giveaway enter", {}, false), /./);
  assertMatch(await run(ALICE, "giveaway draw", {}), /<@333333333333333333>/);
  assertMatch(await run(ALICE, "bribe", {}, false), /./);
});

Deno.test("switched-off features say so", async () => {
  const { setFeature } = await import("../guild.ts");
  await setFeature(GUILD, "dice", false);
  assertMatch(await run(ALICE, "d20", {}, false), /switched off.*\/guildscribe feature name:dice/);
  await setFeature(GUILD, "dice", true);
});

Deno.test("Dragon's Dice starts off, then bets gold on the chosen die", async () => {
  const { setFeature } = await import("../guild.ts");
  const { setBalance } = await import("../game/points_db.ts");
  assertMatch(await run(BOB, "gamble", { amount: "5sp", die: "d6" }, false), /switched off.*\/guildscribe feature name:gamble state:on/);
  await setFeature(GUILD, "gamble", true);
  await setBalance(GUILD, loginFor(BOB.userId), BOB.display, 100);
  assertMatch(await run(BOB, "gamble", { amount: "5gp", die: "d6" }, false), /only have 1 gp/);
  assertMatch(await run(BOB, "gamble", { amount: "5sp", die: "d20" }, false), /dragon/i);
  assertMatch(await run(BOB, "gamble", { amount: "1sp", die: "d4" }, false), /try again in \d+s/);
  await setFeature(GUILD, "gamble", false);
});

Deno.test("fun, quotes, the WoW countdown, and any chat command through /gs", async () => {
  assertMatch(await run(ALICE, "fun coinflip", {}, false), /heads|tails/i);
  assertEquals(await run(ALICE, "fun flip", { text: "hello" }, false), "ollǝɥ");
  assertMatch(await run(ALICE, "quote add", { text: "\"I meant to do that\" — Bob" }), /#1/);
  assertMatch(await run(BOB, "quote show", { which: "1" }, false), /I meant to do that/);
  assertMatch(await run(BOB, "quote count", {}, false), /1 quote/);
  assertMatch(await run(ALICE, "wow forever", {}, false), /World of Warcraft: Forever/);
  // A chat command with no slash command of its own, with or without the "!".
  assertMatch(await run(ALICE, "gs", { command: "!unflip" }, false), /┬─┬/);
  assertMatch(await run(ALICE, "gs", { command: "wow:forever" }, false), /World of Warcraft: Forever/);
  assertEquals(await toDiscordText(GUILD, "Try !wow:forever or !coinflip"), "Try /wow forever or /fun coinflip");
});

Deno.test("replies use slash commands, not Twitch chat commands", async () => {
  const text = await toDiscordText(GUILD, "Try !dndduel party hunt attack, !createchar or !gold give @u1 5sp — and !party hunt crew.");
  assertEquals(text, "Try /duel hunt attack, /createchar or /gold give @u1 5sp — and /duel hunt crew.");
  assertEquals(await toDiscordText(GUILD, "Hunt: !dndduel goblin. Type !rally to join; !bestiary goblin; see !bestiary; !gold @u1"),
    "Hunt: /duel monster goblin. Type /rally join to join; /bestiary show goblin; see /bestiary page; /gold balance @u1");
  assertEquals(await toDiscordText(GUILD, "Robbing is off (!gold on)"), "Robbing is off (/guildscribe feature name:gold state:on)");
});

Deno.test("the interactions endpoint answers a signed PING and rejects a forged one", async () => {
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
  Deno.env.set("DISCORD_PUBLIC_KEY", [...raw].map((b) => b.toString(16).padStart(2, "0")).join(""));
  const body = JSON.stringify({ type: 1 });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, keys.privateKey, new TextEncoder().encode(timestamp + body)));
  const hex = [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
  const ok = await handler(new Request("https://discord.example.test/interactions", { method: "POST", body, headers: { "X-Signature-Ed25519": hex, "X-Signature-Timestamp": timestamp } }));
  assertEquals(await ok.json(), { type: 1 });
  const forged = await handler(new Request("https://discord.example.test/interactions", { method: "POST", body, headers: { "X-Signature-Ed25519": "00".repeat(64), "X-Signature-Timestamp": timestamp } }));
  assertEquals(forged.status, 401);
});

Deno.test("the bestiary, treasury and gear pages render with member names", async () => {
  for (const path of ["bestiary", "gold", "gear"]) {
    const res = await handler(new Request(`https://discord.example.test/${path}?channel=${GUILD}`));
    assertEquals(res.status, 200, path);
    const html = await res.text();
    assert(!/\bu[0-9a-z]{10,13}\b/.test(html.replace(/\?channel=\d+/g, "")), `${path} shows a raw login`);
    if (path === "gold") assertMatch(html, /Alice/);
  }
});

/** Signs an interaction like Discord does, with a key generated for the test. */
async function signed(body: unknown) {
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
  Deno.env.set("DISCORD_PUBLIC_KEY", [...raw].map((b) => b.toString(16).padStart(2, "0")).join(""));
  const text = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, keys.privateKey, new TextEncoder().encode(timestamp + text)));
  return new Request("https://discord.example.test/interactions", {
    method: "POST",
    body: text,
    headers: { "X-Signature-Ed25519": [...sig].map((b) => b.toString(16).padStart(2, "0")).join(""), "X-Signature-Timestamp": timestamp },
  });
}

Deno.test("a slash command is deferred, then answered through the interaction webhook", async () => {
  const sent: Array<{ method: string; url: string; body: any }> = [];
  const realFetch = globalThis.fetch;
  let done: () => void;
  const answered = new Promise<void>((r) => done = r);
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://discord.com/")) return realFetch(input, init);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    sent.push({ method: init?.method ?? "GET", url, body });
    if (url.includes("/messages/@original")) done();
    return Promise.resolve(new Response(JSON.stringify({ id: "1", name: "Test Server" }), { status: 200, headers: { "Content-Type": "application/json" } }));
  }) as typeof fetch;
  Deno.env.set("DISCORD_BOT_TOKEN", "test-token");
  try {
    const res = await handler(await signed({
      type: 2,
      application_id: "999999999999999999",
      token: "interaction-token",
      guild_id: GUILD,
      channel_id: "444444444444444444",
      member: { user: { id: BOB.userId, username: "bob", global_name: "Bob the Bold" }, permissions: "0" },
      data: { name: "rob", options: [{ name: "user", type: 6, value: ALICE.userId }], resolved: { users: { [ALICE.userId]: { id: ALICE.userId, username: "alice", global_name: "Alice" } } } },
    }));
    assertEquals(await res.json(), { type: 5 });
    await answered;
    const edit = sent.find((s) => s.url.endsWith("/webhooks/999999999999999999/interaction-token/messages/@original"))!;
    assertEquals(edit.method, "PATCH");
    const content: string = edit.body.content ?? JSON.parse(String((edit.body as FormData).get("payload_json"))).content;
    if (show) console.log(content);
    assertMatch(content, /<@333333333333333333>/);
    assertEquals((edit.body.allowed_mentions ?? JSON.parse(String((edit.body as FormData).get("payload_json"))).allowed_mentions).parse, []);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("start-up registers the slash commands only when they've changed", async () => {
  const { registerIfChanged } = await import("../server.ts");
  const puts: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    puts.push(`${init?.method} ${String(input)}`);
    return Promise.resolve(new Response(JSON.stringify(JSON.parse(String(init?.body))), { status: 200 }));
  }) as typeof fetch;
  Deno.env.set("DISCORD_APPLICATION_ID", "999999999999999999");
  Deno.env.set("DISCORD_BOT_TOKEN", "test-token");
  try {
    assert(await registerIfChanged());
    assertEquals(puts, ["PUT https://discord.com/api/v10/applications/999999999999999999/commands"]);
    assertEquals(await registerIfChanged(), false);
    assertEquals(puts.length, 1);
  } finally {
    globalThis.fetch = realFetch;
    Deno.env.delete("DISCORD_APPLICATION_ID");
  }
});

Deno.test("archive lookups (dnd5eapi and 5e.tools, needs the internet)", async () => {
  assertMatch(await run(ALICE, "spell", { name: "fireball" }, false), /Fireball/i);
  assertMatch(await run(ALICE, "monster", { name: "goblin" }, false), /Goblin/i);
  assertMatch(await run(ALICE, "rule", { name: "advantage" }, false), /advantage/i);
  assertMatch(await run(ALICE, "class", { name: "wizard" }, false), /Wizard/i);
});

Deno.test("the step-by-step wizard, Wild Shape and the market", async () => {
  assertMatch(await run(BOB, "newchar", {}, false), /Choose a race/);
  assertMatch(await run(BOB, "answer", { choice: "Elf" }, false), /subrace|class/i);
  assertMatch(await run(BOB, "cancel", {}, false), /cancel/i);
  assertMatch(await run(ALICE, "wildshape", { action: "info" }, false), /druid|Wild Shape/i);
  assertMatch(await run(ALICE, "market status", {}), /./);
  assertMatch(await run(ALICE, "stall", {}, false), /./);
  assertMatch(await run(ALICE, "hunt", {}, false), /./);
  assertMatch(await run(ALICE, "ledger", { user: BOB.userId }, false), /Bob the Bold|<@333333333333333333>/);
});

Deno.test("posts with no command to answer go to the server's channel, pinging who they're for", async () => {
  await import("../interactions.ts"); // registers the Discord senders
  const { sendChatMessage } = await import("../game/twitch.ts");
  const { setAnnounceChannel } = await import("../guild.ts");
  const sent: Array<{ url: string; body: any }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as typeof fetch;
  try {
    assert(await sendChatMessage(`@${loginFor(ALICE.userId)} your autohunt is over: 3 wins, 1 loss.`, GUILD));
    assertEquals(sent[0].url, "https://discord.com/api/v10/channels/444444444444444444/messages");
    assertEquals(sent[0].body.content, "<@222222222222222222> your autohunt is over: 3 wins, 1 loss.");
    assertEquals(sent[0].body.allowed_mentions, { parse: [], users: ["222222222222222222"] });
    await setAnnounceChannel(GUILD, "555555555555555555");
    await sendChatMessage("🛒 A peddler sets up shop!", GUILD);
    assertEquals(sent[1].url, "https://discord.com/api/v10/channels/555555555555555555/messages");
  } finally {
    globalThis.fetch = realFetch;
  }
});
