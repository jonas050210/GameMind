import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * What the process is running on, as far as it matters for reaching a Minecraft server and a browser.
 *
 * The target environment is a Windows machine with the Minecraft world on Windows and GameMind inside WSL, where
 * "localhost" means two different machines depending on which side asks. Nothing here guesses: detection reads
 * the same markers WSL itself sets, every function takes its inputs as parameters so it can be tested with any
 * environment, and anything that cannot be determined is reported as unknown rather than defaulted.
 */

export interface PlatformInfo {
  readonly os: NodeJS.Platform;
  readonly wsl: boolean;
  /** 1 or 2 when inside WSL and it could be told apart; null outside WSL or when unknown. */
  readonly wslVersion: 1 | 2 | null;
  readonly distro: string | null;
}

export interface PlatformInputs {
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Contents of /proc/version, or null when it cannot be read. Injectable for tests. */
  readonly procVersion?: string | null;
}

function readProcVersion(): string | null {
  try {
    return readFileSync("/proc/version", "utf8");
  } catch {
    return null;
  }
}

export function detectPlatform(inputs: PlatformInputs = {}): PlatformInfo {
  const os = inputs.platform ?? process.platform;
  const env = inputs.env ?? process.env;
  if (os !== "linux") return { os, wsl: false, wslVersion: null, distro: null };
  const procVersion = inputs.procVersion === undefined ? readProcVersion() : inputs.procVersion;
  const markers = Boolean(env.WSL_DISTRO_NAME) || Boolean(env.WSL_INTEROP) || Boolean(env.WSLENV) || /microsoft|wsl/i.test(procVersion ?? "");
  if (!markers) return { os, wsl: false, wslVersion: null, distro: null };
  const version = procVersion ?? "";
  // WSL2 kernels identify as "...-microsoft-standard-WSL2"; WSL1 reports a plain "Microsoft" build string.
  const wslVersion: 1 | 2 | null = /wsl2|microsoft-standard/i.test(version) || Boolean(env.WSL_INTEROP) ? 2 : /microsoft/i.test(version) ? 1 : null;
  return { os, wsl: true, wslVersion, distro: env.WSL_DISTRO_NAME ?? null };
}

/** The first `default via <ip>` gateway of `ip route show default` output, or null. */
export function parseDefaultGateway(routeOutput: string): string | null {
  const match = /^default\s+via\s+((?:\d{1,3}\.){3}\d{1,3})/m.exec(routeOutput);
  return match?.[1] ?? null;
}

/** The first IPv4 `nameserver` of an /etc/resolv.conf; under WSL2 NAT this is the Windows host. */
export function parseResolvNameserver(resolvConf: string): string | null {
  for (const line of resolvConf.split("\n")) {
    const match = /^\s*nameserver\s+((?:\d{1,3}\.){3}\d{1,3})\s*$/.exec(line);
    if (match?.[1] && match[1] !== "127.0.0.1" && !match[1].startsWith("127.")) return match[1];
  }
  return null;
}

export interface WindowsHostCandidates {
  /** Addresses that may reach the Windows host from this WSL2 VM, most likely first, without duplicates. */
  readonly addresses: readonly string[];
  readonly gateway: string | null;
  readonly nameserver: string | null;
}

export function windowsHostCandidates(input: { readonly routeOutput?: string | null; readonly resolvConf?: string | null }): WindowsHostCandidates {
  const gateway = input.routeOutput ? parseDefaultGateway(input.routeOutput) : null;
  const nameserver = input.resolvConf ? parseResolvNameserver(input.resolvConf) : null;
  const addresses = [gateway, nameserver].filter((value, index, all): value is string => value !== null && all.indexOf(value) === index);
  return { addresses, gateway, nameserver };
}

