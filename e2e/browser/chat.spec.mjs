// Multi-peer browser tests for the docs chat app: every peer is its own browser
// context (isolated sessionStorage = its own identity), driving the real UI of
// docs/index.html against a signaling server, then chatting over WebRTC.
import { expect, test } from "@playwright/test";
import { DOCS_URL, REMOTE, SERVER_PASSWORD, SIGNAL_URL } from "./env.mjs";

const RUN = Math.random().toString(36).slice(2, 8);
let roomCounter = 0;
const uniqueRoom = (label) => `pw-${RUN}-${label}-${++roomCounter}`;

/** One chat participant: a browser context with the docs app, configured for the target server. */
class Peer {
  constructor(page, context, nickname) {
    this.page = page;
    this.context = context;
    this.nickname = nickname;
    this.errors = [];
    page.on("pageerror", (error) => this.errors.push(error.message));
  }

  static async open(browser, nickname, { serverPassword = SERVER_PASSWORD } = {}) {
    const context = await browser.newContext();
    const peer = new Peer(await context.newPage(), context, nickname);
    const { page } = peer;
    await page.goto(DOCS_URL);
    await page.fill("#server-url", SIGNAL_URL);
    await page.locator("#server-url").dispatchEvent("change");
    await page.fill("#server-password", serverPassword);
    await page.locator("#server-password").dispatchEvent("change");
    await page.fill("#stun-servers", ""); // host candidates only: all peers share this machine
    await page.fill("#nickname", nickname);
    await page.click("#set-nickname");
    await expect(page.locator("#log")).toContainText(`Nickname set to "${nickname}"`);
    return peer;
  }

  async create(room, { password = "" } = {}) {
    await this.page.fill("#room-name", room);
    await this.page.fill("#room-password", password);
    await this.page.click("#create-room");
    await expect(this.page.locator("#room-status")).toContainText(`In room "${room}"`);
  }

  async join(room, { password = "" } = {}) {
    await this.page.fill("#room-name", room);
    await this.page.fill("#room-password", password);
    await this.page.click("#join-room");
  }

  async joined(room, options) {
    await this.join(room, options);
    await expect(this.page.locator("#room-status")).toContainText(`In room "${room}"`);
  }

  async send(text) {
    await this.page.fill("#message-input", text);
    await this.page.press("#message-input", "Enter");
  }

  /** Waits until this peer holds `count` open data channels. */
  async expectOpenChannels(count) {
    await expect(this.page.locator("#connections li", { hasText: "channel open" })).toHaveCount(count);
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

test.beforeAll(() => {
  console.log(`signaling: ${SIGNAL_URL} (${REMOTE ? "remote" : "local Express"}), server password: ${SERVER_PASSWORD ? "yes" : "no"}`);
});

test("three peers form a full mesh and every message reaches everyone", async ({ browser }) => {
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

test("a password-protected room only admits peers with the password", async ({ browser }) => {
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
