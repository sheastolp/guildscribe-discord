// The community and safety features against a fake Discord, with Gateway
// events handed straight to gateway.ts's dispatch: levels, birthdays,
// raffles, invite tracking, welcome messages, role panels, moderation, the
// honeypot, security, feed alerts and the server log.
// `deno task test`; set SHOW=1 to print replies.

import { assert, assertEquals, assertMatch } from "@std/assert";

const dir = Deno.makeTempDirSync({ prefix: "guildscribe-community-test-" });
Deno.env.set("DB_PATH", `${dir}/test.sqlite`);
Deno.env.set("PUBLIC_BASE_URL", "https://discord.example.test");
Deno.env.set("DISCORD_BOT_TOKEN", "test-token");
Deno.env.set("DISCORD_APPLICATION_ID", "700000000000000000");

const { ensureSchema } = await import("../schema.ts");
const { ensureGuild, setFeature } = await import("../guild.ts");
const { dispatch } = await import("../gateway.ts");
const { forgetGuild } = await import("../guildcache.ts");
const levels = await import("../levels.ts");
const birthdays = await import("../birthdays.ts");
const raffles = await import("../raffles.ts");
const invites = await import("../invites.ts");
const welcome = await import("../welcome.ts");
const selfroles = await import("../selfroles.ts");
const moderation = await import("../moderation.ts");
const honeypot = await import("../honeypot.ts");
const security = await import("../security.ts");
const notify = await import("../notify.ts");
const { resolveInvocation, registrationPayload } = await import("../commands.ts");
const { Perm } = await import("../guildcache.ts");

await ensureSchema();

const GUILD = "711111111111111111";
const CHANNEL = "744444444444444444";
const LOG = "745555555555555555";
const OWNER = "720000000000000001";
const MOD = "720000000000000002";
const ALICE = "720000000000000003";
const BOB = "720000000000000004";
const ROLE_MOD = "760000000000000001";
const ROLE_REGULAR = "760000000000000002";
const ROLE_VIP = "760000000000000003";
const ROLE_RED = "760000000000000004";
const ROLE_BLUE = "760000000000000005";
const ROLE_ADMIN = "760000000000000006";
const SELF = "700000000000000000";
const show = Deno.env.get("SHOW") === "1";
const OLD_USER = "100000000000000000"; // made in 2016

await ensureGuild(GUILD, CHANNEL);
for (const f of ["levels", "birthdays", "raffles", "invites", "notify", "welcome", "selfroles", "moderation", "honeypot", "security"]) await setFeature(GUILD, f, true);

// ── A fake Discord ──

type Call = { method: string; path: string; body: any; reason: string | null };
const calls: Call[] = [];
const memberRoles = new Map<string, string[]>([[MOD, [ROLE_MOD]], [ALICE, []], [BOB, []], [OWNER, []]]);
let liveInvites = [{ code: "alicecode", uses: 3, inviter: { id: ALICE } }, { code: "bobcode", uses: 0, inviter: { id: BOB } }];
let channelMessages: any[] = [];
const feeds = new Map<string, string>();
let nextId = 900000000000000000n;
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const reply = (b: unknown, status = 200) => Promise.resolve(new Response(status === 204 ? null : JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } }));
  if (feeds.has(url.href)) return Promise.resolve(new Response(feeds.get(url.href)!, { status: 200 }));
  if (!url.href.startsWith("https://discord.com/")) return realFetch(input, init);
  const path = url.pathname.replace("/api/v10", "") + url.search;
  const method = init?.method ?? "GET";
  const reason = new Headers(init?.headers).get("X-Audit-Log-Reason");
  calls.push({ method, path, body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body, reason: reason ? decodeURIComponent(reason) : null });
  if (method === "GET" && path.startsWith(`/guilds/${GUILD}?`)) {
    return reply({
      id: GUILD, name: "Test Tavern", owner_id: OWNER, approximate_member_count: 41,
      roles: [
        { id: GUILD, name: "@everyone", permissions: "0", position: 0 },
        { id: ROLE_MOD, name: "Mods", permissions: String(Perm.MANAGE_MESSAGES | Perm.MODERATE_MEMBERS | Perm.KICK_MEMBERS), position: 5 },
        { id: ROLE_REGULAR, name: "Regular", permissions: "0", position: 2 },
        { id: ROLE_VIP, name: "VIP", permissions: "0", position: 3 },
        { id: ROLE_RED, name: "Red", permissions: "0", position: 1 },
        { id: ROLE_BLUE, name: "Blue", permissions: "0", position: 1 },
        { id: ROLE_ADMIN, name: "Admin", permissions: String(Perm.ADMINISTRATOR), position: 8 },
      ],
    });
  }
  const member = path.match(/^\/guilds\/\d+\/members\/(\d+)$/);
  if (method === "GET" && member) return memberRoles.has(member[1]) ? reply({ user: { id: member[1] }, roles: memberRoles.get(member[1]) }) : reply({ message: "Unknown Member" }, 404);
  if (method === "GET" && path === `/guilds/${GUILD}/invites`) return reply(liveInvites);
  if (method === "GET" && path === `/guilds/${GUILD}/vanity-url`) return reply({ code: null });
  if (method === "GET" && path.startsWith(`/channels/${CHANNEL}/messages?`)) return reply(channelMessages);
  if (method === "POST" && path === "/users/@me/channels") return reply({ id: `dm${JSON.parse(String(init?.body)).recipient_id}` });
  if (method === "POST" && /\/channels\/[^/]+\/messages$/.test(path)) return reply({ id: String(nextId++) });
  if (method === "POST" && path === `/guilds/${GUILD}/channels`) return reply({ id: "746666666666666666" });
  return reply({}, 200);
}) as typeof fetch;

