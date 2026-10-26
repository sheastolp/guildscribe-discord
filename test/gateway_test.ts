// The Gateway connection (gateway.ts) against a fake Gateway on localhost:
// hello, identify, heartbeats, READY, an event reaching its handler, and
// falling back to the plain intents when Discord refuses the privileged ones.
// `deno task test`.

import { assert, assertEquals } from "@std/assert";

Deno.env.set("DISCORD_BOT_TOKEN", "test-token");

const { Intent, gatewayState, on, startGateway } = await import("../gateway.ts");
const cache = await import("../guildcache.ts");

Deno.test("the Gateway identifies, dispatches events, and drops privileged intents when refused", async () => {
  const identifies: any[] = [];
  let heartbeats = 0;
  let connections = 0;
  const seen: string[] = [];
  on("TEST_EVENT", (d: any) => void seen.push(d.text));

  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, (req) => {
    const { socket, response } = Deno.upgradeWebSocket(req);
    const n = ++connections;
    socket.onopen = () => socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 200 } }));
    socket.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.op === 1) {
        heartbeats++;
        socket.send(JSON.stringify({ op: 11 }));
      }
      if (msg.op !== 2) return;
      identifies.push(msg.d);
      if (n === 1) return socket.close(4014, "Disallowed intent(s)");
      socket.send(JSON.stringify({ op: 0, t: "READY", s: 1, d: { session_id: "sess", resume_gateway_url: `ws://127.0.0.1:${server.addr.port}`, user: { id: "777", username: "GuildScribe" }, guilds: [] } }));
      socket.send(JSON.stringify({ op: 0, t: "TEST_EVENT", s: 2, d: { text: "hello from the gateway" } }));
    };
    return response;
  });

  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith("/gateway/bot")) return Promise.resolve(new Response(JSON.stringify({ url: `ws://127.0.0.1:${server.addr.port}` })));
    return realFetch(input, init);
  }) as typeof fetch;

  const stop = startGateway();
  try {
    for (let i = 0; i < 100 && !seen.length; i++) await new Promise((r) => setTimeout(r, 100));
    assertEquals(seen, ["hello from the gateway"]);
    assertEquals(identifies.length, 2);
    assertEquals(identifies[0].token, "test-token");
    assert(identifies[0].intents & Intent.GUILD_MEMBERS, "asks for Server Members first");
    assert(identifies[0].intents & Intent.MESSAGE_CONTENT, "and Message Content");
    assertEquals(identifies[1].intents & (Intent.GUILD_MEMBERS | Intent.MESSAGE_CONTENT), 0);
    assert(identifies[1].intents & Intent.GUILD_MESSAGES, "keeps the plain intents");
    assertEquals(gatewayState.connected, true);
    assertEquals(gatewayState.privileged, false);
    assertEquals(cache.selfId, "777"); // READY sets the bot's own ID
    await new Promise((r) => setTimeout(r, 500));
    assert(heartbeats >= 1, "heartbeats");
  } finally {
    stop();
    globalThis.fetch = realFetch;
    await new Promise((r) => setTimeout(r, 100));
    await server.shutdown();
  }
});
