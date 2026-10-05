import { execFile, spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import type { AnnotationFile, SentAnnotation } from "../shared/types.ts";
import { serve } from "../server/serve.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repo, "server", "cli.ts");
const shots = join(repo, "test-results", "screens");
const run = promisify(execFile);

let root: string;
let port: number;
let close: () => void;

test.beforeAll(async () => {
  if (!existsSync(join(repo, "dist", "index.html"))) throw new Error("Run `vp build` first");
  root = mkdtempSync(join(tmpdir(), "howbench-e2e-"));
  cpSync(join(repo, "samples"), root, { recursive: true });
  const configFile = join(mkdtempSync(join(tmpdir(), "howbench-config-")), "config.json");
  ({ port, close } = await serve({ root, port: 0, user: "Ruth Ellis", configFile }));
});

test.afterAll(() => {
  close?.();
  rmSync(root, { recursive: true, force: true });
});

/** Runs `howbench <args>` against the test server and returns stdout. */
async function howbench(...args: string[]) {
  const { stdout } = await run(process.execPath, [cli, ...args, "--port", String(port)]);
  return stdout;
}

/** Starts `howbench wait` and resolves with what it prints when it exits. */
function startWait(): Promise<SentAnnotation[]> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cli, "wait", "--port", String(port)]);
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("exit", (code) =>
      code === 0
        ? resolvePromise(JSON.parse(out) as SentAnnotation[])
        : reject(new Error(out + err)),
    );
  });
}

function annotationFile(video: string): AnnotationFile {
  return JSON.parse(readFileSync(join(root, video + ".howbench.json"), "utf8")) as AnnotationFile;
}

async function openVideo(page: Page, path: string) {
  await page.locator(`[data-path="${path}"]`).click();
  await expect(page.getByTestId("time")).toHaveText("0:00 / 0:12");
}

/** Seeks by clicking the scrubber at a fraction of its width. */
async function seekTo(page: Page, fraction: number) {
  const box = (await page.getByTestId("track").boundingBox())!;
  await page.mouse.click(box.x + box.width * fraction, box.y + box.height - 3);
}

async function stagePoint(page: Page, xPct: number, yPct: number) {
  const box = (await page.getByTestId("stage").boundingBox())!;
  return { x: box.x + (box.width * xPct) / 100, y: box.y + (box.height * yPct) / 100 };
}

async function addPin(page: Page, xPct: number, yPct: number, text: string) {
  const p = await stagePoint(page, xPct, yPct);
  await page.mouse.click(p.x, p.y);
  const draft = page.getByTestId("draft");
  await expect(draft).toContainText("PIN");
  await draft.locator("textarea").fill(text);
  await draft.locator("textarea").press("Control+Enter");
  await expect(draft).toBeHidden();
}