const since = (n: number) => calls.slice(n);
const posted = (channelId: string, from = 0) => since(from).filter((c) => c.method === "POST" && c.path === `/channels/${channelId}/messages`);
const dms = (userId: string, from = 0) => since(from).filter((c) => c.method === "POST" && c.path === `/channels/dm${userId}/messages`);
const roleCalls = (method: "PUT" | "DELETE", userId: string, roleId: string, from = 0) => since(from).filter((c) => c.method === method && c.path === `/guilds/${GUILD}/members/${userId}/roles/${roleId}`);

function args(opts: Record<string, string | boolean>) {
  const get = (n: string) => opts[n] === undefined ? "" : String(opts[n]);
  return { s: get, u: get, b: (n: string) => opts[n] === true || opts[n] === "true", id: get };
}

const MOD_PERMS = Perm.MANAGE_MESSAGES | Perm.MODERATE_MEMBERS | Perm.KICK_MEMBERS;
const ALL_PERMS = ~0n;

async function cmd(handler: (k: string, c: any) => Promise<any>, kind: string, opts: Record<string, string | boolean> = {}, who = MOD, perms = who === MOD ? MOD_PERMS : who === OWNER ? ALL_PERMS : 0n) {
  const m = await handler(kind, { guildId: GUILD, channelId: CHANNEL, userId: who, display: who === MOD ? "Mo" : "Someone", moderator: (perms & (Perm.MANAGE_MESSAGES | Perm.MANAGE_GUILD | Perm.ADMINISTRATOR)) !== 0n, permissions: perms, roles: memberRoles.get(who) ?? [], a: args(opts) });
  const text = m.content || JSON.stringify(m.embeds ?? "");
  if (show) console.log(`\n${kind} ${JSON.stringify(opts)}\n${text}`);
  return text as string;
}

let msgId = 1000;
const message = (userId: string, content = "hello", extra: Record<string, unknown> = {}) => ({
  id: String(msgId++), guild_id: GUILD, channel_id: CHANNEL, type: 0, content, author: { id: userId, username: `user${userId.slice(-1)}` },
  member: { roles: memberRoles.get(userId) ?? [] }, mentions: [], mention_roles: [], ...extra,
});

Deno.test("every new command registers and resolves", () => {
  const names = registrationPayload().map((c: any) => c.name);
  for (const n of ["rank", "levels", "birthday", "raffle", "invites", "notify", "welcome", "roles", "mod", "honeypot", "security"]) assert(names.includes(n), n);
  assert(names.length <= 100, "Discord allows 100 commands");
  assert(resolveInvocation({ name: "levels", options: [{ type: 2, name: "reward", options: [{ type: 1, name: "add", options: [] }] }] }));
  assert(resolveInvocation({ name: "mod", options: [{ type: 1, name: "warn", options: [] }] }));
});

