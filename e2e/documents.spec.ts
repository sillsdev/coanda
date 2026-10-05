/// <reference lib="dom" />
// The functions passed to the page run in the browser.
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { serve } from "../server/serve.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shots = join(repo, "test-results", "screens");
const claudeCommand = [process.execPath, join(repo, "e2e", "fake-claude.mjs")];

// A 2×2 PNG, as a screenshot on the clipboard would arrive.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGNkYPj/n4GBgYGJAQoAADEDAv/ebJnPAAAAAElFTkSuQmCC";

/** Pastes an image into a text box, as Ctrl+V with a screenshot on the clipboard does. */
async function pasteImage(box: Locator) {
  await box.evaluate((el, b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], "shot.png", { type: "image/png" }));
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
  }, PNG);
}

/** Selects the first occurrence of `words` in the document page, as a drag would. */
async function selectWords(page: Page, words: string) {
  const docPage = page.getByTestId("doc-page");
  await docPage.evaluate((el, w) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.textContent!.indexOf(w);
      if (i < 0) continue;
      const range = document.createRange();
      range.setStart(n, i);
      range.setEnd(n, i + w.length);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
      return;
    }
    throw new Error(`"${w}" is not on the page`);
  }, words);
  await docPage.dispatchEvent("mouseup");
}

/** How many passages are marked as commented, and as the selected comment's. */
const highlighted = (page: Page) =>
  page.evaluate(() => ({
    other: CSS.highlights.get("howreel-comment")?.size ?? 0,
    active: CSS.highlights.get("howreel-comment-active")?.size ?? 0,
  }));

