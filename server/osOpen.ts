// Opens a file or folder the way double-clicking it would.
import { spawn, spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, extname } from "node:path";

/** Files that would run as programs rather than open in an app. These are shown in their
 * folder instead. */
const RUNNABLE = new Set([
  ".exe",
  ".com",
  ".bat",
  ".cmd",
  ".ps1",
  ".psm1",
  ".msi",
  ".msp",
  ".scr",
  ".pif",
  ".lnk",
  ".vbs",
  ".vbe",
  ".js",
  ".jse",
  ".wsf",
  ".wsh",
  ".hta",
  ".cpl",
  ".reg",
  ".jar",
  ".sh",
]);

export function osOpen(full: string): "opened" | "revealed" {
  const isDir = statSync(full).isDirectory();
  const reveal = !isDir && RUNNABLE.has(extname(full).toLowerCase());
  if (process.platform === "win32") {
    // Explorer opens a file with its default app, or a folder, and needs no shell, so nothing
    // in the path is interpreted. "/select," must be joined to the path in one argument.
    if (reveal) explorerSelect(full);
    else spawn("explorer.exe", [full], { detached: true, stdio: "ignore" }).unref();
  } else {
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    const args = reveal ? (process.platform === "darwin" ? ["-R", full] : [dirname(full)]) : [full];
    spawn(opener, args, { detached: true, stdio: "ignore" }).unref();
  }
  return reveal ? "revealed" : "opened";
}

/** Shows a file or folder selected in its parent folder, in File Explorer (or Finder). */
export function osReveal(full: string): void {
  if (process.platform === "win32") {
    explorerSelect(full);
  } else if (process.platform === "darwin") {
    spawn("open", ["-R", full], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("xdg-open", [dirname(full)], { detached: true, stdio: "ignore" }).unref();
  }
}

/** Explorer wants `/select,"C:\path with spaces\file"`, quoted after the comma, which Node's own
 * argument quoting would not produce. Windows paths cannot contain a quote. */
function explorerSelect(full: string): void {
  spawn("explorer.exe", [`/select,"${full}"`], {
    detached: true,
    stdio: "ignore",
    windowsVerbatimArguments: true,
  }).unref();
}

/** Moves a file or folder to the Recycle Bin (or the Trash), so a delete can be undone there. */
export function osTrash(full: string): void {
  const isDir = statSync(full).isDirectory();
  let result;
  if (process.platform === "win32") {
    // The path goes in through the environment, so nothing in it is read as PowerShell.
    const method = isDir ? "DeleteDirectory" : "DeleteFile";
    result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Add-Type -AssemblyName Microsoft.VisualBasic; " +
          `[Microsoft.VisualBasic.FileIO.FileSystem]::${method}($env:HOWBENCH_TRASH, 'OnlyErrorDialogs', 'SendToRecycleBin')`,
      ],
      { env: { ...process.env, HOWBENCH_TRASH: full }, encoding: "utf8" },
    );
  } else if (process.platform === "darwin") {
    result = spawnSync(
      "osascript",
      [
        "-e",
        "on run argv",
        "-e",
        'tell application "Finder" to delete POSIX file (item 1 of argv)',
        "-e",
        "end run",
        full,
      ],
      { encoding: "utf8" },
    );
  } else {
    result = spawnSync("gio", ["trash", full], { encoding: "utf8" });
  }
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `Could not delete ${full}`);
}