test("annotate videos, send them to Claude, and see Claude's replies", async ({ page }) => {
  // With nothing sent, each wait request comes back empty after its hold time, and
  // `howbench wait` keeps asking until its own --timeout.
  const started = Date.now();
  const res = await fetch(`http://127.0.0.1:${port}/api/wait?hold=1`);
  expect(await res.json()).toEqual([]);
  expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  expect(JSON.parse(await howbench("wait", "--timeout", "3"))).toEqual([]);
  expect(Date.now() - started).toBeGreaterThanOrEqual(3900);

  await page.goto(`http://127.0.0.1:${port}/`);

  // Header, folder tree and reviewer.
  await expect(page.locator(".brand-name")).toHaveText("HowBench");
  await expect(page.locator(".tree-row:not(.file)")).toHaveCount(5);
  await expect(page.locator(".reviewers .avatar")).toHaveText(["RE"]);
  await expect(page.locator(".player.empty")).toBeVisible();

  // A pin on welcome.webm.
  await openVideo(page, "getting-started/welcome.webm");
  await expect(page.locator(".tree-row.selected .tree-label")).toHaveText("welcome.webm");
  await seekTo(page, 0.25);
  await expect(page.getByTestId("time")).toHaveText("0:03 / 0:12");
  await addPin(page, 40, 30, "The counter is hard to read here. Make it bigger.");
  const card1 = page.getByTestId("card-1");
  await expect(card1).toContainText("The counter is hard to read here");
  await expect(card1).toHaveAttribute("data-status", "open");
  await expect(page.getByTestId("pin-1")).toBeVisible();

  // An arrow, drawn by dragging.
  await seekTo(page, 0.6);
  const from = await stagePoint(page, 75, 25);
  const to = await stagePoint(page, 55, 55);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 });
  await page.screenshot({ path: join(shots, "1-dragging-arrow.png") });
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await page.mouse.up();
  const draft = page.getByTestId("draft");
  await expect(draft).toContainText("ARROW");
  await draft.locator("textarea").fill("This colour bar should be a lighter blue.");
  await page.screenshot({ path: join(shots, "2-arrow-draft.png") });
  await draft.getByRole("button", { name: "Comment" }).click();
  await expect(page.getByTestId("card-2")).toContainText("lighter blue");
  await expect(page.getByTestId("unresolved-count")).toHaveText("2 open");

  const saved = annotationFile("getting-started/welcome.webm").annotations;
  expect(saved.map((a) => [a.kind, a.author, a.status])).toEqual([
    ["pin", "Ruth Ellis", "open"],
    ["arrow", "Ruth Ellis", "open"],
  ]);
  expect(saved[0].t).toBeCloseTo(3, 0);
  expect(saved[1].x2).toBeCloseTo(55, 0);
  expect(existsSync(join(root, saved[0].frame!))).toBe(true);

  // A pin on a second video. The send button counts open annotations in the whole folder.
  await openVideo(page, "getting-started/first-project.webm");
  await seekTo(page, 0.5);
  await addPin(page, 50, 50, "Hold on this slide a second longer.");
  await expect(page.getByTestId("send")).toHaveText("Send 3 to Claude");
  await expect(page.locator('[data-path="getting-started/welcome.webm"] .count-badge')).toHaveText(
    "2",
  );
  await page.screenshot({ path: join(shots, "3-ready-to-send.png") });

  // Claude is listening with `howbench wait`; the reviewer clicks Send.
  const waiting = startWait();
  await expect
    .poll(() => page.evaluate(() => fetch("/api/status").then((r) => r.json())))
    .toMatchObject({ waiting: true });
  await page.getByTestId("send").click();
  const sent = await waiting;
  expect(sent.map((a) => `${a.video}#${a.id}`).sort()).toEqual([
    "getting-started/first-project.webm#1",
    "getting-started/welcome.webm#1",
    "getting-started/welcome.webm#2",
  ]);
  for (const a of sent) {
    expect(existsSync(a.videoFile)).toBe(true);
    expect(existsSync(a.frameFile!)).toBe(true);
  }
  await expect(page.getByTestId("card-1")).toHaveAttribute("data-status", "sent");
  await expect(page.getByTestId("send")).toHaveText("Send to Claude");
  await expect(page.getByTestId("send")).toBeDisabled();
  expect(await (await fetch(`http://127.0.0.1:${port}/api/status`)).json()).toMatchObject({
    undelivered: 0,
  });
  await page.screenshot({ path: join(shots, "4-sent.png") });

  // Claude replies with `howbench reply`; the open page updates without a reload.
  await howbench(
    "reply",
    "getting-started/first-project.webm",
    "1",
    "Extended the hold to 3 seconds.",
  );
  await expect(page.getByTestId("card-1")).toContainText("Extended the hold to 3 seconds.");
  await expect(page.getByTestId("card-1")).toHaveAttribute("data-status", "replied");
  await howbench("reply", "getting-started/welcome.webm", "1", "Doubled the counter's font size.");
  await howbench("reply", "getting-started/welcome.webm", "2", "Changed it to #6a9cf5.");
  await expect(page.getByTestId("send")).toBeDisabled();

  await openVideo(page, "getting-started/welcome.webm");
  await expect(page.getByTestId("card-1")).toContainText("Doubled the counter's font size.");
  await expect(page.getByTestId("card-2")).toContainText("Changed it to #6a9cf5.");

  // Claude re-renders the video in place, and the page says so.
  cpSync(
    join(root, "advanced", "editing-tips.webm"),
    join(root, "getting-started", "welcome.webm"),
  );
  await expect(page.getByTestId("fresh-render")).toBeVisible();
  await page.getByTestId("card-2").click();
  await expect(page.getByTestId("pin-2")).toBeVisible();
  await page.screenshot({ path: join(shots, "5-replied.png") });

  // The reviewer answers Claude on one annotation, which reopens it…
  await page.getByTestId("card-2").getByRole("button", { name: "Reply" }).click();
  await page.getByPlaceholder("Reply to Claude…").fill("Close, but a touch darker please.");
  await page.getByPlaceholder("Reply to Claude…").press("Enter");
  await expect(page.getByTestId("card-2")).toHaveAttribute("data-status", "open");
  await expect(page.getByTestId("card-2")).toContainText("Close, but a touch darker please.");
  await expect(page.getByTestId("send")).toHaveText("Send 1 to Claude");

  // …and resolves the other.
  await page.getByTestId("card-1").getByRole("button", { name: "Resolve" }).click();
  await expect(page.getByTestId("card-1")).toBeHidden();
  await expect(page.getByTestId("unresolved-count")).toHaveText("1 open");
  await page.getByRole("button", { name: "Show 1 resolved" }).click();
  await expect(page.getByTestId("card-1")).toContainText("Resolved");
  await page.getByTestId("card-1").getByRole("button", { name: "Reopen" }).click();
  await expect(page.getByTestId("card-1")).toHaveAttribute("data-status", "replied");
  await page.getByTestId("card-1").getByRole("button", { name: "Resolve" }).click();
  await expect(page.getByTestId("card-1")).toHaveAttribute("data-status", "resolved");
  await page.screenshot({ path: join(shots, "6-reply-and-resolve.png") });

  // Sending while nobody is waiting is kept until Claude next runs `howbench wait`.
  await page.getByTestId("send").click();
  await expect(page.getByTestId("send")).toBeDisabled();
  expect(await (await fetch(`http://127.0.0.1:${port}/api/status`)).json()).toMatchObject({
    undelivered: 1,
  });
  const later = JSON.parse(await howbench("wait")) as SentAnnotation[];
  expect(await (await fetch(`http://127.0.0.1:${port}/api/status`)).json()).toMatchObject({
    undelivered: 0,
  });
  expect(later.map((a) => `${a.video}#${a.id}`)).toEqual(["getting-started/welcome.webm#2"]);
  expect(later[0].thread.at(-1)).toMatchObject({
    who: "user",
    text: "Close, but a touch darker please.",
  });

  // A reload keeps the selected video and everything on it.
  await page.reload();
  await expect(page.locator(".tree-row.selected .tree-label")).toHaveText("welcome.webm");
  await expect(page.getByTestId("card-2")).toHaveAttribute("data-status", "sent");
});

