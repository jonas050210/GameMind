/**
 * HTTP-level tests for the Control Center server itself: startup errors, the served page's boot data, and
 * static-file containment. The agent is not involved; the host is a stub so only the server is exercised.
 */
import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import { ControlCenter, startControlCenter } from "../src/control-center/server.js";
import type { ControlCenterHost } from "../src/control-center/types.js";

const stubHost: ControlCenterHost = {
  title: "GameMind test",
  snapshot: async () => {
    throw new Error("snapshot is not needed for these tests");
  },
  commands: {} as ControlCenterHost["commands"],
};

test("a busy Control Center port fails with a message that names the port and the fix", async () => {
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve()));
  const address = blocker.address();
  const busyPort = typeof address === "object" && address ? address.port : 0;
  try {
    await assert.rejects(
      () => startControlCenter(stubHost, { port: busyPort, host: "127.0.0.1" }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, new RegExp(`port ${busyPort} is already in use`));
        assert.match(message, /--control-port/);
        assert.doesNotMatch(message, /EADDRINUSE/, "the raw Node error code is not the operator-facing message");
        return true;
      },
    );
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
});

test("the served page receives the control token and no unreplaced placeholder", async () => {
  const center = new ControlCenter(stubHost, { port: 0, host: "127.0.0.1", banner: "offline <test> banner" });
  const handle = await center.start();
  try {
    const response = await fetch(`${handle.url}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
    const html = await response.text();
    assert.doesNotMatch(html, /__CONTROL_TOKEN__|__BANNER__|__TITLE__/);
    assert.ok(html.includes(handle.token), "the token is injected for the page's own POSTs");
    assert.match(html, /<script type="module" src="\.\/app\.js">/);
    const assets = await Promise.all(["app.js", "styles.css"].map((name) => fetch(`${handle.url}${name}`)));
    for (const asset of assets) assert.equal(asset.status, 200);
  } finally {
    await handle.stop("test complete");
  }
});

test("static lookups cannot escape the asset directory, even through a sibling with a matching prefix", async () => {
  const center = new ControlCenter(stubHost, { port: 0, host: "127.0.0.1" });
  const handle = await center.start();
  try {
    // WHATWG URL parsing removes dot segments, so these reach the server as plain paths; none may serve
    // a file from outside `public/` (the sibling directory name `public-…` must not match the prefix).
    for (const probe of ["/..%2fcontrol-center.ts", "/%2e%2e/server.ts", "/../../package.json", "/..%5c..%5cpackage.json"]) {
      const response = await fetch(`${handle.url.replace(/\/$/, "")}${probe}`);
      assert.notEqual(response.status, 200, `probe ${probe} must not serve a file outside the asset directory`);
      await response.arrayBuffer();
    }
    const missing = await fetch(`${handle.url}does-not-exist.js`);
    assert.equal(missing.status, 404);
    await missing.arrayBuffer();
  } finally {
    await handle.stop("test complete");
  }
});

test("a banner or title containing markup or replacement patterns cannot break out of the boot data", async () => {
  const hostile = "</script><img src=x onerror=alert(1)> $& $1 \u2028";
  const center = new ControlCenter(
    { ...stubHost, title: hostile },
    { port: 0, host: "127.0.0.1", banner: hostile },
  );
  const handle = await center.start();
  try {
    const html = await (await fetch(handle.url)).text();
    assert.equal(html.includes("<img src=x"), false, "the raw markup must not reach the page");
    const boot = html.match(/<script id="boot-data" type="application\/json">([\s\S]*?)<\/script>/);
    assert.ok(boot, "the boot-data element is still closed at its own end tag");
    const parsed = JSON.parse(boot[1] ?? "") as { token: string; banner: string; title: string };
    assert.equal(parsed.token, handle.token);
    assert.equal(parsed.banner, hostile, "the value round-trips exactly through the escaped JSON");
    assert.equal(parsed.title, hostile);
  } finally {
    await handle.stop("test complete");
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Hardening: loopback by default, DNS-rebinding guard, own-property commands, same-origin commands, queries.
// ---------------------------------------------------------------------------------------------------------------
import { request as httpRequest } from "node:http";

/** `fetch` cannot set the Host header, and the Host header is exactly what a DNS-rebinding page controls. */
function rawGet(url: string, headers: Record<string, string>): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const outgoing = httpRequest({ hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: "GET", headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: response.headers }));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

async function postCommand(url: string, token: string, type: string, extraHeaders: Record<string, string> = {}): Promise<{ status: number; body: { ok?: boolean; message?: string; code?: string } }> {
  const response = await fetch(`${url}api/command`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-gamemind-token": token, ...extraHeaders },
    body: JSON.stringify({ type }),
  });
  return { status: response.status, body: (await response.json()) as { ok?: boolean; message?: string; code?: string } };
}

test("the Control Center binds to loopback unless the operator says otherwise", async () => {
  const center = new ControlCenter(stubHost, { port: 0 });
  const handle = await center.start();
  try {
    assert.equal(handle.bindHost, "127.0.0.1");
    assert.equal(handle.localOnly, true);
    assert.match(handle.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  } finally {
    await handle.stop("test complete");
  }
  const exposed = new ControlCenter(stubHost, { port: 0, host: "0.0.0.0" });
  const exposedHandle = await exposed.start();
  try {
    assert.equal(exposedHandle.localOnly, false, "an explicit wildcard bind is reported as not local-only");
    assert.match(exposedHandle.url, /^http:\/\/127\.0\.0\.1:\d+\/$/, "the address shown for a wildcard bind is still a usable one");
  } finally {
    await exposedHandle.stop("test complete");
  }
});

test("a request addressed to a foreign Host name is refused while the server is loopback-bound (DNS rebinding)", async () => {
  const center = new ControlCenter(stubHost, { port: 0, host: "127.0.0.1" });
  const handle = await center.start();
  try {
    const port = handle.port;
    for (const host of ["evil.example", `evil.example:${port}`, "169.254.169.254", "127.0.0.1.evil.example"]) {
      const refused = await rawGet(`${handle.url}api/health`, { host });
      assert.equal(refused.status, 403, `Host '${host}' must be refused`);
      assert.equal((JSON.parse(refused.body) as { code?: string }).code, "HOST_NOT_ALLOWED");
      const page = await rawGet(handle.url, { host });
      assert.equal(page.status, 403, "the page, and so the control token in it, is not served to a foreign host either");
      assert.ok(!page.body.includes(handle.token));
    }
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, "localhost"]) {
      const accepted = await rawGet(`${handle.url}api/health`, { host });
      assert.equal(accepted.status, 200, `Host '${host}' is loopback and must be served`);
    }
  } finally {
    await handle.stop("test complete");
  }
});

test("allowedHosts adds names to a loopback-bound server, and a deliberate non-loopback bind accepts any Host", async () => {
  const allowed = await new ControlCenter(stubHost, { port: 0, host: "127.0.0.1", allowedHosts: ["gamemind.test"] }).start();
  try {
    assert.equal((await rawGet(`${allowed.url}api/health`, { host: "gamemind.test" })).status, 200);
    assert.equal((await rawGet(`${allowed.url}api/health`, { host: "other.test" })).status, 403);
  } finally {
    await allowed.stop("test complete");
  }
  const open = await new ControlCenter(stubHost, { port: 0, host: "0.0.0.0" }).start();
  try {
    assert.equal((await rawGet(`${open.url}api/health`, { host: "3000-sandbox.e2b.app" })).status, 200);
  } finally {
    await open.stop("test complete");
  }
});

test("commands dispatch only own properties: inherited names such as constructor are not callable", async () => {
  const commands = { ping: () => ({ ok: true, message: "pong" }) } as ControlCenterHost["commands"];
  const handle = await new ControlCenter({ ...stubHost, commands }, { port: 0 }).start();
  try {
    for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf", "__defineGetter__"]) {
      const result = await postCommand(handle.url, handle.token, name);
      assert.equal(result.status, 501, `'${name}' must not dispatch`);
      assert.match(result.body.message ?? "", /not available in this run/);
    }
    const ok = await postCommand(handle.url, handle.token, "ping");
    assert.equal(ok.status, 200);
    assert.equal(ok.body.message, "pong");
  } finally {
    await handle.stop("test complete");
  }
});

test("a command posted from another origin is refused even with the token; the page's own origin is accepted", async () => {
  const commands = { ping: () => ({ ok: true, message: "pong" }) } as ControlCenterHost["commands"];
  const handle = await new ControlCenter({ ...stubHost, commands }, { port: 0 }).start();
  try {
    const foreign = await postCommand(handle.url, handle.token, "ping", { origin: "http://evil.example" });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.body.code, "CROSS_ORIGIN");
    const sameOrigin = await postCommand(handle.url, handle.token, "ping", { origin: handle.url.replace(/\/$/, "") });
    assert.equal(sameOrigin.status, 200);
    const noOrigin = await postCommand(handle.url, handle.token, "ping");
    assert.equal(noOrigin.status, 200, "non-browser clients send no Origin and are authenticated by the token alone");
    const wrongToken = await postCommand(handle.url, "not-the-token", "ping");
    assert.equal(wrongToken.status, 403);
  } finally {
    await handle.stop("test complete");
  }
});

test("host queries are served as GET /api/<name>; unknown, reserved and inherited names are not", async () => {
  const queries: NonNullable<ControlCenterHost["queries"]> = {
    echo: (params) => ({ q: params.get("q"), items: [1, 2] }),
    broken: () => {
      throw new Error("boom");
    },
    snapshot: () => ({ shadowed: true }),
  };
  const handle = await new ControlCenter({ ...stubHost, queries, health: () => ({ version: "9.9.9", sessionState: "idle" }) }, { port: 0 }).start();
  try {
    const echo = await fetch(`${handle.url}api/echo?q=hello`);
    assert.equal(echo.status, 200);
    assert.deepEqual(await echo.json(), { q: "hello", items: [1, 2] });
    const broken = await fetch(`${handle.url}api/broken`);
    assert.equal(broken.status, 500);
    assert.match(((await broken.json()) as { message: string }).message, /boom/);
    for (const name of ["missing", "constructor", "toString", "__proto__"]) {
      const response = await fetch(`${handle.url}api/${name}`);
      assert.equal(response.status, 404, `/api/${name}`);
      await response.arrayBuffer();
    }
    const snapshot = await fetch(`${handle.url}api/snapshot`);
    assert.equal(snapshot.status, 500, "the built-in snapshot route is not shadowed by a host query (the stub host throws)");
    await snapshot.arrayBuffer();
    const health = (await (await fetch(`${handle.url}api/health`)).json()) as { ok: boolean; app: string; version: string; sessionState: string };
    assert.deepEqual({ ok: health.ok, app: health.app, version: health.version, sessionState: health.sessionState }, { ok: true, app: "gamemind", version: "9.9.9", sessionState: "idle" });
  } finally {
    await handle.stop("test complete");
  }
});

test("the page carries a content security policy that still allows the preview to embed it", async () => {
  const handle = await new ControlCenter(stubHost, { port: 0 }).start();
  try {
    const page = await fetch(handle.url);
    const policy = page.headers.get("content-security-policy") ?? "";
    assert.match(policy, /script-src 'self'/);
    assert.match(policy, /connect-src 'self'/);
    assert.doesNotMatch(policy, /frame-ancestors/, "the hosted preview shows the app in a frame");
    assert.equal(page.headers.get("x-frame-options"), null);
    await page.arrayBuffer();
  } finally {
    await handle.stop("test complete");
  }
});

test("stop() resolves promptly even when a browser keeps a connection open", async () => {
  const handle = await new ControlCenter(stubHost, { port: 0 }).start();
  const { Agent } = await import("node:http");
  const agent = new Agent({ keepAlive: true });
  await new Promise<void>((resolve, reject) => {
    const outgoing = httpRequest(`${handle.url}api/health`, { agent }, (response) => {
      response.resume();
      response.on("end", () => resolve());
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
  const started = Date.now();
  await handle.stop("test complete");
  assert.ok(Date.now() - started < 3_000, `shutdown took ${Date.now() - started} ms with a keep-alive client connected`);
  agent.destroy();
});
