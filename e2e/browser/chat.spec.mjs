// Multi-peer browser tests for the docs chat app: every peer is its own browser
// context (isolated sessionStorage = its own identity), driving the real UI of
// docs/index.html against a signaling server, then chatting over WebRTC.
import { expect, test } from "@playwright/test";
import { DEFAULT_SIGNAL_URL, DOCS_URL, REMOTE, SERVER_PASSWORD, SIGNAL_URL } from "./env.mjs";

// What the intercepted default server answers — slowly, so it arrives after the
// target server's list. It must never be rendered (room-list race regression).
const DEFAULT_SERVER_ROOM = "room-from-the-default-server";

const RUN = Math.random().toString(36).slice(2, 8);
let totalSignalRequests = 0;
let roomCounter = 0;
const uniqueRoom = (label) => `pw-${RUN}-${label}-${++roomCounter}`;

/** One chat participant: a browser context with the docs app, configured for the target server. */
class Peer {
  constructor(page, context, nickname) {
    this.page = page;
    this.context = context;
    this.nickname = nickname;
    this.errors = [];
    this.signalRequests = 0;
    this.logMark = 0; // log length before the current step; failures are only looked for after it
    page.on("pageerror", (error) => this.errors.push(error.message));
    context.on("request", (request) => {
      if (request.url().startsWith(SIGNAL_URL)) this.signalRequests += 1;
    });
  }

  /** Starts a new step: later "…failed" log lines abort waits immediately. */
  async mark() {
    this.logMark = ((await this.page.locator("#log").textContent()) ?? "").length;
  }

  /**
   * Waits until `condition` (evaluated in the page) holds — but fails fast as soon as
   * the app logs a "…failed" line during this step, instead of letting every peer keep
   * polling the signaling server until the timeout.
   */
  async until(description, condition, arg) {
    const outcome = await this.page
      .waitForFunction(
        ([source, arg, mark]) => {
          if (new Function("arg", `return (${source})(arg)`)(arg)) return "ok";
          const failed = document.querySelector("#log").textContent.slice(mark).split("\n").find((line) => /failed/i.test(line));
          return failed ? `failed: ${failed}` : false;
        },
        [condition.toString(), arg, this.logMark],
        { timeout: 30_000 },
      )
      .then((handle) => handle.jsonValue())
      .catch((error) => `timeout (${error.message.split("\n")[0]})`);
    if (outcome !== "ok") throw new Error(`${this.nickname}: ${description} — ${outcome}`);
  }