test("switch the folder from the sidebar, and reopen it on the next run", async ({ page }) => {
  const scratch = mkdtempSync(join(tmpdir(), "howbench-folders-"));
  const lessons = join(scratch, "lessons");
  const extras = join(scratch, "extras");
  cpSync(join(repo, "samples", "getting-started"), lessons, { recursive: true });
  cpSync(join(repo, "samples", "advanced"), extras, { recursive: true });
  const configFile = join(scratch, "config", "config.json");
  const readConfig = () =>
    JSON.parse(readFileSync(configFile, "utf8")) as { root: string; recent: string[] };
  const folder = page.getByTestId("folder");
  const videoNames = page.locator(".tree-row:not(.file) .tree-label");

  // Stands in for the OS folder chooser, which Playwright cannot click.
  let nextPick: string | null = null;
  const chooser = { user: "Ruth Ellis", pickFolder: async () => nextPick };

  try {
    // First run, given a folder.
    const first = await serve({ root: lessons, port: 0, configFile, ...chooser });
    await page.goto(`http://127.0.0.1:${first.port}/`);
    await expect(folder.locator(".sidebar-root")).toHaveText("lessons");
    await expect(videoNames).toHaveText(["first-project.webm", "welcome.webm"]);
    await page.locator('[data-path="welcome.webm"]').click();
    await expect(page.locator(".tree-row.selected .tree-label")).toHaveText("welcome.webm");
    const change = folder.getByRole("button", { name: "Change…" });

    // Cancelling the chooser changes nothing.
    nextPick = null;
    await change.click();
    await expect(change).toBeEnabled();
    await expect(page.locator(".tree-row.selected .tree-label")).toHaveText("welcome.webm");

    // A path that is not a folder is refused, and nothing changes.
    nextPick = join(scratch, "nowhere");
    await change.click();
    await expect(folder.locator(".folder-error")).toContainText("Not a folder");
    await expect(videoNames).toHaveText(["first-project.webm", "welcome.webm"]);

    // Choosing another folder switches to it.
    nextPick = extras;
    await change.click();
    await expect(folder.locator(".sidebar-root")).toHaveText("extras");
    await expect(folder.locator(".folder-error")).toBeHidden();
    await expect(videoNames).toHaveText(["editing-tips.webm"]);
    await expect(page.locator(".player.empty")).toBeVisible();
    expect(readConfig()).toEqual({ root: extras, recent: [extras, lessons] });

    // Switch back from the recent list.
    await folder.getByRole("button", { name: "Recent" }).click();
    await expect(folder.locator(".recent-row")).toHaveText([lessons]);
    await page.screenshot({ path: join(shots, "7-recent-folders.png") });
    await folder.locator(".recent-row").click();
    await expect(folder.locator(".sidebar-root")).toHaveText("lessons");
    expect(readConfig().root).toBe(lessons);
    first.close();

    // Next run, with no folder given: the last folder comes back.
    const second = await serve({ port: 0, configFile, ...chooser });
    expect(second.root).toBe(lessons);
    await page.goto(`http://127.0.0.1:${second.port}/`);
    await expect(folder.locator(".sidebar-root")).toHaveText(basename(lessons));
    await expect(videoNames).toHaveText(["first-project.webm", "welcome.webm"]);
    second.close();

    // A first-ever run with no folder asks for one.
    const fresh = await serve({ port: 0, configFile: join(scratch, "none.json"), ...chooser });
    expect(fresh.root).toBeNull();
    await page.goto(`http://127.0.0.1:${fresh.port}/`);
    await expect(folder.getByRole("button", { name: "Choose a folder…" })).toBeVisible();
    await page.screenshot({ path: join(shots, "8-no-folder.png") });
    nextPick = extras;
    await folder.getByRole("button", { name: "Choose a folder…" }).click();
    await expect(videoNames).toHaveText(["editing-tips.webm"]);
    fresh.close();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
