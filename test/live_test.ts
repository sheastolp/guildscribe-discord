// Go-live alerts (live.ts): a streamer goes live, changes game, drops and
// comes back, and ends, against a fake Twitch and a fake Discord.
// `deno task test`; set SHOW=1 to print the posts.

import { assert, assertEquals, assertMatch } from "@std/assert";

const dir = Deno.makeTempDirSync({ prefix: "guildscribe-live-test-" });
Deno.env.set("DB_PATH", `${dir}/test.sqlite`);
Deno.env.set("PUBLIC_BASE_URL", "https://discord.example.test");
Deno.env.set("DISCORD_BOT_TOKEN", "test-token");
Deno.env.set("TWITCH_CLIENT_ID", "test-client");
Deno.env.set("TWITCH_CLIENT_SECRET", "test-secret");

const { ensureSchema } = await import("../schema.ts");
const { ensureGuild } = await import("../guild.ts");
const { handleLiveCommand, liveChoices, parseLogin, runLiveJobs } = await import("../live.ts");
const { resolveInvocation } = await import("../commands.ts");

await ensureSchema();

const GUILD = "711111111111111111";
const CHANNEL = "744444444444444444";
const ALERTS = "755555555555555555";
const ROLE = "766666666666666666";
const MOD = "722222222222222222";
const show = Deno.env.get("SHOW") === "1";

await ensureGuild(GUILD, CHANNEL);

// ── A fake Twitch and a fake Discord ──

type Call = { method: string; path: string; body: any };
const calls: Call[] = [];
const streams = new Map<string, any>();
let tokenRequests = 0;
let nextId = 800000000000000000n;
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const ok = (b: unknown) => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } }));
  if (url.host === "id.twitch.tv") {
    tokenRequests++;
    return ok({ access_token: "app-token", expires_in: 3600 });
  }
  if (url.host === "api.twitch.tv") {
    if (url.pathname === "/helix/users") {
      const known = ["sheastolp", "otherguy"];
      return ok({ data: url.searchParams.getAll("login").filter((l) => known.includes(l)).map((l) => ({ id: `id-${l}`, login: l, display_name: l === "sheastolp" ? "SheaStolp" : l, profile_image_url: `https://img.test/${l}.png` })) });
    }
    if (url.pathname === "/helix/streams") return ok({ data: url.searchParams.getAll("user_login").map((l) => streams.get(l)).filter(Boolean) });
  }
  if (!url.href.startsWith("https://discord.com/")) return realFetch(input, init);
  const path = url.href.replace("https://discord.com/api/v10", "");
  const method = init?.method ?? "GET";
  calls.push({ method, path, body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body });
  if (method === "POST" && /\/channels\/[^/]+\/messages$/.test(path)) return ok({ id: String(nextId++) });
  return ok({});
}) as typeof fetch;

const goLive = (login: string, id: string, title: string, game: string) =>
  streams.set(login, { id, user_login: login, user_name: login === "sheastolp" ? "SheaStolp" : login, type: "live", title, game_name: game, viewer_count: 42, started_at: new Date().toISOString(), thumbnail_url: `https://thumb.test/${login}-{width}x{height}.jpg` });

function args(opts: Record<string, string>) {
  const get = (n: string) => opts[n] ?? "";
  return { s: get, u: get, b: () => false, id: get };
}

async function live(kind: string, opts: Record<string, string> = {}, moderator = true) {
  const m = await handleLiveCommand(kind, { guildId: GUILD, channelId: CHANNEL, userId: MOD, moderator, a: args(opts) });
  if (show) console.log(`\n${kind} ${JSON.stringify(opts)}\n${m.content}`);
  return m;
}

const posts = () => calls.filter((c) => c.method === "POST" && c.path === `/channels/${ALERTS}/messages`);
const edits = () => calls.filter((c) => c.method === "PATCH" && c.path.startsWith(`/channels/${ALERTS}/messages/`));

Deno.test("Twitch names are read from links and @names", () => {
  assertEquals(parseLogin("https://www.twitch.tv/SheaStolp?sr=a"), "sheastolp");
  assertEquals(parseLogin("@Shea_Stolp"), "shea_stolp");
  assertEquals(parseLogin("two words"), null);
  assertEquals(parseLogin("x"), null);
});

Deno.test("/live is registered with its subcommands", () => {
  assert(resolveInvocation({ name: "live", options: [{ type: 1, name: "add", options: [{ name: "streamer", value: "sheastolp" }] }] }));
  assert(resolveInvocation({ name: "live", options: [{ type: 1, name: "list" }] }));
});