  static async open(browser, nickname, { serverPassword = SERVER_PASSWORD } = {}) {
    const context = await browser.newContext();
    let defaultServerAnswered = () => {};
    const defaultServerDone = new Promise((resolve) => { defaultServerAnswered = resolve; });
    if (SIGNAL_URL !== DEFAULT_SIGNAL_URL) {
      // The page fetches the room list from its built-in default server on load;
      // never let a local test run hit production.
      await context.route(`${DEFAULT_SIGNAL_URL}/**`, async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        await route.fulfill({
          contentType: "application/json",
          headers: { "access-control-allow-origin": "*" },
          body: JSON.stringify([{ name: DEFAULT_SERVER_ROOM, memberCount: 1, createdAt: 0, protected: false }]),
        }).catch(() => {}); // page may be gone already
        defaultServerAnswered();
      });
    }
    const peer = new Peer(await context.newPage(), context, nickname);
    peer.defaultServerDone = defaultServerDone;
    peer.serverPassword = serverPassword;
    await peer.page.goto(DOCS_URL);
    await peer.configure();
    return peer;
  }

  /** Reloads the tab (sessionStorage — and so the peer id — survives) and sets it up again. */
  async reload() {
    await this.page.reload();
    this.logMark = 0;
    await this.configure();
  }

  async configure() {
    const { page, nickname, serverPassword } = this;
    await page.fill("#server-url", SIGNAL_URL);
    await page.locator("#server-url").dispatchEvent("change");
    await page.fill("#server-password", serverPassword);
    await page.locator("#server-password").dispatchEvent("change");
    await page.fill("#stun-servers", ""); // host candidates only: all peers share this machine
    await page.fill("#nickname", nickname);
    await page.click("#set-nickname");
    await expect(page.locator("#log")).toContainText(`Nickname set to "${nickname}"`);
  }

  async peerId() {
    return (await this.page.textContent("#identity-status")).match(/[0-9a-f-]{36}/)[0];
  }

  /** Emulates the tab being hidden / shown (Page Visibility API). */
  async setHidden(hidden) {
    await this.page.evaluate((hidden) => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
      document.dispatchEvent(new Event("visibilitychange"));
    }, hidden);
  }

  openChannels() {
    return this.page.locator("#connections li", { hasText: "channel open" });
  }

  async create(room, { password = "" } = {}) {
    await this.mark();
    await this.page.fill("#room-name", room);
    await this.page.fill("#room-password", password);
    await this.page.click("#create-room");
    await this.inRoom(room);
  }

  async inRoom(room) {
    await this.until(`enter room ${room}`, (room) => document.querySelector("#room-status").textContent.includes(`In room "${room}"`), room);
  }

  async join(room, { password = "" } = {}) {
    await this.page.fill("#room-name", room);
    await this.page.fill("#room-password", password);
    await this.page.click("#join-room");
  }

  async joined(room, options) {
    await this.mark();
    await this.join(room, options);
    await this.inRoom(room);
  }

  async send(text) {
    await this.page.fill("#message-input", text);
    await this.page.press("#message-input", "Enter");
  }

  /** Waits until this peer holds `count` open data channels. */
  async expectOpenChannels(count) {
    await this.until(
      `${count} open channel(s)`,
      (count) => [...document.querySelectorAll("#connections li")].filter((li) => li.textContent.includes("channel open")).length === count,
      count,
    );
  }

  messages() {
    return this.page.locator("#messages .message .text").allTextContents();
  }

  async expectMessages(texts) {
    await expect(this.page.locator("#messages .message .text")).toHaveText(texts);
  }

  async close() {
    if (await this.page.locator("#leave-room").isEnabled().catch(() => false)) {
      await this.page.click("#leave-room");
      await expect(this.page.locator("#log")).toContainText("Left room");
    }
    await this.context.close();
  }
}

let peers = [];
async function open(browser, nickname, options) {
  const peer = await Peer.open(browser, nickname, options);
  peers.push(peer);
  return peer;
}

test.afterEach(async ({}, testInfo) => {
  const requests = peers.reduce((sum, peer) => sum + peer.signalRequests, 0);
  totalSignalRequests += requests;
  testInfo.annotations.push({ type: "signaling requests", description: String(requests) });
  if (testInfo.status !== testInfo.expectedStatus) {
    // Each peer's in-app log is the most useful failure evidence (signaling, channel events).
    for (const peer of peers) {
      const log = await peer.page.locator("#log").textContent().catch(() => "(page closed)");
      await testInfo.attach(`log-${peer.nickname}`, { body: log ?? "", contentType: "text/plain" });
    }
  }
  const errors = peers.flatMap((peer) => peer.errors.map((error) => `${peer.nickname}: ${error}`));
  await Promise.all(peers.map((peer) => peer.close().catch(() => {})));
  peers = [];
  expect(errors, "uncaught page errors").toEqual([]);
});

test.afterAll(() => {
  console.log(`signaling requests sent by this worker: ${totalSignalRequests}`);
});

test.beforeAll(() => {
  console.log(`signaling: ${SIGNAL_URL} (${REMOTE ? "remote" : "local Express"}), server password: ${SERVER_PASSWORD ? "yes" : "no"}`);
});

test("three peers form a full mesh and every message reaches everyone @remote", async ({ browser }) => {
  const room = uniqueRoom("mesh");
  const [alice, bob, carol] = [await open(browser, "Alice"), await open(browser, "Bob"), await open(browser, "Carol")];

  await alice.create(room);
  await bob.joined(room);
  await carol.joined(room);
  for (const peer of [alice, bob, carol]) await peer.expectOpenChannels(2);

  await alice.send("hi from Alice");
  for (const peer of [alice, bob, carol]) await peer.expectMessages(["hi from Alice"]);
  await carol.send("hi from Carol");
  await bob.send("hi from Bob");

  // Everyone converges on the same transcript (the order is the CRDT's, not arrival order).
  await expect.poll(async () => (await bob.messages()).length).toBe(3);
  const transcript = await bob.messages();
  for (const peer of [alice, carol]) await peer.expectMessages(transcript);
  expect([...transcript].sort()).toEqual(["hi from Alice", "hi from Bob", "hi from Carol"]);

  // Own messages are marked, and nicknames propagate through the CRDT.
  await expect(alice.page.locator("#messages .message.own .text")).toHaveText(["hi from Alice"]);
  await expect(alice.page.locator("#messages .message", { hasText: "hi from Carol" }).locator(".meta")).toContainText("Carol");
  await expect(alice.page.locator("#members")).toContainText("Bob");
  await expect(alice.page.locator("#members")).toContainText("Carol");
  await expect(alice.page.locator("#room-status")).toHaveText(`In room "${room}" — Alice (you) ★, Bob, Carol`);
});