test("write a brief, paste screenshots into it, comment on it, and answer Claude", async ({
  page,
}) => {
  const scratch = mkdtempSync(join(tmpdir(), "howreel-docs-"));
  const root = join(scratch, "videos");
  cpSync(join(repo, "samples"), root, { recursive: true });
  const project = join(root, "getting-started");
  writeFileSync(join(project, "video-project.json"), "{}\n");
  const briefFile = join(project, "brief.md");
  writeFileSync(
    briefFile,
    "# Brief\n\nThe audience is new users of Bloom.\n\nThe video shows how to make a book.\n",
  );
  const fakeState = join(scratch, "fake-claude");
  mkdirSync(fakeState);
  process.env.FAKE_CLAUDE_STATE = fakeState;
  const lastMessage = () => {
    const [file] = readdirSync(fakeState);
    return JSON.parse(readFileSync(join(fakeState, file), "utf8")).lastMessage as string;
  };

  const server = await serve({
    root,
    port: 0,
    user: "Ruth Ellis",
    configFile: join(scratch, "config", "config.json"),
    sessionsFile: join(scratch, "config", "sessions.json"),
    claudeCommand,
  });
  try {
    await page.goto(`http://127.0.0.1:${server.port}/`);

    // A Markdown file opens in the middle column, as a page.
    await page.locator('[data-path="getting-started/brief.md"]').click();
    const doc = page.getByTestId("doc-page");
    await expect(doc.locator(".md-h1")).toHaveText("Brief");
    await expect(page.getByTestId("agent-panel").locator(".agent-project")).toHaveText(
      "getting-started",
    );

    // Edit it: typing is saved without a Save button, and a pasted screenshot is kept in an
    // images folder beside the brief and linked from it.
    await page.getByTestId("doc-edit").click();
    const editor = page.getByTestId("doc-editor");
    await editor.press("Control+End");
    await editor.pressSequentially("\nThe book is in Spanish.\n\n");
    await pasteImage(editor);
    await expect(editor).toHaveValue(/!\[\]\(images\/brief-[^)]+\.png\)/);
    await expect.poll(() => readFileSync(briefFile, "utf8")).toMatch(/images\/brief-.+\.png/);
    expect(readFileSync(briefFile, "utf8")).toContain("The book is in Spanish.");
    const imageLink = /images\/(brief-[^)]+\.png)/.exec(readFileSync(briefFile, "utf8"))![1];
    expect(existsSync(join(project, "images", imageLink))).toBe(true);

    // Reading it shows the screenshot.
    await page.getByRole("button", { name: "Read" }).click();
    await expect(doc.locator("img.md-image")).toHaveJSProperty("naturalWidth", 2);

    // Select a passage and comment on it, with a screenshot. Comments start addressed to Claude.
    await selectWords(page, "new users of Bloom");
    await page.getByTestId("doc-comment").click();
    const draft = page.getByTestId("draft").locator("textarea");
    await expect(draft).toHaveValue("@Claude ");
    await draft.pressSequentially("Which users, teachers or authors?");
    await pasteImage(draft);
    await expect(page.getByTestId("draft").locator(".thumb")).toHaveCount(1);
    await page.getByTestId("draft").getByRole("button", { name: "Comment" }).click();
    const card = page.getByTestId("card-1");
    await expect(card.locator(".card-quote")).toHaveText("new users of Bloom");
    await expect(card.locator(".chat-human .thumb")).toHaveCount(1);
    expect(await highlighted(page)).toEqual({ other: 0, active: 1 });

    // Send it: Claude gets the passage, the comment and the screenshot's path.
    await expect(page.getByTestId("send")).toHaveText("Send 1 to Claude");
    await page.getByTestId("send").click();
    await expect(card).toHaveAttribute("data-status", "replied");
    // The chat shows what was sent as the conversation it is, not a count.
    await expect(page.getByTestId("agent-log").locator(".agent-msg.user").first()).toHaveText(
      'brief.md, comment 1 on "new users of Bloom"\nRuth Ellis: @Claude Which users, teachers or authors?',
    );
    const sent = lastMessage();
    const send = JSON.parse(sent.slice(sent.indexOf("{"))) as {
      documents: {
        document: string;
        comments: { quote: { exact: string; prefix: string }; text: string; images: string[] }[];
      }[];
    };
    expect(send.documents[0].document).toBe("getting-started/brief.md");
    const comment = send.documents[0].comments[0];
    expect(comment.quote.exact).toBe("new users of Bloom");
    expect(comment.quote.prefix).toContain("The audience is ");
    expect(comment.text).toBe("@Claude Which users, teachers or authors?");
    expect(existsSync(comment.images[0])).toBe(true);

    // Claude asked a question back, so the reply box is already open, ready to answer.
    await expect(card.locator(".reply-status")).toHaveText("Question");
    const reply = card.getByPlaceholder("Reply to Claude…");
    await expect(reply).toBeVisible();
    await page.screenshot({ path: join(shots, "20-document-question.png") });
    await reply.fill("Teachers who are new to Bloom.");
    await reply.press("Enter");
    await expect(card).toHaveAttribute("data-status", "open");
    await expect(reply).toHaveCount(0);

    // When the brief changes on disk (Claude edits it), the page follows, and the comment stays
    // on its passage.
    writeFileSync(
      briefFile,
      "# Brief\n\nFor training workshops.\n\nThe audience is new users of Bloom, mostly teachers.\n",
    );
    await expect(doc).toContainText("For training workshops.");
    await expect.poll(() => highlighted(page)).toEqual({ other: 0, active: 1 });

    // Screenshots go into the Claude chat too.
    const chat = page.getByPlaceholder("Message Claude");
    await chat.fill("This is the dialog I mean");
    await pasteImage(chat);
    await expect(
      page.getByTestId("agent-panel").locator(".agent-input + .thumbs .thumb"),
    ).toHaveCount(1);
    await chat.press("Enter");
    const log = page.getByTestId("agent-log");
    await expect(log.locator(".agent-msg.user").last()).toContainText("This is the dialog I mean");
    await expect(log.locator(".agent-msg.user").last().locator(".thumb img")).toHaveJSProperty(
      "naturalWidth",
      2,
    );
    await expect.poll(lastMessage).toContain("This is the dialog I mean");
    const listed = /\[Images the reviewer pasted in: (.+)\]/.exec(lastMessage())![1];
    expect(existsSync(listed)).toBe(true);
    await page.screenshot({ path: join(shots, "21-chat-screenshot.png") });
  } finally {
    server.close();
    delete process.env.FAKE_CLAUDE_STATE;
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("plan a video: start the brief from the project page, approve it, and go on", async ({
  page,
}) => {
  const scratch = mkdtempSync(join(tmpdir(), "howreel-plan-"));
  const root = join(scratch, "videos");
  cpSync(join(repo, "samples"), root, { recursive: true });
  const project = join(root, "getting-started");
  const fakeState = join(scratch, "fake-claude");
  mkdirSync(fakeState);
  process.env.FAKE_CLAUDE_STATE = fakeState;

  const server = await serve({
    root,
    port: 0,
    user: "Ruth Ellis",
    configFile: join(scratch, "config", "config.json"),
    sessionsFile: join(scratch, "config", "sessions.json"),
    claudeCommand,
  });
  try {
    await page.goto(`http://127.0.0.1:${server.port}/`);

    // Making a project puts its planning documents in it at once, numbered, ahead of its files.
    await page.locator('[data-path="getting-started"]').click({ button: "right" });
    await page.getByRole("menuitem", { name: "Make project here" }).click();
    await expect(page.locator(".tree-row.planning .tree-label")).toHaveText([
      "brief.md",
      "outline.md",
      "script.md",
    ]);
    await expect(page.locator(".tree-row.planning .tree-step")).toHaveText(["1", "2", "3"]);
    for (const name of ["brief", "outline", "script"]) {
      expect(readFileSync(join(project, `${name}.md`), "utf8")).toBe(
        readFileSync(join(repo, "agent", "templates", `${name}.md`), "utf8"),
      );
    }

    // Clicking the project's folder shows its page: the planning documents, in order.
    await page.locator('[data-path="getting-started"]').click();
    const home = page.getByTestId("project-home");
    await expect(home.locator(".step-title")).toHaveText([
      "Brief",
      "Outline",
      "Script",
      "Draft video",
    ]);
    await expect(home.locator(".step-state")).toHaveText([
      "Not started",
      "Not started",
      "Not started",
      "Not started",
    ]);
    // Each step waits for the one before to be approved.
    await expect(
      page.getByTestId("step-outline").getByRole("button", { name: "Start" }),
    ).toBeDisabled();

    // Starting the brief makes it from HowReel's template, opens it, and has Claude begin.
    await page.getByTestId("step-brief").getByRole("button", { name: "Start" }).click();
    await expect(page.getByTestId("doc-page").locator(".md-h2").first()).toHaveText("Audience");
    expect(readFileSync(join(project, "brief.md"), "utf8")).toContain("## Learning objectives");
    const log = page.getByTestId("agent-log");
    await expect(log.locator(".agent-msg.user").first()).toHaveText("Started the brief");
    await expect(log).toContainText("Turn 1 in session");

    // Approving it tells Claude, and offers the next step right there.
    await page.getByTestId("approve").click();
    await expect(page.getByTestId("approve")).toHaveText("Approved");
    await expect(log.locator(".agent-msg.user").last()).toHaveText("Approved the brief");
    await expect(page.getByTestId("next-step")).toHaveText("Start outline");
    await page.locator('[data-path="getting-started"]').click();
    await expect(home.locator(".step-state").first()).toHaveText("Approved");
    await expect(
      page.getByTestId("step-outline").getByRole("button", { name: "Start" }),
    ).toBeEnabled();
    await page.screenshot({ path: join(shots, "22-project-home.png") });

    // The approved brief's button starts the outline.
    await page.locator('[data-path="getting-started/brief.md"]').click();
    await page.getByTestId("next-step").click();
    await expect(page.getByTestId("doc-page").locator(".md-h1")).toHaveText("Outline");
    await expect(log.locator(".agent-msg.user").last()).toHaveText("Started the outline");
    await page.locator('[data-path="getting-started"]').click();
    await expect(home.locator(".step-state")).toHaveText([
      "Approved",
      "Draft",
      "Not started",
      "Not started",
    ]);
    await expect(
      page.getByTestId("step-draft").getByRole("button", { name: "Make" }),
    ).toBeDisabled();

    // The outline leads to the script, and the approved script to the draft video.
    await page.locator('[data-path="getting-started/outline.md"]').click();
    await page.getByTestId("approve").click();
    await page.getByTestId("next-step").click();
    await expect(page.getByTestId("doc-page").locator(".md-h1")).toHaveText("Script");
    await page.getByTestId("approve").click();
    await expect(page.getByTestId("next-step")).toHaveText("Make draft video");
    await page.getByTestId("next-step").click();
    await expect(log.locator(".agent-msg.user").last()).toHaveText("Make the draft video");
    await expect(page.getByTestId("next-step")).toHaveCount(0);
    await page.locator('[data-path="getting-started"]').click();
    await expect(page.getByTestId("step-draft").locator(".step-state")).toHaveText("Asked for");

    // A change to an approved brief shows, and it needs approving again before going on.
    writeFileSync(join(project, "brief.md"), "# Brief\n\nChanged.\n");
    await expect(home.locator(".step-state").first()).toHaveText("Changed since approved");
    await page.locator('[data-path="getting-started/brief.md"]').click();
    await expect(page.getByTestId("approve")).toHaveText("Approve");
    await expect(page.getByTestId("next-step")).toHaveCount(0);
  } finally {
    server.close();
    delete process.env.FAKE_CLAUDE_STATE;
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("Claude's questions show in the chat, and each answer goes to Claude at once", async ({
  page,
}) => {
  const scratch = mkdtempSync(join(tmpdir(), "howreel-ask-"));
  const root = join(scratch, "videos");
  cpSync(join(repo, "samples"), root, { recursive: true });
  writeFileSync(join(root, "getting-started", "video-project.json"), "{}\n");
  const fakeState = join(scratch, "fake-claude");
  mkdirSync(fakeState);
  process.env.FAKE_CLAUDE_STATE = fakeState;
  const lastMessage = () => {
    const [file] = readdirSync(fakeState);
    return JSON.parse(readFileSync(join(fakeState, file), "utf8")).lastMessage as string;
  };

  const server = await serve({
    root,
    port: 0,
    user: "Ruth Ellis",
    configFile: join(scratch, "config", "config.json"),
    sessionsFile: join(scratch, "config", "sessions.json"),
    claudeCommand,
  });
  try {
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.locator('[data-path="getting-started/welcome.webm"]').click();
    await page.getByPlaceholder("Message Claude").fill("Plan the book, and ask me what you need");
    await page.getByPlaceholder("Message Claude").press("Enter");

    // Each question is its own card in the chat, with its suggested answers as buttons.
    const log = page.getByTestId("agent-log");
    const first = log.getByTestId("question-1");
    const second = log.getByTestId("question-2");
    await expect(first).toContainText("Should every page get a picture?");
    await expect(first.locator(".question-option")).toHaveText(["Yes", "No"]);
    await expect(second).toContainText("Which language should the book be in?");
    await expect(second.locator(".question-option")).toHaveCount(0);
    await page.screenshot({ path: join(shots, "23-questions.png") });

    // An answer goes to Claude straight away. The card then shows the question and the answer,
    // with nothing left to click or type.
    await first.getByRole("button", { name: "Yes" }).click();
    await expect(first.locator(".question-answer-text")).toHaveText("Yes");
    await expect(first.getByRole("button")).toHaveCount(0);
    await expect(first.getByRole("textbox")).toHaveCount(0);
    await expect
      .poll(lastMessage)
      .toContain('answered your question "Should every page get a picture?": Yes');
    // The answer shows only in its card, not again as a message below.
    await expect(log.locator(".agent-msg.user", { hasText: /^Yes$/ })).toHaveCount(0);

    // The other is still waiting, and can be answered by typing.
    await expect(second.getByPlaceholder("Answer…")).toBeVisible();
    await page.screenshot({ path: join(shots, "24-question-answered.png") });
    await second.getByPlaceholder("Answer…").fill("Spanish");
    await second.getByPlaceholder("Answer…").press("Enter");
    await expect(second.locator(".question-answer-text")).toHaveText("Spanish");
    await expect(second.getByRole("button")).toHaveCount(0);
    await expect(second.getByRole("textbox")).toHaveCount(0);
    await expect.poll(lastMessage).toContain(": Spanish");
    await page.screenshot({ path: join(shots, "25-questions-both-answered.png") });

    // Answers don't wait for Send.
    await expect(page.getByTestId("send")).toHaveText("Send to Claude");
  } finally {
    server.close();
    delete process.env.FAKE_CLAUDE_STATE;
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