Deno.test("a streamer goes live, changes game, blips, ends and goes live again", async () => {
  assertMatch((await live("live.add", { streamer: "sheastolp" }, false)).content, /Only moderators/);
  assertMatch((await live("live.add", { streamer: "nobodyhere" })).content, /no channel called/);
  const added = await live("live.add", { streamer: "twitch.tv/SheaStolp", channel: ALERTS, ping: ROLE, message: "{streamer} is playing {game}! {url}" });
  assertMatch(added.content, /Watching \*\*SheaStolp\*\*/);
  assertEquals((await liveChoices(GUILD, "shea")).map((c) => c.value), ["sheastolp"]);

  // Offline: nothing posted.
  await runLiveJobs();
  assertEquals(posts().length, 0);

  // Live: one alert with the ping, the card and a Watch button.
  goLive("sheastolp", "s1", "Dungeon night", "Baldur's Gate 3");
  await runLiveJobs();
  assertEquals(posts().length, 1);
  const post = posts()[0].body;
  if (show) console.log(JSON.stringify(post, null, 2));
  assertEquals(post.content, `<@&${ROLE}> SheaStolp is playing Baldur's Gate 3! <https://www.twitch.tv/sheastolp>`);
  assertEquals(post.allowed_mentions.roles, [ROLE]);
  assertEquals(post.embeds[0].author.name, "SheaStolp is now live on Twitch!");
  assertEquals(post.embeds[0].title, "Dungeon night");
  assertMatch(post.embeds[0].image.url, /^https:\/\/thumb\.test\/sheastolp-1280x720\.jpg\?t=\d+$/);
  assertEquals(post.components[0].components[0].url, "https://www.twitch.tv/sheastolp");

  // Still live, same title: nothing new.
  await runLiveJobs();
  assertEquals(posts().length, 1);
  assertEquals(edits().length, 0);

  // New game: the card is edited, nobody pinged again.
  goLive("sheastolp", "s1", "Dungeon night", "Just Chatting");
  await runLiveJobs();
  assertEquals(posts().length, 1);
  assertEquals(edits().length, 1);
  assertEquals(edits()[0].body.embeds[0].fields[0].value, "Just Chatting");

  // Drops, then back with a new stream id a minute later: the same post comes back to life.
  streams.delete("sheastolp");
  await runLiveJobs();
  assertMatch(edits().at(-1)!.body.embeds[0].author.name, /was live/);
  goLive("sheastolp", "s2", "Dungeon night (reconnected)", "Just Chatting");
  await runLiveJobs(Date.now() + 60_000);
  assertEquals(posts().length, 1);
  assertMatch(edits().at(-1)!.body.embeds[0].author.name, /is now live/);

  // Ends for good: "was live", how long it ran, no ping.
  streams.delete("sheastolp");
  await runLiveJobs();
  const ended = edits().at(-1)!.body;
  assertEquals(ended.content, "");
  assertEquals(ended.embeds[0].footer.text, "Stream ended");
  assert(ended.embeds[0].fields.some((f: any) => f.name === "Streamed for"));

  // Live again an hour later: a new alert.
  goLive("sheastolp", "s3", "Round two", "Baldur's Gate 3");
  await runLiveJobs(Date.now() + 60 * 60_000);
  assertEquals(posts().length, 2);

  assertMatch((await live("live.list", {}, false)).content, /🔴 \*\*SheaStolp\*\* → <#755555555555555555> · pings <@&766666666666666666> · live with Baldur's Gate 3/);
  assertEquals(tokenRequests, 1);
});

Deno.test("@everyone, the test post, removing and the feature switch", async () => {
  await live("live.add", { streamer: "otherguy", channel: ALERTS, ping: GUILD });
  assertMatch((await live("live.test", { streamer: "otherguy" })).content, /Test alert posted/);
  const test = posts().at(-1)!.body;
  assertMatch(test.content, /^@everyone 🔴 \*\*otherguy\*\* is live on Twitch!/);
  assertEquals(test.allowed_mentions.parse, ["everyone"]);

  assertMatch((await live("live.remove", { streamer: "otherguy" })).content, /No more go-live alerts/);
  assertEquals((await liveChoices(GUILD, "")).map((c) => c.value), ["sheastolp"]);

  const { setFeature } = await import("../guild.ts");
  await setFeature(GUILD, "live", false);
  assertMatch((await live("live.list")).content, /switched off/);
  await setFeature(GUILD, "live", true);
});
