import { execFile, spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
  root = mkdtempSync(join(tmpdir(), "coanda-e2e-"));
  cpSync(join(repo, "samples"), root, { recursive: true });
  ({ port, close } = await serve({ root, port: 0, user: "Ruth Ellis" }));
});

test.afterAll(() => {
  close?.();
  rmSync(root, { recursive: true, force: true });
});

/** Runs `coanda <args>` against the test server and returns stdout. */
async function coanda(...args: string[]) {
  const { stdout } = await run(process.execPath, [cli, ...args, "--port", String(port)]);
  return stdout;
}

/** Starts `coanda wait` and resolves with what it prints when it exits. */
function startWait(): Promise<SentAnnotation[]> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cli, "wait", "--port", String(port)]);
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    child.on("exit", (code) =>
      code === 0 ? resolvePromise(JSON.parse(out) as SentAnnotation[]) : reject(new Error(out)),
    );
  });
}

function annotationFile(video: string): AnnotationFile {
  return JSON.parse(readFileSync(join(root, video + ".coanda.json"), "utf8")) as AnnotationFile;
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
  await page.goto(`http://127.0.0.1:${port}/`);

  // Header, folder tree and reviewer.
  await expect(page.locator(".brand-name")).toHaveText("Coanda");
  await expect(page.locator(".tree-row")).toHaveCount(5);
  await expect(page.locator(".reviewers .avatar")).toHaveText(["RE"]);
  await expect(page.locator(".player.empty")).toHaveText("Choose a video on the left.");

  // A pin on welcome.webm.
  await openVideo(page, "getting-started/welcome.webm");
  await expect(page.getByTestId("video-title")).toHaveText("welcome");
  await seekTo(page, 0.25);
  await expect(page.getByTestId("time")).toHaveText("0:03 / 0:12");
  await addPin(page, 40, 30, "The counter is hard to read here. Make it bigger.");
  const card1 = page.getByTestId("card-1");
  await expect(card1).toContainText("The counter is hard to read here");
  await expect(card1).toContainText("Goes out with the next send");
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
  await expect(page.getByTestId("send")).toHaveText("Send 3 open to Claude Code");
  await expect(page.locator(".foot-note").first()).toContainText("Includes 2 on other videos");
  await expect(page.locator('[data-path="getting-started/welcome.webm"] .count-badge')).toHaveText(
    "2",
  );
  await page.screenshot({ path: join(shots, "3-ready-to-send.png") });

  // Claude is listening with `coanda wait`; the reviewer clicks Send.
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
  await expect(page.getByTestId("card-1")).toContainText("Sent · Claude Code is working on it");
  await expect(page.getByTestId("send")).toHaveText("Claude Code is working…");
  await expect(page.getByTestId("send")).toBeDisabled();
  await expect(page.locator(".foot-note.warn")).toBeHidden();
  await page.screenshot({ path: join(shots, "4-sent.png") });

  // Claude replies with `coanda reply`; the open page updates without a reload.
  await coanda(
    "reply",
    "getting-started/first-project.webm",
    "1",
    "Extended the hold to 3 seconds.",
  );
  await expect(page.getByTestId("card-1")).toContainText("Extended the hold to 3 seconds.");
  await expect(page.getByTestId("card-1")).toHaveAttribute("data-status", "replied");
  await coanda("reply", "getting-started/welcome.webm", "1", "Doubled the counter's font size.");
  await coanda("reply", "getting-started/welcome.webm", "2", "Changed it to #6a9cf5.");
  await expect(page.getByTestId("send")).toHaveText("Nothing new to send");

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
  await expect(page.getByTestId("send")).toHaveText("Send 1 open to Claude Code");

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

  // Sending while nobody is waiting is kept until Claude next runs `coanda wait`.
  await page.getByTestId("send").click();
  await expect(page.locator(".foot-note.warn")).toContainText("isn't listening");
  const later = JSON.parse(await coanda("wait")) as SentAnnotation[];
  await expect(page.locator(".foot-note.warn")).toBeHidden();
  expect(later.map((a) => `${a.video}#${a.id}`)).toEqual(["getting-started/welcome.webm#2"]);
  expect(later[0].thread.at(-1)).toMatchObject({
    who: "user",
    text: "Close, but a touch darker please.",
  });

  // A reload keeps the selected video and everything on it.
  await page.reload();
  await expect(page.getByTestId("video-title")).toHaveText("welcome");
  await expect(page.getByTestId("card-2")).toHaveAttribute("data-status", "sent");
});
