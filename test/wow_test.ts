// WoW: Forever raid nights (wow.ts): start times, the roster rules, and a
// raid from post to attendance against a fake Discord API.
// `deno task test`; set SHOW=1 to print the cards.

import { assert, assertEquals, assertMatch } from "@std/assert";

const dir = Deno.makeTempDirSync({ prefix: "guildscribe-wow-test-" });
Deno.env.set("DB_PATH", `${dir}/test.sqlite`);
Deno.env.set("PUBLIC_BASE_URL", "https://discord.example.test");
Deno.env.set("DISCORD_BOT_TOKEN", "test-token");

const { ensureSchema } = await import("../schema.ts");
const { ensureGuild } = await import("../guild.ts");
const { parseWhen, zonedToUtc } = await import("../wow_time.ts");
const { buildRoster, handleWowButton, handleWowCommand, raidCard, raidChoices, runWowJobs } = await import("../wow.ts");
const { getRaid, getSignups, FINISH_AFTER_MS } = await import("../wow_db.ts");
const { resolveInvocation, registrationPayload } = await import("../commands.ts");
const { sqlite } = await import("../game/sqlite.ts");

await ensureSchema();

const GUILD = "711111111111111111";
const CHANNEL = "744444444444444444";
const LEADER = "722222222222222222";
const show = Deno.env.get("SHOW") === "1";
const member = (n: number) => String(730000000000000000n + BigInt(n));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

await ensureGuild(GUILD, CHANNEL);

// ── A fake Discord ──

type Call = { method: string; path: string; body: any };
const calls: Call[] = [];
const closedDms = new Set<string>();
let nextId = 800000000000000000n;
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith("https://discord.com/")) return realFetch(input, init);
  const path = url.replace("https://discord.com/api/v10", "");
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
  const method = init?.method ?? "GET";
  calls.push({ method, path, body });
  const ok = (b: unknown) => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } }));
  if (path === "/users/@me/channels") return ok({ id: `dm${body.recipient_id}` });
  const dm = path.match(/^\/channels\/dm(\d+)\/messages$/);
  if (dm && closedDms.has(dm[1])) return Promise.resolve(new Response('{"code":50007}', { status: 403 }));
  if (method === "POST" && /\/channels\/[^/]+\/messages$/.test(path)) return ok({ id: String(nextId++) });
  return ok({});
}) as typeof fetch;

const dmsTo = (userId: string) => calls.filter((c) => c.method === "POST" && c.path === `/channels/dm${userId}/messages`);

function args(opts: Record<string, string | number | boolean>) {
  const get = (n: string) => opts[n] === undefined ? "" : String(opts[n]);
  return { s: get, u: (n: string) => get(n) ? `@u${n}` : "", b: (n: string) => opts[n] === true, id: get };
}

async function wow(kind: string, opts: Record<string, string | number | boolean> = {}, who = LEADER, moderator = false) {
  const m = await handleWowCommand(kind, { guildId: GUILD, channelId: CHANNEL, userId: who, display: `Member ${who.slice(-2)}`, moderator, a: args(opts) });
  if (show) console.log(`\n${kind} ${JSON.stringify(opts)}\n${m.content}`);
  return m;
}

async function click(raidId: number, action: string, userId: string, where: { messageId?: string; dm?: boolean } = {}) {
  const res = await handleWowButton({
    type: 3,
    application_id: "799999999999999999",
    token: "tok",
    ...(where.dm ? { user: { id: userId, username: `m${userId.slice(-2)}` } } : { guild_id: GUILD, channel_id: CHANNEL, member: { user: { id: userId, username: `m${userId.slice(-2)}` }, permissions: "0" } }),
    message: { id: where.messageId ?? "0" },
    data: { custom_id: `wow:${raidId}:${action}`, component_type: 2 },
  });
  return await res.json();
}

// ── Start times ──