test("concurrent messages from all peers converge to one identical order", async ({ browser }) => {
  const room = uniqueRoom("concurrent");
  const all = [await open(browser, "Ann"), await open(browser, "Ben"), await open(browser, "Cat")];
  await all[0].create(room);
  await all[1].joined(room);
  await all[2].joined(room);
  for (const peer of all) await peer.expectOpenChannels(2);

  // Fire 3 messages per peer at the same time.
  await Promise.all(all.map(async (peer) => {
    for (let i = 1; i <= 3; i += 1) await peer.send(`${peer.nickname} #${i}`);
  }));

  await expect.poll(async () => (await all[0].messages()).length).toBe(9);
  const transcript = await all[0].messages();
  for (const peer of all.slice(1)) await peer.expectMessages(transcript);
  // Each author's own messages keep their relative order.
  for (const peer of all) {
    expect(transcript.filter((text) => text.startsWith(peer.nickname))).toEqual([1, 2, 3].map((i) => `${peer.nickname} #${i}`));
  }
});

test("a late joiner receives the full chat history", async ({ browser }) => {
  const room = uniqueRoom("history");
  const [alice, bob] = [await open(browser, "Alice"), await open(browser, "Bob")];
  await alice.create(room);
  await bob.joined(room);
  await alice.expectOpenChannels(1);
  await alice.send("before you came");
  await bob.send("me too");
  await expect.poll(async () => (await alice.messages()).length).toBe(2);
  const history = await alice.messages();

  const carol = await open(browser, "Carol");
  await carol.joined(room);
  await carol.expectOpenChannels(2);
  await carol.expectMessages(history);
  await carol.send("hello, I'm new");
  for (const peer of [alice, bob]) await peer.expectMessages([...history, "hello, I'm new"]);
});

test("a leaving peer drops out of the mesh; the others keep chatting", async ({ browser }) => {
  const room = uniqueRoom("leave");
  const [alice, bob, carol] = [await open(browser, "Alice"), await open(browser, "Bob"), await open(browser, "Carol")];
  await alice.create(room);
  await bob.joined(room);
  await carol.joined(room);
  for (const peer of [alice, bob, carol]) await peer.expectOpenChannels(2);

  await bob.page.click("#leave-room");
  await expect(bob.page.locator("#log")).toContainText(`Left room "${room}"`);
  await expect(bob.page.locator("#message-input")).toBeDisabled();
  for (const peer of [alice, carol]) await peer.expectOpenChannels(1);
  await expect(alice.page.locator("#room-status")).toHaveText(`In room "${room}" — Alice (you) ★, Carol`);

  await carol.send("just us now");
  await alice.expectMessages(["just us now"]);
  await expect(bob.page.locator("#messages .message")).toHaveCount(0); // Bob is no longer in a room
});

test("a password-protected room only admits peers with the password @remote", async ({ browser }) => {
  const room = uniqueRoom("secret");
  const password = "rööm & pässword";
  const [alice, bob] = [await open(browser, "Alice"), await open(browser, "Bob")];
  await alice.create(room, { password });

  // The room list marks it, and "Join" without a password asks for one instead of failing.
  const listed = bob.page.locator("#rooms li", { hasText: room });
  await expect(listed.locator(".badge", { hasText: "password" })).toBeVisible({ timeout: 15_000 });
  await listed.getByRole("button", { name: "Join" }).click();
  await expect(bob.page.locator("#log")).toContainText(`Room "${room}" is password protected`);
  await expect(bob.page.locator("#room-password")).toBeFocused();

  await bob.join(room, { password: "wrong" });
  await expect(bob.page.locator("#log")).toContainText(`Join failed: Wrong password for room "${room}"`);
  await expect(bob.page.locator("#message-input")).toBeDisabled();
  // (joined() starts a new step, so the expected failure above does not trip fail-fast)

  await bob.joined(room, { password });
  for (const peer of [alice, bob]) await peer.expectOpenChannels(1);
  await bob.send("the password worked");
  await alice.expectMessages(["the password worked"]);
});

