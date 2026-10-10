// The landing page (docs/index.html) in real Chromium: every section, the animated diagrams, the CRDT explorer on the
// library build, the two-peer demo chatting through the local signaling server, the theme switch and the phone layout.
// Every test fails on a console error, an uncaught exception, a failed request or an HTTP error response.
import { expect, test } from "@playwright/test";
import { DEFAULT_SIGNAL_URL, DOCS_URL, SERVER_PASSWORD, SIGNAL_URL } from "./env.mjs";

/** Opens the landing page with problem tracking; the demo frames' default server is answered locally. */
async function open(page, context) {
  const problems = [];
  page.on("console", (message) => { if (message.type() === "error") problems.push(`console: ${message.text()}`); });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("requestfailed", (request) => problems.push(`failed: ${request.url()} ${request.failure()?.errorText}`));
  page.on("response", (response) => { if (response.status() >= 400) problems.push(`HTTP ${response.status()}: ${response.url()}`); });
  if (SIGNAL_URL !== DEFAULT_SIGNAL_URL) {
    // The demo frames list rooms on their built-in default server; a local run never touches production.
    await context.route(`${DEFAULT_SIGNAL_URL}/**`, (route) => route.fulfill({
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: "[]",
    }));
  }
  await page.goto(DOCS_URL);
  return problems;
}

