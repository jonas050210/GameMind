import { spawn, type ChildProcess } from "node:child_process";
import type { PlatformInfo } from "./platform.js";

/**
 * Opens the Control Center in the operator's default browser, once.
 *
 * Three properties matter more than the platform tricks:
 *  - it is only ever called from the explicit startup path, never from a state update, and a second request for
 *    the same address is answered from memory without spawning anything, so a refresh, a reconnect or a restart of
 *    the session cannot produce a second tab;
 *  - only plain local http addresses are accepted, and the address reaches the opener as an argv element (never a
 *    shell string), so a hostile value cannot become a command;
 *  - a failure is a result, not an exception: the caller prints the address and the reason and the app keeps running.
 */

export interface BrowserCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly label: string;
}

export interface BrowserOpenResult {
  readonly url: string;
  readonly opened: boolean;
  /** The opener that worked, e.g. "wslview" or "xdg-open"; null when nothing did. */
  readonly method: string | null;
  /** True when this exact address had already been opened by this process and nothing was spawned. */
  readonly alreadyOpened: boolean;
  readonly reason: string | null;
  /** Every opener that was tried and why it was skipped, in order. */
  readonly attempts: readonly { readonly label: string; readonly outcome: string }[];
}

/** Only local http(s) addresses made of URL-safe characters; nothing a shell or `cmd /c start` could misread. */
const SAFE_URL = /^https?:\/\/(?:127(?:\.\d{1,3}){3}|localhost|\[::1\]|(?:\d{1,3}\.){3}\d{1,3}|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*):\d{1,5}(?:\/[A-Za-z0-9._~\-/?=#%]*)?$/;

export function isSafeBrowserUrl(url: string): boolean {
  return url.length <= 300 && SAFE_URL.test(url);
}

/** Candidate openers in the order they should be tried on this platform. */
export function browserCommands(platform: PlatformInfo, url: string): readonly BrowserCommand[] {
  if (platform.os === "win32") {
    return [
      { command: "cmd.exe", args: ["/c", "start", "", url], label: "cmd start" },
      { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", "Start-Process", url], label: "powershell Start-Process" },
    ];
  }
  if (platform.os === "darwin") return [{ command: "open", args: [url], label: "open" }];
  const linux: BrowserCommand[] = [
    { command: "xdg-open", args: [url], label: "xdg-open" },
    { command: "gio", args: ["open", url], label: "gio open" },
    { command: "sensible-browser", args: [url], label: "sensible-browser" },
    { command: "x-www-browser", args: [url], label: "x-www-browser" },
  ];
  if (!platform.wsl) return linux;
  // Inside WSL the browser lives on Windows. wslview (wslu) is the purpose-built bridge; explorer.exe and
  // cmd.exe work wherever Windows interop is enabled. Linux openers are the last resort for a WSLg desktop.
  return [
    { command: "wslview", args: [url], label: "wslview" },
    { command: "explorer.exe", args: [url], label: "explorer.exe" },
    { command: "cmd.exe", args: ["/c", "start", "", url], label: "cmd.exe start" },
    { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", "Start-Process", url], label: "powershell.exe Start-Process" },
    ...linux,
  ];
}

/** What spawning an opener can look like; injectable so tests never start a real browser. */
export type SpawnOpener = (command: string, args: readonly string[]) => {
  /** Resolves "spawned" once the process started and is still running, or the exit code if it ended quickly. */
  readonly settled: Promise<{ readonly kind: "error"; readonly message: string; readonly code?: string } | { readonly kind: "running" } | { readonly kind: "exited"; readonly code: number | null }>;
};

const DEFAULT_SETTLE_MS = 1_500;

export function realSpawnOpener(settleMs: number = DEFAULT_SETTLE_MS): SpawnOpener {
  return (command, args) => ({
    settled: new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(command, [...args], { stdio: "ignore", detached: true, windowsHide: true, shell: false });
      } catch (error) {
        resolve({ kind: "error", message: error instanceof Error ? error.message : String(error) });
        return;
      }
      const timer = setTimeout(() => {
        child.unref();
        resolve({ kind: "running" });
      }, settleMs);
      child.once("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        resolve({ kind: "error", message: error.message, ...(error.code ? { code: error.code } : {}) });
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve({ kind: "exited", code });
      });
    }),
  });
}

export interface BrowserOpenerOptions {
  readonly platform: PlatformInfo;
  readonly spawnOpener?: SpawnOpener;
  readonly onAttempt?: (attempt: { readonly label: string; readonly outcome: string }) => void;
}

export class BrowserOpener {
  private readonly opened = new Set<string>();
  private inFlight = new Map<string, Promise<BrowserOpenResult>>();
  private readonly spawnOpener: SpawnOpener;

  constructor(private readonly options: BrowserOpenerOptions) {
    this.spawnOpener = options.spawnOpener ?? realSpawnOpener();
  }

  /** Addresses opened so far; the UI and tests read it to prove a state update did not open another tab. */
  get openedUrls(): readonly string[] {
    return [...this.opened];
  }

  open(url: string): Promise<BrowserOpenResult> {
    if (!isSafeBrowserUrl(url)) {
      return Promise.resolve({ url, opened: false, method: null, alreadyOpened: false, reason: "The address is not a plain local http URL, so it was not passed to a browser.", attempts: [] });
    }
    if (this.opened.has(url)) {
      return Promise.resolve({ url, opened: true, method: null, alreadyOpened: true, reason: null, attempts: [] });
    }
    const pending = this.inFlight.get(url);
    if (pending) return pending;
    const run = this.attempt(url).finally(() => this.inFlight.delete(url));
    this.inFlight.set(url, run);
    return run;
  }

  private async attempt(url: string): Promise<BrowserOpenResult> {
    const attempts: { label: string; outcome: string }[] = [];
    for (const candidate of browserCommands(this.options.platform, url)) {
      const { settled } = this.spawnOpener(candidate.command, candidate.args);
      const outcome = await settled;
      let text: string;
      let success = false;
      if (outcome.kind === "running") {
        success = true;
        text = "started";
      } else if (outcome.kind === "exited") {
        // explorer.exe reports exit code 1 even when it opened the page, so its code carries no information.
        success = outcome.code === 0 || candidate.command.toLowerCase() === "explorer.exe";
        text = success ? "started" : `exited with code ${outcome.code ?? "unknown"}`;
      } else {
        text = outcome.code === "ENOENT" ? "not installed" : outcome.message;
      }
      attempts.push({ label: candidate.label, outcome: text });
      this.options.onAttempt?.({ label: candidate.label, outcome: text });
      if (success) {
        this.opened.add(url);
        return { url, opened: true, method: candidate.label, alreadyOpened: false, reason: null, attempts };
      }
    }
    return {
      url,
      opened: false,
      method: null,
      alreadyOpened: false,
      reason: `No browser opener worked on this system (${attempts.map((entry) => `${entry.label}: ${entry.outcome}`).join("; ") || "none available"}). Open the address manually.`,
      attempts,
    };
  }
}