Deno.test("levels: the curve, XP for chatting, cooldown, level-ups and rewards", async () => {
  assertEquals(levels.xpToNext(0), 100);
  assertEquals(levels.xpToNext(1), 155);
  assertEquals(levels.levelOf(254).level, 1);
  assertEquals(levels.levelOf(255).level, 2);
  assertEquals(levels.xpForLevel(2), 255);

  assertMatch(await cmd(levels.handleLevelsCommand, "levels.reward.add", { level: "1", role: ROLE_REGULAR }), /level \*\*1\*\* now gives/);
  assertMatch(await cmd(levels.handleLevelsCommand, "levels.reward.add", { level: "2", role: ROLE_VIP }), /level \*\*2\*\*/);
  assertMatch(await cmd(levels.handleLevelsCommand, "levels.settings", { xp_min: "60", xp_max: "60", cooldown: "60", stack: "false" }), /60–60 XP/);
  assertMatch(await cmd(levels.handleLevelsCommand, "levels.reward.add", { level: "3", role: ROLE_RED }, ALICE), /Only moderators/);

  const start = calls.length;
  const t0 = Date.now() + 10_000_000;
  assertEquals(await levels.awardMessage({ guildId: GUILD, channelId: CHANNEL, userId: ALICE, roles: [] }, t0), null); // 60 XP
  assertEquals(await levels.awardMessage({ guildId: GUILD, channelId: CHANNEL, userId: ALICE, roles: [] }, t0 + 1000), null); // cooldown
  assertEquals((await levels.getXp(GUILD, ALICE)).xp, 60);
  assertEquals((await levels.getXp(GUILD, ALICE)).messages, 2);
  assertEquals(await levels.awardMessage({ guildId: GUILD, channelId: CHANNEL, userId: ALICE, roles: [] }, t0 + 61_000), 1); // 120 XP: level 1
  assertMatch(posted(CHANNEL, start).at(-1)!.body.content, /<@720000000000000003> just reached \*\*level 1\*\*/);
  assertEquals(roleCalls("PUT", ALICE, ROLE_REGULAR, start).length, 1);

  // Level 2 with stack off: VIP in, Regular out.
  const mid = calls.length;
  for (let i = 2; i <= 5; i++) await levels.awardMessage({ guildId: GUILD, channelId: CHANNEL, userId: ALICE, roles: [ROLE_REGULAR] }, t0 + i * 61_000);
  assertEquals(levels.levelOf((await levels.getXp(GUILD, ALICE)).xp).level, 2);
  assertEquals(roleCalls("PUT", ALICE, ROLE_VIP, mid).length, 1);
  assertEquals(roleCalls("DELETE", ALICE, ROLE_REGULAR, mid).length, 1);

  // No-XP channel; Gateway messages from bots earn nothing.
  await cmd(levels.handleLevelsCommand, "levels.noxp", { channel: LOG });
  assertEquals(await levels.awardMessage({ guildId: GUILD, channelId: LOG, userId: BOB, roles: [] }, t0), null);
  await dispatch("MESSAGE_CREATE", { ...message(BOB), author: { id: BOB, bot: true } });
  assertEquals((await levels.getXp(GUILD, BOB)).xp, 0);
  await dispatch("MESSAGE_CREATE", message(BOB));
  assertEquals((await levels.getXp(GUILD, BOB)).xp, 60);

  assertMatch(await cmd(levels.handleLevelsCommand, "levels.rank", {}, ALICE), /"Level","value":"2"/);
  const top = await cmd(levels.handleLevelsCommand, "levels.top", {}, BOB);
  assert(top.indexOf(ALICE) < top.indexOf(BOB), "Alice leads");
  assertMatch(await cmd(levels.handleLevelsCommand, "levels.set", { user: BOB, level: "5" }), /level \*\*5\*\*/);
  assertEquals(levels.levelOf((await levels.getXp(GUILD, BOB)).xp).level, 5);
  await setFeature(GUILD, "levels", false);
  assertMatch(await cmd(levels.handleLevelsCommand, "levels.rank", {}, ALICE), /switched off/);
  await setFeature(GUILD, "levels", true);
});

Deno.test("birthdays: saved, wished once on the day with the role, which comes off after", async () => {
  assertMatch(await cmd(birthdays.handleBirthdayCommand, "birthday.set", { month: "2", day: "30" }, ALICE), /no day 30/);
  assertMatch(await cmd(birthdays.handleBirthdayCommand, "birthday.set", { month: "3", day: "5", user: BOB }, ALICE), /Only moderators/);
  assertMatch(await cmd(birthdays.handleBirthdayCommand, "birthday.set", { month: "3", day: "5", year: "1996" }, ALICE), /March 5/);
  assertMatch(await cmd(birthdays.handleBirthdayCommand, "birthday.set", { month: "2", day: "29" }, BOB), /February 29/);
  assertMatch(await cmd(birthdays.handleBirthdayCommand, "birthday.show", { user: ALICE }, BOB), /March 5\*\*/);
  assertMatch(await cmd(birthdays.handleBirthdayCommand, "birthday.setup", { channel: LOG, role: ROLE_RED, message: "🎂 {user} turns {age}!", hour: "9", timezone: "UTC" }), /9am, UTC/);
  assertMatch(await cmd(birthdays.handleBirthdayCommand, "birthday.upcoming", {}, BOB), /March 5 · <@720000000000000003>/);
  assert(birthdays.isBirthdayOn({ month: 2, day: 29 }, 2027, 2, 28));
  assert(!birthdays.isBirthdayOn({ month: 2, day: 29 }, 2028, 2, 28));

  const start = calls.length;
  await birthdays.runBirthdayJobs(Date.UTC(2027, 2, 5, 8, 0)); // before 9am
  assertEquals(posted(LOG, start).length, 0);
  await birthdays.runBirthdayJobs(Date.UTC(2027, 2, 5, 9, 5));
  await birthdays.runBirthdayJobs(Date.UTC(2027, 2, 5, 12, 0)); // once only
  assertEquals(posted(LOG, start).length, 1);
  assertEquals(posted(LOG, start)[0].body.content, "🎂 <@720000000000000003> turns 31!");
  assertEquals(roleCalls("PUT", ALICE, ROLE_RED, start).length, 1);
  await birthdays.runBirthdayJobs(Date.UTC(2027, 2, 5, 23, 59));
  assertEquals(roleCalls("DELETE", ALICE, ROLE_RED, start).length, 0);
  await birthdays.runBirthdayJobs(Date.UTC(2027, 2, 6, 0, 1));
  assertEquals(roleCalls("DELETE", ALICE, ROLE_RED, start).length, 1);
  // 29 February on the 28th in a common year; no age without a year.
  await birthdays.runBirthdayJobs(Date.UTC(2027, 1, 28, 10, 0));
  assertMatch(posted(LOG, start).at(-1)!.body.content, /<@720000000000000004> turns another year!/);
});

