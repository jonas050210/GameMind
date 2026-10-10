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
