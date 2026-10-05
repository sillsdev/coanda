import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { serve } from "../server/serve.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shots = join(repo, "test-results", "screens");
// Stands in for `claude`: same stream-json protocol, no model, no cost.
const claudeCommand = [process.execPath, join(repo, "e2e", "fake-claude.mjs")];

interface FakeState {
  turns: number;
  lastMessage?: string;
  starts: { args: string[]; cwd: string }[];
}

test("each video project gets its own Claude session, which survives a restart", async ({
  page,
}) => {
  const scratch = mkdtempSync(join(tmpdir(), "coanda-agents-"));
  const root = join(scratch, "videos");
  cpSync(join(repo, "samples"), root, { recursive: true });
  // Two video projects.
  writeFileSync(join(root, "getting-started", "video-project.json"), "{}\n");
  writeFileSync(join(root, "advanced", "video-project.json"), "{}\n");
  const fakeState = join(scratch, "fake-claude");
  mkdirSync(fakeState);
  process.env.FAKE_CLAUDE_STATE = fakeState;
  const readFake = (id: string) =>
    JSON.parse(readFileSync(join(fakeState, `${id}.json`), "utf8")) as FakeState;

  const options = {
    root,
    port: 0,
    user: "Ruth Ellis",
    configFile: join(scratch, "config", "config.json"),
    sessionsFile: join(scratch, "config", "sessions.json"),
    claudeCommand,
  };
  const panel = page.getByTestId("agent-panel");
  const log = page.getByTestId("agent-log");
  const projectBadge = (path: string) => page.locator(`[data-path="${path}"] .agent-badge`);
  const sessionIn = async () => {
    const text = (await log.locator(".agent-msg.assistant").first().textContent()) ?? "";
    return /in session (\S+)/.exec(text)![1];
  };
  const message = async (p: Page, text: string) => {
    await p.getByPlaceholder("Message Claude").fill(text);
    await p.getByPlaceholder("Message Claude").press("Enter");
  };

  let server: Awaited<ReturnType<typeof serve>> | undefined;
  try {
    server = await serve(options);
    await page.goto(`http://127.0.0.1:${server.port}/`);

    // Folders holding video-project.json are projects, each with a status dot.
    await expect(projectBadge("getting-started")).toHaveAttribute("data-status", "idle");
    await expect(projectBadge("advanced")).toHaveAttribute("data-status", "idle");

    // A video in a project shows that project's Claude panel.
    await page.locator('[data-path="getting-started/welcome.webm"]').click();
    await expect(panel).toBeVisible();
    await expect(panel.locator(".agent-project")).toHaveText("getting-started");

    // Annotate and send: the annotation goes to the project's session, which works…
    const box = (await page.getByTestId("stage").boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.4);
    await page.getByTestId("draft").locator("textarea").fill("Make the counter bigger");
    await page.getByTestId("draft").locator("textarea").press("Control+Enter");
    await page.getByTestId("send").click();
    await expect(projectBadge("getting-started")).toHaveAttribute("data-status", "working");
    await expect(panel.locator(".agent-badge")).toHaveText("Working");
    await expect(log.locator(".agent-msg.tool")).toHaveText(["Bash: node render.mjs"]);

    // …then replies on the annotation itself, and is done.
    await expect(page.getByTestId("card-1")).toContainText("Fixed: Make the counter bigger");
    await expect(page.getByTestId("card-1")).toHaveAttribute("data-status", "replied");
    await expect(projectBadge("getting-started")).toHaveAttribute("data-status", "done");
    const first = await sessionIn();
    await expect(log.locator(".agent-msg.assistant").first()).toHaveText(
      `Turn 1 in session ${first}`,
    );
    // The block of replies is for Coanda, not for the reviewer to read.
    await expect(log).not.toContainText("```coanda");

    // It was started in auto mode, in the reviewed folder, with Coanda's instructions.
    const started = readFake(first).starts[0];
    expect(started.args).toEqual(expect.arrayContaining(["--permission-mode", "auto"]));
    expect(started.args).toContain("--append-system-prompt-file");
    expect(started.args).not.toContain("--resume");
    expect(resolve(started.cwd)).toBe(resolve(root));

    // Talking to it directly; a question puts the project in the "question" state.
    await message(page, "Should the intro be shorter?");
    await expect(log.locator(".agent-msg.user").last()).toHaveText("Should the intro be shorter?");
    await expect(projectBadge("getting-started")).toHaveAttribute("data-status", "question");
    await expect(log).toContainText(`Turn 2 in session ${first}`);
    await page.screenshot({ path: join(shots, "10-claude-panel.png") });

    // Another project has its own session, separate from the first.
    await page.locator('[data-path="advanced/editing-tips.webm"]').click();
    await expect(panel.locator(".agent-project")).toHaveText("advanced");
    await expect(log.locator(".agent-msg")).toHaveCount(0);
    await message(page, "Start on this one");
    await expect(projectBadge("advanced")).toHaveAttribute("data-status", "done");
    const second = await sessionIn();
    expect(second).not.toBe(first);
    await expect(log).toContainText(`Turn 1 in session ${second}`);
    await expect(projectBadge("getting-started")).toHaveAttribute("data-status", "question");

    // Restart Coanda. Each project's transcript is still shown, and its next message resumes
    // the same conversation: turn 3 of the first session, not turn 1 of a new one.
    server.close();
    server = await serve(options);
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.locator('[data-path="getting-started/welcome.webm"]').click();
    await expect(log).toContainText(`Turn 2 in session ${first}`);
    await message(page, "Carry on");
    // The resumed process first ends the old conversation's last turn; that isn't this
    // message's turn, so the session stays working until its own turn ends.
    await expect(log).toContainText("No response requested.");
    await expect(projectBadge("getting-started")).toHaveAttribute("data-status", "working");
    await expect(log).toContainText(`Turn 3 in session ${first}`);
    await expect(projectBadge("getting-started")).toHaveAttribute("data-status", "done");
    expect(readFake(first).starts.at(-1)!.args).toEqual(
      expect.arrayContaining(["--resume", first]),
    );

    // Coanda stopping in the middle of a turn: when it starts again, the session carries on
    // with that turn by itself, told what the reviewer last said.
    await message(page, "Make it shorter");
    await expect(projectBadge("getting-started")).toHaveAttribute("data-status", "working");
    server.close();
    server = await serve(options);
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.locator('[data-path="getting-started/welcome.webm"]').click();
    await expect(log).toContainText("Coanda restarted during this turn. Carrying on.");
    await expect(projectBadge("getting-started")).toHaveAttribute("data-status", "done");
    expect(readFake(first).lastMessage).toContain(
      "the reviewer's last message was:\n\nMake it shorter",
    );

    // A video outside every project offers to make one; Send there goes to `coanda wait`.
    rmSync(join(root, "advanced", "video-project.json"));
    await page.reload();
    await page.locator('[data-path="advanced/editing-tips.webm"]').click();
    await expect(page.getByTestId("time")).toContainText("0:12");
    await expect(panel.getByRole("button", { name: "Make project here" })).toBeVisible();
  } finally {
    server?.close();
    delete process.env.FAKE_CLAUDE_STATE;
    // Asynchronously: the closed folder watcher lets go of the folder only once the event loop
    // turns, which a synchronous delete never lets it do.
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