Deno.test("start times are read in the raid's timezone, including daylight saving", () => {
  const zone = "America/New_York";
  // Wednesday Oct 28, 2026, 3:00 PM in New York (EDT, UTC-4).
  const now = zonedToUtc(2026, 10, 28, 15, 0, zone);
  assertEquals(new Date(now).toISOString(), "2026-10-28T19:00:00.000Z");
  const at = (s: string) => {
    const w = parseWhen(s, zone, now);
    assert("at" in w, `${s}: ${"error" in w ? w.error : ""}`);
    return new Date(w.at).toISOString();
  };
  assertEquals(at("8pm"), "2026-10-29T00:00:00.000Z"); // today, 8 PM EDT
  assertEquals(at("2pm"), "2026-10-29T18:00:00.000Z"); // already past today → tomorrow
  assertEquals(at("tomorrow 19:30"), "2026-10-29T23:30:00.000Z");
  assertEquals(at("fri 8pm"), "2026-10-31T00:00:00.000Z");
  assertEquals(at("wed 2pm"), "2026-11-04T19:00:00.000Z"); // today's has passed → next week, after the clocks change (EST)
  assertEquals(at("11/8 8:30pm"), "2026-11-09T01:30:00.000Z"); // EST, UTC-5
  assertEquals(at("2026-11-08 20:00"), "2026-11-09T01:00:00.000Z");
  assertEquals(at("Nov 4 3pm"), "2026-11-04T20:00:00.000Z");
  assertEquals(at("in 2h"), "2026-10-28T21:00:00.000Z");
  assertEquals(at("1/5 9pm"), "2027-01-06T02:00:00.000Z"); // next January
  assertEquals(new Date((parseWhen("8pm", "Europe/London", now) as { at: number }).at).toISOString(), "2026-10-28T20:00:00.000Z"); // GMT by then
  for (const bad of ["", "sometime", "25:00", "13pm", "2/30 8pm", "2026-10-01 8pm"]) assert("error" in parseWhen(bad, zone, now), bad);
});

// ── The roster ──

Deno.test("signups fill role slots in order; the rest wait on the bench", () => {
  const s = (userId: string, role: "tank" | "healer" | "dps" | null, answer: "yes" | "maybe" | "no", signedAt: number) => ({ userId, display: userId, role, answer, signedAt });
  const raid = { size: 4, slots: { tank: 1, healer: 1, dps: 3 } };
  const r = buildRoster(raid, [
    s("t1", "tank", "yes", 1), s("t2", "tank", "yes", 2), s("h1", "healer", "yes", 3), s("d1", "dps", "yes", 4),
    s("d2", "dps", "yes", 5), s("d3", "dps", "yes", 6), s("m", "dps", "maybe", 7), s("n", null, "no", 8),
  ]);
  assertEquals(r.in.tank.map((x) => x.userId), ["t1"]);
  assertEquals(r.in.healer.map((x) => x.userId), ["h1"]);
  assertEquals(r.in.dps.map((x) => x.userId), ["d1", "d2"]); // the raid is full at 4
  assertEquals(r.bench.map((x) => x.userId), ["t2", "d3"]);
  assertEquals([r.maybe.length, r.no.length, r.total], [1, 1, 4]);
});

// ── A raid night, start to finish ──