function button(customId: string, userId: string, roles: string[] = [], messageId = "1") {
  return { type: 3, application_id: SELF, token: "tok", guild_id: GUILD, channel_id: CHANNEL, message: { id: messageId }, member: { user: { id: userId }, roles }, data: { custom_id: customId } };
}

Deno.test("raffles: a button to enter, a timed draw, a reroll", async () => {
  assertMatch(await cmd(raffles.handleRaffleCommand, "raffle.start", { prize: "Nitro", duration: "soon" }), /isn't a length of time/);
  assertMatch(await cmd(raffles.handleRaffleCommand, "raffle.start", { prize: "Nitro", duration: "1h" }, ALICE), /Only moderators/);
  const start = calls.length;
  assertMatch(await cmd(raffles.handleRaffleCommand, "raffle.start", { prize: "Nitro", duration: "1h", winners: "1", role: ROLE_VIP }), /Raffle \*\*#1\*\* for \*\*Nitro\*\*/);
  const post = posted(CHANNEL, start)[0].body;
  assertEquals(post.components[0].components[0].custom_id, "raffle:1:enter");

  const denied = await (await raffles.handleRaffleButton(button("raffle:1:enter", BOB))).json();
  assertMatch(denied.data.content, /for members with/);
  const entered = await (await raffles.handleRaffleButton(button("raffle:1:enter", ALICE, [ROLE_VIP]))).json();
  assertEquals(entered.type, 7);
  assertEquals(entered.data.components[0].components[0].label, "1");
  await raffles.handleRaffleButton(button("raffle:1:enter", BOB, [ROLE_VIP]));
  const again = await (await raffles.handleRaffleButton(button("raffle:1:enter", ALICE, [ROLE_VIP]))).json();
  assertEquals(again.data.components[0].components[0].custom_id, "raffle:1:leave");
  const left = await (await raffles.handleRaffleButton(button("raffle:1:leave", ALICE, [ROLE_VIP]))).json();
  assertMatch(left.data.content, /left the raffle/);
  await raffles.handleRaffleButton(button("raffle:1:enter", ALICE, [ROLE_VIP]));
  assertMatch(await cmd(raffles.handleRaffleCommand, "raffle.list", {}, BOB), /#1\*\* Nitro · 2 entries/);
  assertEquals((await raffles.raffleChoices(GUILD, "nit", "end"))[0].value, 1);

  const drawn = calls.length;
  await raffles.runRaffleJobs(Date.now() + 30 * 60_000); // not yet
  assertEquals(posted(CHANNEL, drawn).length, 0);
  await raffles.runRaffleJobs(Date.now() + 2 * 3_600_000);
  const announce = posted(CHANNEL, drawn).at(-1)!.body;
  assertMatch(announce.content, /Congratulations <@72000000000000000[34]>! You won \*\*Nitro\*\*/);
  const winner = announce.allowed_mentions.users[0];
  assertMatch(await cmd(raffles.handleRaffleCommand, "raffle.reroll", { raffle: "1" }), /Rerolled raffle #1/);
  const rerolled = posted(CHANNEL, drawn).at(-1)!.body;
  assert(rerolled.allowed_mentions.users[0] !== winner, "a reroll picks someone else");
  assertMatch(await cmd(raffles.handleRaffleCommand, "raffle.reroll", { raffle: "1" }), /already won/);
  const closed = await (await raffles.handleRaffleButton(button("raffle:1:enter", ALICE, [ROLE_VIP]))).json();
  assertEquals(closed.data.components, []);
});

Deno.test("invite tracking: the invite whose count went up gets the credit", async () => {
  forgetGuild(GUILD);
  await dispatch("GUILD_CREATE", { id: GUILD, name: "Test Tavern", owner_id: OWNER, member_count: 41, roles: [] });
  await cmd(invites.handleInvitesCommand, "invites.log", { channel: LOG, message: "{user} came via {inviter} ({invites})" });
  const NEW1 = "100000000000000011";
  const NEW2 = "100000000000000012";
  const start = calls.length;
  liveInvites = [{ code: "alicecode", uses: 4, inviter: { id: ALICE } }, { code: "bobcode", uses: 0, inviter: { id: BOB } }];
  await dispatch("GUILD_MEMBER_ADD", { guild_id: GUILD, user: { id: NEW1, username: "newbie" }, roles: [] });
  assertEquals(posted(LOG, start).find((c) => c.body.content)?.body.content, `<@${NEW1}> came via <@${ALICE}> (1)`);
  // A one-use invite disappears on its use: the delete counts.
  await dispatch("INVITE_CREATE", { guild_id: GUILD, code: "once", uses: 0, inviter: { id: ALICE } });
  await dispatch("INVITE_DELETE", { guild_id: GUILD, code: "once" });
  await dispatch("GUILD_MEMBER_ADD", { guild_id: GUILD, user: { id: NEW2, username: "newbie2" }, roles: [] });
  assertMatch(await cmd(invites.handleInvitesCommand, "invites.who", { user: NEW2 }, BOB), /invited by <@720000000000000003> \(`once`\)/);
  assertMatch(await cmd(invites.handleInvitesCommand, "invites.show", { user: ALICE }, BOB), /\*\*2\*\* invites \(2 joined, 0 left/);
  await dispatch("GUILD_MEMBER_REMOVE", { guild_id: GUILD, user: { id: NEW1 } });
  assertMatch(await cmd(invites.handleInvitesCommand, "invites.show", { user: ALICE }, BOB), /\*\*1\*\* invite \(2 joined, 1 left/);
  assertMatch(await cmd(invites.handleInvitesCommand, "invites.bonus", { user: BOB, amount: "3" }), /\*\*3\*\* invites/);
  const top = await cmd(invites.handleInvitesCommand, "invites.top", {}, BOB);
  assert(top.indexOf(BOB) < top.indexOf(ALICE), "Bob's bonus puts him first");
  // A brand-new account counts as fake.
  const fresh = String((BigInt(Date.now() - 1_420_070_400_000) << 22n));
  liveInvites = [{ code: "alicecode", uses: 5, inviter: { id: ALICE } }, { code: "bobcode", uses: 0, inviter: { id: BOB } }];
  await dispatch("GUILD_MEMBER_ADD", { guild_id: GUILD, user: { id: fresh, username: "sus" }, roles: [] });
  assertMatch(await cmd(invites.handleInvitesCommand, "invites.show", { user: ALICE }, BOB), /3 joined, 1 left, 1 fake/);
  forgetGuild(GUILD); // the GUILD_CREATE above had no roles; later tests need them
});

Deno.test("welcome: greeting with the count and inviter, a DM, autoroles, a goodbye", async () => {
  await cmd(welcome.handleWelcomeCommand, "welcome.message", { channel: CHANNEL, message: "Hi {user}, our {count} member, invited by {inviter}!" });
  await cmd(welcome.handleWelcomeCommand, "welcome.leave", { channel: CHANNEL });
  await cmd(welcome.handleWelcomeCommand, "welcome.dm", { message: "Welcome to {server}, {username}!" });
  assertMatch(await cmd(welcome.handleWelcomeCommand, "welcome.autorole", { role: ROLE_BLUE }), /now get <@&760000000000000005>/);
  assertMatch(await cmd(welcome.handleWelcomeCommand, "welcome.autorole", { role: ROLE_BLUE }, ALICE), /Only moderators/);
  const NEW = "100000000000000021";
  liveInvites = [{ code: "alicecode", uses: 5, inviter: { id: ALICE } }, { code: "bobcode", uses: 1, inviter: { id: BOB } }];
  const start = calls.length;
  await dispatch("GUILD_MEMBER_ADD", { guild_id: GUILD, user: { id: NEW, username: "carol" }, roles: [] });
  assertMatch(posted(CHANNEL, start).at(-1)!.body.content, /Hi <@100000000000000021>, our 4[0-9](st|nd|rd|th) member, invited by <@720000000000000004>!/);
  assertEquals(dms(NEW, start)[0].body.content, "Welcome to Test Tavern, carol!");
  assertEquals(roleCalls("PUT", NEW, ROLE_BLUE, start).length, 1);
  // Membership screening: the role waits until they accept the rules.
  const SCREENED = "100000000000000022";
  liveInvites = [{ code: "alicecode", uses: 6, inviter: { id: ALICE } }, { code: "bobcode", uses: 1, inviter: { id: BOB } }];
  await dispatch("GUILD_MEMBER_ADD", { guild_id: GUILD, user: { id: SCREENED, username: "dan" }, roles: [], pending: true });
  assertEquals(roleCalls("PUT", SCREENED, ROLE_BLUE, start).length, 0);
  await dispatch("GUILD_MEMBER_UPDATE", { guild_id: GUILD, user: { id: SCREENED }, roles: [], pending: false });
  await dispatch("GUILD_MEMBER_UPDATE", { guild_id: GUILD, user: { id: SCREENED }, roles: [], pending: false });
  assertEquals(roleCalls("PUT", SCREENED, ROLE_BLUE, start).length, 1);
  await dispatch("GUILD_MEMBER_REMOVE", { guild_id: GUILD, user: { id: NEW, username: "carol" } });
  assertMatch(posted(CHANNEL, start).at(-1)!.body.content, /\*\*carol\*\* has left/);
  assertMatch(await cmd(welcome.handleWelcomeCommand, "welcome.status"), /Autoroles: <@&760000000000000005>/);
});

Deno.test("role panels: buttons hand out roles; one-at-a-time swaps; risky roles refused", async () => {
  assertMatch(await cmd(selfroles.handleRolesCommand, "roles.panel", { role1: ROLE_ADMIN }), /can moderate or manage/);
  const start = calls.length;
  assertMatch(await cmd(selfroles.handleRolesCommand, "roles.panel", { role1: ROLE_RED, role2: ROLE_BLUE, title: "Colours", mode: "single" }), /Panel #1 is up/);
  const panel = posted(CHANNEL, start)[0].body;
  assertEquals(panel.components[0].components.map((b: any) => b.label), ["Red", "Blue"]);
  const res = await (await selfroles.handleRolesButton(button(`roles:1:${ROLE_BLUE}`, ALICE, [ROLE_RED]))).json();
  assertEquals(res.type, 5);
  await new Promise((r) => setTimeout(r, 700));
  assertEquals(roleCalls("DELETE", ALICE, ROLE_RED, start).length, 1);
  assertEquals(roleCalls("PUT", ALICE, ROLE_BLUE, start).length, 1);
  const edit = since(start).find((c) => c.path.endsWith("/messages/@original"))!;
  assertMatch(edit.body.content, /You now have <@&760000000000000005>.*Swapped from <@&760000000000000004>/);
  // A role that isn't on the panel can't be asked for.
  const forged = await (await selfroles.handleRolesButton(button(`roles:1:${ROLE_ADMIN}`, ALICE))).json();
  assertMatch(forged.data.content, /panel has changed/);
});

Deno.test("moderation: cases, DMs, the role ladder, purge, the log", async () => {
  await cmd(moderation.handleModCommand, "mod.log", { channel: LOG }, OWNER);
  assertMatch(await cmd(moderation.handleModCommand, "mod.warn", { user: BOB, reason: "spoilers" }, ALICE), /needs the \*\*Timeout Members\*\*/);
  const start = calls.length;
  assertMatch(await cmd(moderation.handleModCommand, "mod.warn", { user: BOB, reason: "spoilers" }), /warned \(case #1; warning 1\)/);
  assertMatch(dms(BOB, start)[0].body.content, /warned in \*\*Test Tavern\*\*.*\nReason: spoilers/);
  assertMatch(posted(LOG, start)[0].body.embeds[0].title, /Warned · case #1/);
  // Mods can't act on the owner or on someone with a higher role.
  assertMatch(await cmd(moderation.handleModCommand, "mod.kick", { user: OWNER }), /server owner/);
  memberRoles.set(ALICE, [ROLE_ADMIN]);
  forgetGuild(GUILD);
  assertMatch(await cmd(moderation.handleModCommand, "mod.timeout", { user: ALICE, duration: "1h" }), /at or above yours/);
  memberRoles.set(ALICE, []);
  assertMatch(await cmd(moderation.handleModCommand, "mod.timeout", { user: BOB, duration: "29d" }), /isn't a timeout/);
  const t = calls.length;
  assertMatch(await cmd(moderation.handleModCommand, "mod.timeout", { user: BOB, duration: "1h", reason: "cool off" }), /timed out for 1h \(case #2\)/);
  const patch = since(t).find((c) => c.method === "PATCH" && c.path === `/guilds/${GUILD}/members/${BOB}`)!;
  assert(Date.parse(patch.body.communication_disabled_until) > Date.now() + 3_500_000);
  assertEquals(patch.reason, "Mo: cool off");
  assertMatch(await cmd(moderation.handleModCommand, "mod.ban", { user: BOB }), /needs the \*\*Ban Members\*\*/);
  const b = calls.length;
  assertMatch(await cmd(moderation.handleModCommand, "mod.ban", { user: BOB, delete_days: "1" }, OWNER), /banned \(case #3\), and their messages from the last 1 day/);
  assertEquals(since(b).find((c) => c.method === "PUT" && c.path === `/guilds/${GUILD}/bans/${BOB}`)!.body.delete_message_seconds, 86400);
  assertMatch(await cmd(moderation.handleModCommand, "mod.cases", { user: BOB }), /1 warning[\s\S]*#3\*\* 🔨 Banned[\s\S]*#1\*\* ⚠️ Warned/);
  assertMatch(await cmd(moderation.handleModCommand, "mod.delcase", { case: "1" }), /off the record/);

  channelMessages = [
    { id: "1", author: { id: BOB }, timestamp: new Date().toISOString() },
    { id: "2", author: { id: ALICE }, timestamp: new Date().toISOString() },
    { id: "3", author: { id: BOB }, timestamp: new Date().toISOString(), pinned: true },
    { id: "4", author: { id: BOB }, timestamp: new Date(Date.now() - 20 * 86_400_000).toISOString() },
    { id: "5", author: { id: BOB }, timestamp: new Date().toISOString() },
  ];
  const p = calls.length;
  assertMatch(await cmd(moderation.handleModCommand, "mod.purge", { count: "10", user: BOB }), /Deleted 2 messages from/);
  assertEquals(since(p).find((c) => c.path.endsWith("/bulk-delete"))!.body.messages, ["1", "5"]);
});

Deno.test("the honeypot throws out whoever posts there, but not moderators", async () => {
  const start = calls.length;
  assertMatch(await cmd(honeypot.handleHoneypotCommand, "honeypot.setup", {}), /746666666666666666>: whoever posts there .* is \*\*softbanned\*\*/);
  const HP = "746666666666666666";
  assertMatch(posted(HP, start)[0].body.content, /Do not post here/);
  await dispatch("MESSAGE_CREATE", { ...message(MOD, "testing"), channel_id: HP });
  assertEquals(since(start).filter((c) => c.path.includes("/bans/")).length, 0);
  const SPAMMER = "100000000000000031";
  memberRoles.set(SPAMMER, []);
  await dispatch("MESSAGE_CREATE", { ...message(SPAMMER, "free nitro http://scam"), channel_id: HP });
  const ban = since(start).find((c) => c.method === "PUT" && c.path === `/guilds/${GUILD}/bans/${SPAMMER}`)!;
  assertEquals(ban.body.delete_message_seconds, 3600);
  assert(since(start).some((c) => c.method === "DELETE" && c.path === `/guilds/${GUILD}/bans/${SPAMMER}`), "softban unbans");
  assertMatch(dms(SPAMMER, start)[0].body.content, /honeypot/);
  assertMatch(await cmd(honeypot.handleHoneypotCommand, "honeypot.status", {}, ALICE), /1 caught/);
});

Deno.test("security: floods and mass pings are timed out; raids and nukes are stopped", async () => {
  // Off until switched on.
  assertEquals(await security.checkMessage(message(ALICE, "@everyone", { mention_everyone: true })), null);
  assertMatch(await cmd(security.handleSecurityCommand, "security.antispam", { enabled: true }), /need the \*\*Manage Server\*\* permission/);
  assertMatch(await cmd(security.handleSecurityCommand, "security.antispam", { enabled: true, messages: "4", seconds: "5", mentions: "2", invites: true }, OWNER), /Anti-spam\*\* 🟢 on · 4 messages in 5s/);
  const t0 = Date.now();
  for (let i = 0; i < 3; i++) assertEquals(await security.checkMessage(message(ALICE, `msg ${i}`), t0 + i * 100), null);
  const start = calls.length;
  assertEquals(await security.checkMessage(message(ALICE, "msg 3"), t0 + 400), "flood");
  assert(since(start).some((c) => c.method === "PATCH" && c.path === `/guilds/${GUILD}/members/${ALICE}` && c.body.communication_disabled_until));
  assertEquals(since(start).filter((c) => c.method === "DELETE" && c.path.startsWith(`/channels/${CHANNEL}/messages/`)).length, 4);
  assertEquals(await security.checkMessage(message(BOB, "hi", { mentions: [{ id: "1" }, { id: "2" }, { id: "3" }] }), t0), "mentions");
  assertEquals(await security.checkMessage(message(BOB, "join discord.gg/abc123"), t0 + 20_000), "invite");
  assertEquals(await security.checkMessage(message(MOD, "discord.gg/abc123"), t0), null); // moderators are exempt

  await cmd(security.handleSecurityCommand, "security.antiraid", { enabled: true, joins: "3", seconds: "10", account_age: "0" }, OWNER);
  const j = Date.now();
  const join = (n: number) => ({ guild_id: GUILD, user: { id: `10000000000000010${n}`, username: `raider${n}` } });
  assertEquals(await security.checkJoin(join(1), j), null);
  assertEquals(await security.checkJoin(join(2), j + 100), null);
  assertEquals(await security.checkJoin(join(3), j + 200), "raid");
  assertEquals(await security.checkJoin(join(4), j + 60_000), "raid"); // still raid mode
  assertMatch(await cmd(security.handleSecurityCommand, "security.raidmode", { state: "off" }, OWNER), /Anti-raid\*\* 🟢 on/);
  assertEquals(await security.checkJoin(join(5), j + 700_000), null);
  await cmd(security.handleSecurityCommand, "security.antiraid", { enabled: false, account_age: "30" }, OWNER);
  const young = String((BigInt(Date.now() - 1_420_070_400_000 - 86_400_000) << 22n));
  assertEquals(await security.checkJoin({ guild_id: GUILD, user: { id: young } }), "young");

  await cmd(security.handleSecurityCommand, "security.antinuke", { enabled: true, limit: "3" }, OWNER);
  const n = calls.length;
  for (let i = 0; i < 2; i++) assertEquals(await security.checkAudit({ guild_id: GUILD, action_type: 12, user_id: MOD }, j + i), false);
  assertEquals(await security.checkAudit({ guild_id: GUILD, action_type: 12, user_id: MOD }, j + 2), true);
  assertEquals(since(n).find((c) => c.method === "PATCH" && c.path === `/guilds/${GUILD}/members/${MOD}`)!.body.roles, []);
  assertMatch(dms(OWNER, n)[0].body.content, /Anti-nuke.*deleted a channel 3 times/);
  // The owner and trusted members are never stopped.
  for (let i = 0; i < 5; i++) assertEquals(await security.checkAudit({ guild_id: GUILD, action_type: 22, user_id: OWNER }, j + i), false);
  await cmd(security.handleSecurityCommand, "security.trust", { user: MOD }, OWNER);
  for (let i = 0; i < 5; i++) assertEquals(await security.checkAudit({ guild_id: GUILD, action_type: 32, user_id: MOD }, j + 100 + i), false);
  await cmd(security.handleSecurityCommand, "security.antispam", { enabled: false }, OWNER);
});

const RSS = (items: Array<[string, string]>) => `<?xml version="1.0"?><rss><channel><title>Tavern Blog</title>${
  items.map(([id, title]) => `<item><title><![CDATA[${title}]]></title><link>https://blog.test/${id}</link><guid>${id}</guid><pubDate>Mon, 26 Oct 2026 10:00:00 GMT</pubDate><dc:creator>Shea</dc:creator></item>`).join("")
}</channel></rss>`;

Deno.test("feed alerts: RSS and Atom are read; only new items are posted", async () => {
  const atom = notify.parseFeed(`<feed><title>Shea's Channel</title><entry><id>yt:video:abc</id><yt:videoId>abc</yt:videoId><title>Raid night &amp; more</title><link rel="alternate" href="https://www.youtube.com/watch?v=abc"/><author><name>Shea</name></author><published>2026-10-25T10:00:00+00:00</published></entry></feed>`);
  assertEquals(atom.title, "Shea's Channel");
  assertEquals(atom.items[0], { id: "abc", title: "Raid night & more", url: "https://www.youtube.com/watch?v=abc", author: "Shea", published: Date.parse("2026-10-25T10:00:00Z") });

  feeds.set("https://blog.test/feed", RSS([["p2", "Second post"], ["p1", "First post"]]));
  assertMatch(await cmd(notify.handleNotifyCommand, "notify.add", { source: "rss", from: "https://nothing.test/feed" }), /no RSS or Atom feed/);
  assertMatch(await cmd(notify.handleNotifyCommand, "notify.add", { source: "rss", from: "https://blog.test/feed", channel: LOG, ping: ROLE_VIP }), /Following 📰 \*\*Tavern Blog\*\*/);
  assertMatch(await cmd(notify.handleNotifyCommand, "notify.list", {}, ALICE), /#1\*\* 📰 Tavern Blog → <#745555555555555555> · pings <@&760000000000000003>/);
  const start = calls.length;
  await notify.runNotifyJobs();
  assertEquals(posted(LOG, start).length, 0); // nothing new since it was added
  feeds.set("https://blog.test/feed", RSS([["p4", "Fourth"], ["p3", "Third"], ["p2", "Second post"], ["p1", "First post"]]));
  await notify.runNotifyJobs();
  const out = posted(LOG, start).map((c) => c.body);
  assertEquals(out.map((b) => b.content), ["<@&760000000000000003> 📰 **Third**\nhttps://blog.test/p3", "<@&760000000000000003> 📰 **Fourth**\nhttps://blog.test/p4"]);
  assertEquals(out[0].allowed_mentions.roles, [ROLE_VIP]);
  await notify.runNotifyJobs();
  assertEquals(posted(LOG, start).length, 2);
  assertMatch(await cmd(notify.handleNotifyCommand, "notify.test", { feed: "1" }), /Posted the latest/);
  assertMatch(await cmd(notify.handleNotifyCommand, "notify.remove", { feed: "1" }), /No more alerts/);
});

Deno.test("the server log records deleted and edited messages", async () => {
  await cmd(moderation.handleModCommand, "mod.log", { channel: LOG, messages: true }, OWNER);
  const m = message(ALICE, "original words");
  await dispatch("MESSAGE_CREATE", m);
  const start = calls.length;
  await dispatch("MESSAGE_UPDATE", { id: m.id, guild_id: GUILD, channel_id: CHANNEL, content: "edited words", author: m.author });
  await dispatch("MESSAGE_DELETE", { id: m.id, guild_id: GUILD, channel_id: CHANNEL });
  const logged = posted(LOG, start).map((c) => c.body.embeds[0]);
  assertMatch(logged[0].title, /edited/);
  assertEquals(logged[0].fields.map((f: any) => f.value), ["original words", "edited words"]);
  assertMatch(logged[1].title, /deleted/);
  assertEquals(logged[1].fields[0].value, "edited words");
  await cmd(moderation.handleModCommand, "mod.log", { messages: false }, OWNER);
  const m2 = message(ALICE, "quiet");
  await dispatch("MESSAGE_CREATE", m2);
  const quiet = calls.length;
  await dispatch("MESSAGE_DELETE", { id: m2.id, guild_id: GUILD, channel_id: CHANNEL });
  assertEquals(posted(LOG, quiet).length, 0);
});

Deno.test("switched-off features say so", async () => {
  for (const [feature, handler, kind] of [
    ["birthdays", birthdays.handleBirthdayCommand, "birthday.upcoming"],
    ["raffles", raffles.handleRaffleCommand, "raffle.list"],
    ["security", security.handleSecurityCommand, "security.status"],
  ] as const) {
    await setFeature(GUILD, feature, false);
    assertMatch(await cmd(handler as any, kind, {}, OWNER), new RegExp(`name:${feature} state:on`));
    await setFeature(GUILD, feature, true);
  }
});