test("every section of the landing page is reachable from the navigation", async ({ page, context }) => {
  const problems = await open(page, context);
  for (const [link, section] of [["Demo", "#demo"], ["How it works", "#how"], ["Server", "#server"], ["CRDT explorer", "#explorer"], ["API", "#api"]]) {
    await page.locator(".mk-header-nav").getByRole("link", { name: link, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${section}$`));
    await expect(page.locator(section)).toBeInViewport();
  }
  for (const section of ["#install", "#model"]) {
    await page.locator(`.mk-footer a[href="${section}"], .mk-header a[href="${section}"]`).first().click();
    await expect(page.locator(section)).toBeInViewport();
  }
  // Both hosting tabs and every API tab show their panel.
  await page.getByRole("tab", { name: "Vercel (serverless)" }).click();
  await expect(page.locator("#host-vercel")).toContainText("Upstash Redis");
  for (const tab of ["Signal bundle", "Room server HTTP", "CRDT document", "CRDT wire", "ManualPeer"]) {
    await page.getByRole("tab", { name: tab, exact: true }).click();
    await expect(page.locator(`#${await page.getByRole("tab", { name: tab, exact: true }).getAttribute("aria-controls")}`)).toBeVisible();
  }
  expect(problems).toEqual([]);
});

test("the three signaling and sync diagrams and the data model play message by message", async ({ page, context }) => {
  const problems = await open(page, context);
  await page.waitForFunction(() => typeof window.df$?.shadcn?.diagram?.steps === "function");
  const steps = await page.evaluate(() => Object.fromEntries(["flow-room", "flow-manual", "flow-crdt", "room-model"]
    .map((id) => [id, window.df$.shadcn.diagram.steps(document.getElementById(id)).max])));
  // One step per message (14, 8, 9) and per entity of the model (5): nothing in the markup was dropped.
  expect(steps).toEqual({ "flow-room": 14, "flow-manual": 8, "flow-crdt": 9, "room-model": 5 });
  // Clicking a box explains it in the diagram's output.
  await page.locator("#flow-room").scrollIntoViewIfNeeded();
  await page.evaluate(() => window.df$.shadcn.diagram.reset("#flow-room"));
  await page.locator('#flow-room [data-node="server"]').click();
  await expect(page.locator('output[data-diagram-for="flow-room"]')).toContainText("never sees the data channel");
  expect(problems).toEqual([]);
});

test("the CRDT explorer merges two offline replicas on the library build", async ({ page, context }) => {
  const problems = await open(page, context);
  const merged = page.locator("#res-merged-code");
  const badge = page.locator("#ex-converged");
  // The default scenario is merged on load, highlighted as JSON.
  await expect(badge).toHaveText("A = B: converged");
  await expect(merged).toContainText('"votes": 8');
  await expect(merged.locator(".mk-code-block-k").first()).toBeVisible();
  await expect(page.locator('[data-editor-view="a"] .mk-code-block-s').first()).toBeAttached();

  const scenarios = [
    ["same register", '"title": "Weekend shopping"'],
    ["counter", '"votes": 8'],
    ["add vs. delete", /"tags": \[\s+"offline",\s+"p2p"\s+\]/],
    ["both append", /"text": "hello"[\s\S]*"text": "B: me too"[\s\S]*"text": "A: written offline"/],
    ["delete vs. edit", '"todos": {}'],
  ];
  for (const [preset, expected] of scenarios) {
    await page.getByRole("button", { name: preset, exact: true }).click();
    await expect(badge).toHaveText("A = B: converged");
    await expect(merged).toContainText(expected);
  }

  // An edit marks the result stale; Ctrl+Enter merges again.
  await page.locator("#ex-b").fill('[\n  ["set", ["title"], "Edited by B"]\n]');
  await expect(page.locator("#ex-stale")).toContainText("merge again");
  await page.locator("#ex-b").press("Control+Enter");
  await expect(page.locator("#ex-stale")).toHaveText("");
  await expect(merged).toContainText('"title": "Edited by B"');

  // What A sends after B's hello is an ops message of the CRDT wire protocol.
  await page.getByRole("tab", { name: "On the wire, A → B" }).click();
  await expect(page.locator("#res-wire-code")).toContainText('"kind": "ops"');

  // A call the schema rejects is reported, and nothing is shown as merged.
  await page.getByRole("button", { name: "a call that fails", exact: true }).click();
  await expect(page.locator("#ex-error")).toBeVisible();
  await expect(page.locator("#ex-error-message")).toContainText("replica-a.json, call 1 (set): set() requires register schema");
  await expect(badge).toHaveText("not merged");
  await page.locator("#ex-a").fill("not json");
  await page.locator("#ex-merge").click();
  await expect(page.locator("#ex-error-message")).toContainText("replica-a.json: ");
  expect(problems).toEqual([]);
});

test("the two-peer demo starts on click, each frame its own peer in one room, and they chat", async ({ page, context }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const problems = await open(page, context);
  await expect(page.locator("#playground iframe")).toHaveCount(0); // nothing loads before the click
  await page.locator("#playground-start").click();
  const peers = { a: page.frameLocator('iframe[title^="Peer A"]'), b: page.frameLocator('iframe[title^="Peer B"]') };

  // One tab, two frames: each slot keeps its own identity, and both share the room name the page picked.
  const ids = {};
  for (const [slot, frame] of Object.entries(peers)) {
    await expect(frame.locator("#peer-label")).toHaveText(`Peer ${slot.toUpperCase()}`);
    await expect(frame.locator("#nickname")).toHaveValue(`Peer ${slot.toUpperCase()}`);
    ids[slot] = (await frame.locator("#identity-status").textContent()).match(/[0-9a-f-]{36}/)[0];
  }
  expect(ids.a).not.toBe(ids.b);
  const room = await peers.a.locator("#room-name").inputValue();
  expect(room).toMatch(/^demo-[a-z0-9]+$/);
  await expect(peers.b.locator("#room-name")).toHaveValue(room);

  // The theme switch repaints both frames.
  const dark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
  await page.locator(".mk-header-actions .swap").click();
  for (const frame of Object.values(peers)) {
    await expect(frame.locator("html")).toHaveClass(dark ? /^(?!.*\bdark\b)/ : /\bdark\b/);
  }

  // Each frame walks the connect wizard: mode, signaling server, this peer, room.
  for (const frame of Object.values(peers)) {
    await expect(frame.locator('ol[data-steps-for="room"] li[aria-current="step"]')).toContainText("Mode");
    await frame.locator("#wizard-next").click(); // 1 mode: the room server is preselected
    // The password first: the URL's change event lists the rooms, which without it is a 401.
    await frame.locator("#server-password").fill(SERVER_PASSWORD);
    await frame.locator("#server-url").fill(SIGNAL_URL);
    await frame.locator("#server-url").dispatchEvent("change");
    await frame.locator("#wizard-next").click(); // 2 signal server
    await frame.locator("#stun-servers").fill(""); // host candidates only: both peers share this machine
    await frame.locator("#wizard-next").click(); // 3 this peer
    await expect(frame.locator('ol[data-steps-for="room"] li[aria-current="step"]')).toContainText("Room");
  }
  await peers.a.locator("#create-room").click();
  await expect(peers.a.locator("#room-status")).toContainText(`In room "${room}"`);
  await peers.b.locator("#join-room").click();
  await expect(peers.b.locator("#room-status")).toContainText(`In room "${room}"`);
  for (const frame of Object.values(peers)) {
    await expect(frame.locator("#connections li", { hasText: "channel open" })).toHaveCount(1, { timeout: 30_000 });
  }
  await peers.a.locator("#message-input").fill("hello from the landing page");
  await peers.a.locator("#message-input").press("Enter");
  await expect(peers.b.locator("#messages .bubble-content")).toHaveText(["hello from the landing page"]);
  await expect(peers.b.locator("#link-status")).toHaveText("1 peer connected");
  // The first tab is now the chat; the devtools tab next to it shows the CRDT document that carried the message.
  await expect(peers.b.locator("#tab-main")).toHaveText("Chat");
  await peers.b.getByRole("tab", { name: "Peer devtools" }).click();
  await expect(peers.b.locator("#crdt-state")).toBeVisible();
  await expect(peers.b.locator("#crdt-state")).toContainText("hello from the landing page");
  await expect(peers.b.locator("#messages")).toBeHidden();
  await peers.b.getByRole("tab", { name: "Chat" }).click();

  for (const frame of Object.values(peers)) await frame.locator("#leave-room").click();
  expect(problems).toEqual([]);
});

test("at phone width the page never scrolls sideways and the menu sheet navigates", async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const problems = await open(page, context);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  await page.getByRole("button", { name: "Open menu" }).click();
  const sheet = page.locator("#wr-menu");
  await expect(sheet).toBeVisible();
  await sheet.getByRole("link", { name: /^API/ }).click();
  await expect(sheet).toBeHidden();
  await expect(page.locator("#api")).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  expect(problems).toEqual([]);
});