Deno.test("a raid: post, buttons, bench, invites, reminder, close-out, attendance, loot, stats", async () => {
  const created = await wow("wow.raid.create", { title: "Molten Core", when: "in 3h", size: "5", notes: "Bring fire resist" });
  assertMatch(created.content, /Molten Core\*\* \(raid #\d+\) is up/);
  const id = Number(created.content.match(/raid #(\d+)/)![1]);
  const raid = (await getRaid(id))!;
  assertEquals([raid.size, raid.slots.tank, raid.slots.healer, raid.slots.dps], [5, 1, 1, 3]);
  const post = calls.find((c) => c.method === "POST" && c.path === `/channels/${CHANNEL}/messages`)!;
  assertEquals(post.body.embeds[0].title, "⚔️ Molten Core");
  assertEquals(post.body.components[0].components.map((b: any) => b.custom_id), [`wow:${id}:tank`, `wow:${id}:healer`, `wow:${id}:dps`]);
  assert(raid.messageId);

  // Signups on the post: each click updates the post in place.
  const r1 = await click(id, "tank", member(1), { messageId: raid.messageId! });
  assertEquals(r1.type, 7);
  assertMatch(JSON.stringify(r1.data.embeds[0].fields[0]), /Tanks \(1\/1\)/);
  await click(id, "healer", member(2), { messageId: raid.messageId! });
  for (const n of [3, 4, 5]) await click(id, "dps", member(n), { messageId: raid.messageId! });
  const benched = await click(id, "tank", member(6), { messageId: raid.messageId! }); // tanks and the raid are full
  assertMatch(JSON.stringify(benched.data.embeds[0].fields), /Bench \(1\)/);
  await click(id, "maybe", member(7), { messageId: raid.messageId! });
  await sleep(700); // the private "you're on the bench" follow-ups
  const followUps = calls.filter((c) => c.path === "/webhooks/799999999999999999/tok");
  assert(followUps.some((c) => /bench as Tank: the raid is full/.test(c.body.content) && c.body.flags === 64), "the benched member is told privately");

  // The tank leaves: the bench tank moves in and gets a DM.
  await click(id, "leave", member(1), { messageId: raid.messageId! });
  await sleep(700);
  assert(dmsTo(member(6)).some((c) => /spot opened up: you're in \*\*Molten Core\*\* as Tank/.test(c.body.content)), "promoted by DM");
  let roster = buildRoster(raid, await getSignups(id));
  assertEquals(roster.in.tank.map((s) => s.userId), [member(6)]);

  // Invites: a DM card with the same buttons, a ping in the channel; closed DMs are reported.
  closedDms.add(member(9));
  const invited = await wow("wow.raid.invite", { raid: id, user: member(8), members: `<@${member(9)}> <@!${member(2)}>` });
  assertMatch(invited.content, new RegExp(`Invited <@${member(8)}>`));
  assertMatch(invited.content, new RegExp(`<@${member(9)}> doesn't take DMs`));
  assertMatch(invited.content, new RegExp(`<@${member(2)}> is already signed up`));
  assertEquals(invited.ping, [member(8), member(9)]);
  const inviteDm = dmsTo(member(8)).at(-1)!;
  assertMatch(inviteDm.body.content, /invited you to \*\*Molten Core\*\*/);
  assertEquals(inviteDm.body.components[0].components[0].custom_id, `wow:${id}:tank`);
  const card = await raidCard((await getRaid(id))!);
  assertMatch(JSON.stringify(card.embeds), /Invited, no answer yet \(2\)/);

  // Answering from the DM updates the DM card and the server post.
  const fromDm = await click(id, "no", member(8), { dm: true });
  assertEquals(fromDm.type, 7);
  assertMatch(fromDm.data.content, /You can't make it/);
  await sleep(700);
  assert(calls.some((c) => c.method === "PATCH" && c.path === `/channels/${CHANNEL}/messages/${raid.messageId}`), "post refreshed");

  // Only the leader (or a moderator) edits; a reschedule DMs everyone signed up.
  assertMatch((await wow("wow.raid.edit", { raid: id, when: "in 2h" }, member(3))).content, /Only the raid's leader/);
  assertMatch((await wow("wow.raid.edit", { raid: id, when: "in 20m" })).content, /Updated \*\*Molten Core\*\*.*time/);
  assert(dmsTo(member(3)).some((c) => /moved to/.test(c.body.content)));

  // The reminder (30 minutes before by default) DMs and pings those in, once.
  const before = calls.length;
  await runWowJobs();
  await runWowJobs();
  const reminders = calls.slice(before).filter((c) => /⏰/.test(c.body?.content ?? ""));
  assert(reminders.some((c) => c.path === `/channels/${CHANNEL}/messages` && c.body.allowed_mentions.users.includes(member(6))), "channel ping");
  assertEquals(reminders.filter((c) => c.path === `/channels/dm${member(6)}/messages`).length, 1, "one reminder DM");

  // Hours after the start it closes itself out: everyone in counts as there.
  roster = buildRoster(raid, await getSignups(id));
  await sqlite.execute("UPDATE wow_raids SET starts_at = ? WHERE id = ?", [Date.now() - FINISH_AFTER_MS - 60_000, id]);
  await runWowJobs();
  const done = (await getRaid(id))!;
  assertEquals(done.status, "done");
  const doneCard = await raidCard(done);
  assertEquals(doneCard.components, []);
  assertMatch(JSON.stringify(doneCard.embeds), /Showed up \(5\)/);
  assertEquals((await click(id, "dps", member(10), { messageId: raid.messageId! })).data.components, []);

  // Fixing attendance, loot, and what it adds up to.
  assertMatch((await wow("wow.raid.attendance", { raid: id, user: member(5), status: "noshow" })).content, /no-show/);
  assertMatch((await wow("wow.raid.loot", { raid: id, user: member(6), item: "Eye of Sulfuras" })).content, /Eye of Sulfuras/);
  const stats = await wow("wow.stats", { user: member(6) });
  assertMatch(stats.content, /1 raid attended · 🚫 0 no-shows · 100% attendance/);
  assertMatch(stats.content, /Eye of Sulfuras \(#\d+\)/);
  assertMatch((await wow("wow.stats", { user: member(5) })).content, /0 raids attended · 🚫 1 no-show · 0% attendance/);
  const top = await wow("wow.top");
  assertMatch(top.content, /Most raids attended/);
  assert(!top.content.includes(`<@${member(5)}>`), "a member with no raids attended isn't on the board");
});

Deno.test("characters show on rosters; cancelling DMs signups; the leader's checks", async () => {
  assertMatch((await wow("wow.character", { name: "Thrall", class: "Shaman", role: "healer" }, member(20))).content, /mains \*\*Thrall\*\* the Shaman \(Healer\)/);
  const id = Number((await wow("wow.raid.create", { title: "Onyxia", when: "tomorrow 9pm", size: "10", tanks: 1, healers: 2 })).content.match(/raid #(\d+)/)![1]);
  const raid = (await getRaid(id))!;
  assertEquals(raid.slots, { tank: 1, healer: 2, dps: 6 });
  await click(id, "healer", member(20), { messageId: raid.messageId! });
  await click(id, "maybe", member(21), { messageId: raid.messageId! });
  await sleep(700);
  assertMatch(JSON.stringify((await raidCard(raid)).embeds), /Thrall \(Shaman\)/);
  assertMatch((await wow("wow.raid.complete", { raid: id })).content, /hasn't started yet/);
  assertMatch((await wow("wow.raid.cancel", { raid: id }, member(20))).content, /Only the raid's leader/);
  assertMatch((await wow("wow.raid.cancel", { raid: id, reason: "Ony's sleeping in" }, member(20), true)).content, /Cancelled \*\*Onyxia\*\*.*Told 2/);
  assert(dmsTo(member(21)).some((c) => /cancelled: Ony's sleeping in/.test(c.body.content)));
  assertMatch((await wow("wow.raid.view", { raid: 999999 })).content, /No raid #999999/);
});

Deno.test("raid numbers autocomplete; the commands register; errors explain themselves", async () => {
  const choices = await raidChoices(GUILD, "molt", "loot");
  assert(choices.some((c) => /^#\d+ Molten Core — .*\(done\)$/.test(c.name)), JSON.stringify(choices));
  assertEquals((await raidChoices(GUILD, "molt", "invite")).length, 0, "finished raids aren't offered for invites");
  assertMatch((await wow("wow.raid.create", { title: "ZG", when: "yesterday 8pm" })).content, /couldn't read/);
  assertMatch((await wow("wow.raid.create", { title: "ZG", when: "saturday" })).content, /What time\?/);
  assertMatch((await wow("wow.raid.create", { title: "ZG", when: "8pm", tanks: 0, healers: 0, dps: 0 })).content, /at least one slot/);
  assertMatch((await wow("wow.timezone", { zone: "Europe/London" })).content, /Only moderators/);
  assertMatch((await wow("wow.timezone", { zone: "Europe/London", remind: 45 }, LEADER, true)).content, /UK & Ireland.*45 minutes/);

  const wowCmd = (registrationPayload() as any[]).find((c) => c.name === "wow");
  const create = wowCmd.options.find((o: any) => o.name === "raid").options.find((o: any) => o.name === "create");
  assertEquals(create.options.slice(0, 2).map((o: any) => o.name), ["title", "when"]);
  assert(create.options.length <= 25);
  assertEquals(create.options.find((o: any) => o.name === "size").choices[0], { name: "Party (5)", value: "5" });
  const found = resolveInvocation({ name: "wow", options: [{ type: 2, name: "raid", options: [{ type: 1, name: "loot", options: [] }] }] });
  assertEquals(found?.leaf.local, "wow.raid.loot");
});

Deno.test("switched off, WoW commands and buttons say so", async () => {
  const { setFeature } = await import("../guild.ts");
  await setFeature(GUILD, "wow", false);
  assertMatch((await wow("wow.raid.list")).content, /switched off.*name:wow state:on/);
  const any = Number((await sqlite.execute("SELECT id FROM wow_raids WHERE guild_id = ? LIMIT 1", [GUILD])).rows[0].id);
  assertMatch((await click(any, "dps", member(1))).data.content, /switched off/);
  await setFeature(GUILD, "wow", true);
});

Deno.test("servers set up before a feature existed get it switched on", async () => {
  const { setFeature } = await import("../guild.ts");
  const { isCommandGroupEnabled } = await import("../game/db.ts");
  const OLD = "766666666666666666";
  await sqlite.execute("INSERT INTO discord_guilds (guild_id, name, set_up_at, features) VALUES (?, 'Old', 1, NULL)", [OLD]);
  await setFeature(OLD, "gamble", false);
  assertEquals(await isCommandGroupEnabled(OLD, "wowraid"), false);
  await ensureGuild(OLD);
  assertEquals(await isCommandGroupEnabled(OLD, "wowraid"), true);
  assertEquals(await isCommandGroupEnabled(OLD, "quotes"), true);
  assertEquals(await isCommandGroupEnabled(OLD, "gamble"), false, "existing switches are left alone");
});

addEventListener("unload", () => {
  globalThis.fetch = realFetch;
});
