// Shows the operating system's folder chooser and returns the chosen path.
import { spawn } from "node:child_process";

/** Resolves to the chosen absolute path, or null if the user cancelled. */
export function pickFolder(initial?: string): Promise<string | null> {
  let cmd: string;
  let args: string[];
  if (process.platform === "win32") {
    // FolderBrowserDialog needs -STA. The server runs in the background, and Windows will not
    // let a background process bring a window to the front, so a bare dialog opens behind
    // the browser. A visible, on-screen, TopMost owner window fixes that: a process may make
    // its own window topmost, and a dialog owned by it renders above it. An off-screen owner
    // does not work, so the owner is centred and the dialog covers it.
    const start = initial ? `$d.SelectedPath = '${initial.replace(/'/g, "")}';` : "";
    const ps = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$owner = New-Object System.Windows.Forms.Form
$owner.StartPosition = 'CenterScreen'
$owner.Size = New-Object System.Drawing.Size(120, 40)
$owner.FormBorderStyle = 'FixedToolWindow'
$owner.ShowInTaskbar = $false
$owner.TopMost = $true
$owner.Show(); $owner.Activate(); $owner.BringToFront()
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = 'Choose a folder of videos to review'
$d.ShowNewFolderButton = $false
${start}
$r = $d.ShowDialog($owner)
$owner.Close()
if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }
`;
    cmd = "powershell";
    args = ["-NoProfile", "-STA", "-Command", ps];
  } else if (process.platform === "darwin") {
    const loc = initial ? ` default location (POSIX file "${initial.replace(/"/g, "")}")` : "";
    cmd = "osascript";
    args = ["-e", `POSIX path of (choose folder with prompt "Choose a folder of videos"${loc})`];
  } else {
    cmd = "zenity";
    args = ["--file-selection", "--directory", "--title=Choose a folder of videos"];
    if (initial) args.push(`--filename=${initial.replace(/\/?$/, "/")}`);
  }
  return new Promise((resolve) => {
    let out = "";
    try {
      const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
      child.stdout.on("data", (b: Buffer) => (out += b.toString()));
      child.on("error", () => resolve(null));
      child.on("close", () => resolve(out.trim() || null));
    } catch {
      resolve(null);
    }
  });
}