test("a wrong server password is reported and blocks room actions", async ({ browser }) => {
  test.skip(!SERVER_PASSWORD, "target has no server password");
  const eve = await open(browser, "Eve", { serverPassword: "wrong" });
  await expect(eve.page.locator("#rooms")).toContainText("Wrong server password.");
  await eve.page.fill("#room-name", uniqueRoom("denied"));
  await eve.page.click("#create-room");
  await expect(eve.page.locator("#log")).toContainText("Create room failed: Wrong server password");
  await expect(eve.page.locator("#message-input")).toBeDisabled();
});

// ---------------------------------------------------------------------------
// Reconnection. These waits use plain expect() rather than fail-fast until():
// "…failed" log lines are expected while a peer is offline or reconnecting.
// ---------------------------------------------------------------------------

test("a dropped connection heals and diverged chat state converges", async ({ browser }) => {
  const room = uniqueRoom("heal");
  const [alice, bob] = [await open(browser, "Alice"), await open(browser, "Bob")];
  await alice.create(room);
  await bob.joined(room);
  await expect(alice.openChannels()).toHaveCount(1);
  await expect(bob.openChannels()).toHaveCount(1);
  await alice.send("while connected");
  await bob.expectMessages(["while connected"]);

  // Bob loses the network and his link to Alice dies (sleep, Wi-Fi drop, …).
  await bob.context.setOffline(true);
  await expect(bob.page.locator("#net-status")).toHaveText(/offline/);
  await bob.page.evaluate(() => { for (const conn of window.__defuss.connections.values()) conn.peer.close(); });
  await expect(alice.openChannels()).toHaveCount(0);
  await expect(bob.openChannels()).toHaveCount(0);

  // Both keep writing while apart: the states diverge.
  await alice.send("Alice while apart");
  await bob.send("Bob while apart");
  await expect(bob.page.locator("#messages .message .text")).toHaveText(["while connected", "Bob while apart"]);
  await alice.page.waitForTimeout(3000);
  expect(await alice.messages()).toEqual(["while connected", "Alice while apart"]);

  // Back online: the link is re-established and both converge on one transcript.
  await bob.context.setOffline(false);
  await expect(bob.page.locator("#net-status")).toHaveText(/online/);
  await expect(alice.openChannels()).toHaveCount(1);
  await expect(bob.openChannels()).toHaveCount(1);
  await expect.poll(async () => (await alice.messages()).length).toBe(3);
  const transcript = await alice.messages();
  await bob.expectMessages(transcript);
  expect([...transcript].sort()).toEqual(["Alice while apart", "Bob while apart", "while connected"]);
});

test("a reloaded tab rejoins with the same identity and its new messages are not lost", async ({ browser }) => {
  const room = uniqueRoom("reload");
  const [alice, bob] = [await open(browser, "Alice"), await open(browser, "Bob")];
  await alice.create(room);
  await bob.joined(room);
  await expect(alice.openChannels()).toHaveCount(1);
  await bob.send("before reload");
  await alice.expectMessages(["before reload"]);
  const bobId = await bob.peerId();

  await bob.reload();
  expect(await bob.peerId()).toBe(bobId); // same identity after the reload
  await bob.join(room);
  await expect(bob.page.locator("#room-status")).toContainText(`In room "${room}"`);
  // Written right away — before the old history has synced back to the fresh page.
  await bob.send("right after reload");

  await expect(alice.openChannels()).toHaveCount(1); // the dead link was replaced, not duplicated
  await expect(bob.openChannels()).toHaveCount(1);
  await alice.expectMessages(["before reload", "right after reload"]);
  await bob.expectMessages(["before reload", "right after reload"]);
  await expect(alice.page.locator("#room-status")).toHaveText(`In room "${room}" — Alice (you) ★, Bob`);
});