/** Reads the real routing table and resolver. Only meaningful under WSL2 NAT; resolves empty candidates elsewhere. */
export async function discoverWindowsHost(platform: PlatformInfo): Promise<WindowsHostCandidates> {
  if (!platform.wsl) return { addresses: [], gateway: null, nameserver: null };
  const routeOutput = await new Promise<string | null>((resolve) => {
    execFile("ip", ["route", "show", "default"], { timeout: 2_000, windowsHide: true }, (error, stdout) => resolve(error ? null : stdout));
  });
  let resolvConf: string | null = null;
  try {
    resolvConf = readFileSync("/etc/resolv.conf", "utf8");
  } catch {
    resolvConf = null;
  }
  return windowsHostCandidates({ routeOutput, resolvConf });
}

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

export function isLoopbackHost(host: string): boolean {
  const normalised = host.trim().toLowerCase();
  return LOOPBACK_NAMES.has(normalised) || /^127\.\d+\.\d+\.\d+$/.test(normalised);
}

export type ConnectionFailureCode =
  | "CONNECTION_REFUSED"
  | "HOST_NOT_FOUND"
  | "CONNECTION_TIMEOUT"
  | "CONNECTION_RESET"
  | "SPAWN_TIMEOUT"
  | "VERSION_MISMATCH"
  | "AUTH_FAILED"
  | "NOT_WHITELISTED"
  | "BANNED"
  | "DUPLICATE_LOGIN"
  | "SERVER_FULL"
  | "SERVER_KICKED"
  | "INVALID_TARGET"
  | "UNKNOWN";

export interface ConnectionDiagnosis {
  readonly code: ConnectionFailureCode;
  readonly summary: string;
  readonly hints: readonly string[];
  /** Whether trying again can help without anyone changing anything (a server restarting, a dropped link). */
  readonly retryable: boolean;
  /** The adapter's own message, verbatim apart from redaction by the caller. */
  readonly detail: string;
}

export interface DiagnosisContext {
  readonly host: string;
  readonly port: number;
  readonly version?: string | null;
  readonly username?: string | null;
  readonly auth?: "offline" | "microsoft" | null;
  readonly platform?: PlatformInfo | null;
  readonly windowsHost?: WindowsHostCandidates | null;
}

/**
 * Turns whatever the Minecraft adapter threw into a sentence and a list of things to check. The mapping is by
 * the error text the adapter and Mineflayer actually produce; an unrecognised failure is reported as UNKNOWN with
 * its own message instead of being dressed up as one of the known causes.
 */
export function diagnoseConnectionFailure(error: unknown, context: DiagnosisContext): ConnectionDiagnosis {
  const detail = error instanceof Error ? error.message : String(error);
  const code = typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string" ? String((error as { code: string }).code) : "";
  const text = `${code} ${detail}`.toLowerCase();
  const target = `${context.host}:${context.port}`;
  const wslLoopback = Boolean(context.platform?.wsl) && isLoopbackHost(context.host);
  const wslHints: string[] = wslLoopback
    ? [
        "GameMind is running inside WSL, where 'localhost' is the Linux VM and not Windows. If Minecraft runs on Windows, point GameMind at the Windows host instead.",
        context.windowsHost && context.windowsHost.addresses.length > 0
          ? `From this WSL session the Windows host looks reachable at ${context.windowsHost.addresses.join(" or ")} (try --host ${context.windowsHost.addresses[0]}). With WSL mirrored networking, 127.0.0.1 works unchanged.`
          : "Find the Windows host address (the default gateway shown by 'ip route show default'), or enable mirrored networking in .wslconfig so 127.0.0.1 reaches Windows.",
        "Allow Java (or the port) through Windows Defender Firewall for private networks.",
      ]
    : [];

  if (/enotfound|eai_again|getaddrinfo/.test(text)) {
    return {
      code: "HOST_NOT_FOUND",
      summary: `The host name '${context.host}' could not be resolved.`,
      hints: ["Check the spelling of the server address.", "Use an IP address if DNS is unavailable in this environment."],
      retryable: false,
      detail,
    };
  }
  if (/econnrefused|connection refused/.test(text)) {
    return {
      code: "CONNECTION_REFUSED",
      summary: `Nothing accepted the connection at ${target}.`,
      hints: [
        "Start the Minecraft server (or open the single-player world to LAN) before connecting.",
        "Check the port. A world opened to LAN gets a new random port every time; use the one printed in the game chat.",
        ...wslHints,
      ],
      retryable: true,
      detail,
    };
  }
  if (/spawn/.test(text) && /timed out/.test(text)) {
    return {
      code: "SPAWN_TIMEOUT",
      summary: `Connected to ${target}, but the bot never spawned into the world.`,
      hints: [
        "The server may be whitelisted, still loading the world, or waiting on a login plugin or resource pack.",
        "Check the server console for the bot's name and any login or whitelist message.",
        `The adapter uses Minecraft ${context.version ?? "1.20.4"}; a different server version can stall the login. Set --version to the server's version.`,
      ],
      retryable: true,
      detail,
    };
  }
  if (/etimedout|ehostunreach|enetunreach|timed out|timeout/.test(text)) {
    return {
      code: "CONNECTION_TIMEOUT",
      summary: `The connection to ${target} timed out.`,
      hints: ["Check that the address is reachable and not blocked by a firewall.", "Check that the server is not frozen or overloaded.", ...wslHints],
      retryable: true,
      detail,
    };
  }
  if (/kicked/.test(text)) {
    if (/whitelist|not white-?listed/.test(text)) {
      return { code: "NOT_WHITELISTED", summary: "The server's whitelist does not include this bot.", hints: [`Run /whitelist add ${context.username ?? "<bot name>"} on the server, or turn the whitelist off.`], retryable: false, detail };
    }
    if (/banned/.test(text)) {
      return { code: "BANNED", summary: "The bot is banned on this server.", hints: ["Ask a server operator to pardon the bot's name or address."], retryable: false, detail };
    }
    if (/outdated|incompatible|unsupported|version/.test(text)) {
      return { code: "VERSION_MISMATCH", summary: "The server rejected the bot's Minecraft version.", hints: [`GameMind speaks ${context.version ?? "1.20.4"}. Set --version to the server's exact version.`], retryable: false, detail };
    }
    if (/authenticat|session|online-?mode|verify username|invalid/.test(text)) {
      return {
        code: "AUTH_FAILED",
        summary: "The server could not authenticate the bot.",
        hints: [
          context.auth === "microsoft" ? "Check the Microsoft account used for sign-in." : "An online-mode server rejects offline logins. Use --auth microsoft, or run the server with online-mode=false.",
        ],
        retryable: false,
        detail,
      };
    }
    if (/already|duplicate|another location|logged in/.test(text)) {
      return { code: "DUPLICATE_LOGIN", summary: "A player with this name is already connected.", hints: ["Stop the other session or choose a different --username."], retryable: true, detail };
    }
    if (/full/.test(text)) {
      return { code: "SERVER_FULL", summary: "The server is full.", hints: ["Wait for a free slot or raise max-players."], retryable: true, detail };
    }
    return { code: "SERVER_KICKED", summary: "The server kicked the bot.", hints: ["Read the kick reason below; it comes from the server."], retryable: true, detail };
  }
  if (/unsupported|protocol|partialread|unknown (?:chunk|packet)|version/.test(text) && !/econnreset/.test(text)) {
    return {
      code: "VERSION_MISMATCH",
      summary: "The server speaks a protocol the bot could not use.",
      hints: [`GameMind targets Minecraft ${context.version ?? "1.20.4"} (Mineflayer 4.39.0). Set --version to the server's exact version, or use a server of that version.`],
      retryable: false,
      detail,
    };
  }
  if (/econnreset|socket hang up|epipe/.test(text)) {
    return {
      code: "CONNECTION_RESET",
      summary: `The connection to ${target} was reset while connecting.`,
      hints: ["A server of a different version often closes the connection during login; check --version.", "Check the server console for an error at the time of the attempt.", ...wslHints],
      retryable: true,
      detail,
    };
  }
  return { code: "UNKNOWN", summary: "The connection failed for a reason GameMind does not recognise.", hints: ["The exact error is shown below. Check the server console at the time of the attempt."], retryable: true, detail };
}