test("a peer the server dropped rejoins automatically", async ({ browser }) => {
  const room = uniqueRoom("dropped");
  const [alice, bob] = [await open(browser, "Alice"), await open(browser, "Bob")];
  await alice.create(room);
  await bob.joined(room);
  await expect(alice.openChannels()).toHaveCount(1);

  // Simulate the server timing Bob out (as after >90 s asleep): remove his membership.
  const headers = { "content-type": "application/json", ...(SERVER_PASSWORD ? { "x-server-password": encodeURIComponent(SERVER_PASSWORD) } : {}) };
  const response = await fetch(`${SIGNAL_URL}/v1/rooms/${room}/leave`, { method: "POST", headers, body: JSON.stringify({ peerId: await bob.peerId() }) });
  expect(response.status).toBe(200);

  await expect(bob.page.locator("#log")).toContainText("rejoining");
  await expect(bob.page.locator("#room-status")).toHaveText(`In room "${room}" — Alice ★, Bob (you)`);
  await expect(alice.openChannels()).toHaveCount(1);
  await expect(bob.openChannels()).toHaveCount(1);
  await bob.send("still here");
  await alice.expectMessages(["still here"]);
  await expect(bob.page.locator("#leave-room")).toBeEnabled(); // never left the room
});

test("a hidden tab polls slowly and resyncs as soon as it is visible again", async ({ browser }) => {
  const room = uniqueRoom("hidden");
  const alice = await open(browser, "Alice");
  await alice.create(room);
  await alice.page.waitForTimeout(1000);

  await alice.setHidden(true);
  const hiddenStart = alice.signalRequests;
  await alice.page.waitForTimeout(8000);
  expect(alice.signalRequests - hiddenStart, "requests while hidden for 8 s").toBeLessThanOrEqual(1);

  const beforeVisible = alice.signalRequests;
  await alice.setHidden(false);
  await expect.poll(() => alice.signalRequests - beforeVisible, { timeout: 1500 }).toBeGreaterThanOrEqual(1);
});

// ---------------------------------------------------------------------------
// Room controls feedback
// ---------------------------------------------------------------------------

test("creating a room that already exists is explained next to the buttons", async ({ browser }) => {
  const room = uniqueRoom("taken");
  const [alice, bob] = [await open(browser, "Alice"), await open(browser, "Bob")];
  await alice.create(room);

  await bob.page.fill("#room-name", room);
  await bob.page.click("#create-room");
  const alert = bob.page.locator("#room-alert");
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("Room already exists");
  await expect(alert).toContainText(`"${room}" is already taken`);

  await bob.page.click("#join-room"); // the suggested way out
  await expect(bob.page.locator("#room-status")).toContainText(`In room "${room}"`);
  await expect(alert).toBeHidden();
});

test("a password typed for one room never protects the next one", async ({ browser }) => {
  const secret = uniqueRoom("locked");
  const next = uniqueRoom("next");
  const [alice, bob] = [await open(browser, "Alice"), await open(browser, "Bob")];
  await alice.create(secret, { password: "right" });

  await bob.join(secret, { password: "wrong" });
  await expect(bob.page.locator("#room-alert")).toContainText(`Wrong password for room "${secret}"`);

  await bob.page.fill("#room-name", next); // a new name: the stale password must go
  await expect(bob.page.locator("#room-password")).toHaveValue("");
  await expect(bob.page.locator("#room-alert")).toBeHidden();
  await bob.page.click("#create-room");
  await expect(bob.page.locator("#room-status")).toContainText(`In room "${next}"`);
  await expect(bob.page.locator("#log")).not.toContainText(`Room "${next}" created (password protected)`);

  const headers = SERVER_PASSWORD ? { "x-server-password": encodeURIComponent(SERVER_PASSWORD) } : {};
  const rooms = await (await fetch(`${SIGNAL_URL}/v1/rooms`, { headers })).json();
  expect(rooms.find((entry) => entry.name === next)?.protected).toBe(false);
});

test("the room list shows only the configured server and pauses inside a room", async ({ browser }) => {
  const room = uniqueRoom("list");
  const alice = await open(browser, "Alice");
  await alice.create(room);
  const bob = await open(browser, "Bob");

  // Right after the slow default-server answer lands — before any periodic refresh
  // (every 5 s) could paper over it — the list must still be the configured server's.
  await bob.defaultServerDone;
  await bob.page.waitForTimeout(150);
  expect(await bob.page.textContent("#rooms")).not.toContain(DEFAULT_SERVER_ROOM);
  await expect(bob.page.locator("#rooms")).toContainText(room);

  await bob.joined(room);
  await expect(bob.page.locator("#rooms")).toHaveText(/Paused while you are in a room/);
  await bob.page.click("#leave-room");
  await expect(bob.page.locator("#rooms")).toContainText(room);
});
