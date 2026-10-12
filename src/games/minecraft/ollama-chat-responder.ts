import type { Logger } from "pino";

export interface MinecraftChatResponder {
  /** Returns a short, non-actionable chat reply, or null when unavailable or unnecessary. */
  reply(message: string): Promise<string | null>;
  /** Why the helper cannot answer right now (missing server, missing model, refused answers), or null when healthy. */
  unavailableReason?(): string | null;
}

export interface OllamaChatResponderOptions {
  readonly baseUrl?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  /** Longer budget for the very first request, while Ollama loads the model into memory. */
  readonly coldTimeoutMs?: number;
  readonly unavailableCooldownMs?: number;
  /** After this many answers in a row that the safety filter refuses, the helper pauses for the session. */
  readonly maxConsecutiveRejections?: number;
  readonly logger?: Logger;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
}

interface OllamaChatResponse {
  readonly message?: { readonly content?: unknown };
  readonly error?: unknown;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_MODEL = "qwen3:0.6b";
const DEFAULT_TIMEOUT_MS = 1_800;
const DEFAULT_COLD_TIMEOUT_MS = 8_000;
const DEFAULT_COOLDOWN_MS = 30_000;
const DEFAULT_MAX_REJECTIONS = 5;
const MAX_REPLY_CHARS = 180;
const MAX_PROMPT_CHARS = 500;
const NON_ENGLISH_GERMAN_SCRIPT = /[\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Devanagari}\p{Script=Thai}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const ENGLISH_MARKERS = new Set("a an the and or but if then than when where what which who why how are was were be been being do does did can could should would will may might must have has had I you your we our me my please try use send ask tell explain command commands available only not cannot help for with from to this that it there here here are say send status stop hold follow come build plan house farm wheat think need sure dig excavate gather mine collect craft".toLowerCase().split(" "));
const GERMAN_MARKERS = new Set("der die das ein eine einer einem einen und oder aber wenn dann als wann wo was welche wer warum wie ist sind war waren sein gewesen wird werden kann könnte soll sollten würde darf müssen habe hast hat haben hatte ich du dein deine wir unser mich mir bitte versuche nutze sende hilfe danke frage sag erkläre befehl befehle verfügbar nur nicht nein keine kein helfen für mit von zu diese dieser dieses es hier dort status stopp bleib folge komm baue plane haus weizen graben sammeln abbauen".toLowerCase().split(" "));
const SHORT_ALLOWED_REPLIES = new Set(["ok", "okay", "yes", "no", "ja", "nein", "hi", "hello", "hallo", "thanks", "danke", "bitte", "sorry", "great", "gut", "gern", "gerne", "welcome", "willkommen", "status", "help", "hilfe", "what", "why", "how", "alles klar", "hello there", "all right"]);
const ACTION_CLAIM_PATTERNS = [
  /\b(?:i|we)(?:\s+have|'ve)?\s+(?:already\s+|just\s+)?(?:built|dug|planted|gathered|collected|crafted|placed|changed|started|completed|finished)\b/i,
  /\b(?:i(?:\s+am|['’]m)|we(?:\s+are|['’]re))\s+(?:building|digging|planting|gathering|collecting|crafting|placing|changing|starting)\b/i,
  /\b(?:i|we)\s+(?:will|'ll|am going to|are going to)\s+(?:build|dig|plant|gather|collect|craft|place|change|start|finish|complete|approve|authorize)\b/i,
  /\b(?:is|are|was|were|has been|have been|will be|will have been)\s+(?:already\s+|just\s+)?(?:built|dug|planted|gathered|collected|crafted|placed|changed|started|completed|finished|approved|authorized)\b/i,
  /\b(?:i|we)\s+(?:have|has been|is|are)\s+(?:built|dug|planted|gathered|collected|crafted|placed|changed|completed|finished)\b/i,
  /\bich\s+(?:habe\b.{0,60}\b(?:gebaut|gegraben|gepflanzt|gesammelt|hergestellt|platziert|geändert|gestartet|erledigt|abgeschlossen)|baue|grabe|pflanze|sammle|stelle her|platziere|ändere|starte)(?:\b|$)/i,
  /\b(?:wurde|wurden|ist|sind|war|waren|wird|werden)\s+(?:bereits\s+|schon\s+|jetzt\s+)?(?:gebaut|gegraben|gepflanzt|gesammelt|hergestellt|platziert|geändert|gestartet|abgeschlossen|erledigt|fertiggestellt|errichtet|genehmigt|freigegeben|erteilt|bestätigt)\b/i,
  /\b(?:ist|sind)\s+(?:bereits\s+|schon\s+)?(?:gebaut|fertig|erledigt|abgeschlossen)\b|\bich\s+bin\s+(?:fertig|erledigt|abgeschlossen)\b/i,
  /\b(?:i(?:\s+am|['’]m)|we(?:\s+are|['’]re))\s+(?:done|completed|finished)\b/i,
  /\b(?:i|we)\s+(?:approve|approved|authorize|authorized|permit|permitted|grant|granted)\b|\bich\s+(?:genehmige|genehmigt|erlaube|erlaubt|erteile|erteilt|gebe\s+frei|habe\b.{0,60}\b(?:genehmigt|freigegeben))\b/i,
  /\b(?:i|we|you)\s+(?:can|may|could|should|will|must)\s+(?:approve|authorize|permit|grant)\b|\b(?:du|ich)\s+(?:kannst|kann|darfst|darf|sollst|soll|werde|wirst)\s+(?:genehmigen|freigeben|erlauben|erteilen)\b/i,
  /\b(?:you|the operator)(?:\s+(?:are|'re))?\s+(?:allowed|permitted|authorized)\s+to\s+(?:build|dig|plant|gather|collect|craft|place|change|start)\b|\b(?:you|the operator)\s+(?:may|can)\s+(?:now\s+)?(?:build|dig|plant|gather|collect|craft|place|change|start)\b/i,
  /\bdu\s+(?:darfst|kannst|sollst)\s+(?:jetzt\s+)?(?:bauen|graben|pflanzen|sammeln|herstellen|platzieren|ändern|starten)\b/i,
  /\b(?:approved|authorized|permitted|granted|genehmigt|freigegeben|erlaubt)\b/i,
  /^(?:done|completed|finished|fertig|erledigt|abgeschlossen)\b/i,
] as const;

const NAVIGATION_PROMPT = [
  "You are GameMind's lightweight Minecraft chat helper. Reply only in English or German, matching the operator's language when clear.",
  "Du bist GameMinds leichter Minecraft-Chathelfer. Antworte ausschließlich auf Deutsch oder Englisch und verwende nach Möglichkeit die Sprache des Spielers.",
  "Be brief and friendly, with at most two short sentences. Antworte knapp und freundlich, höchstens zwei kurze Sätze.",
  "Only explain available commands. Never claim to start, perform, or complete an action; never grant safety approval or project approval.",
  "Du darfst nur erlaubte Befehle erklären. Behaupte niemals, eine Aktion gestartet, ausgeführt oder abgeschlossen zu haben, und erteile keine Sicherheits- oder Projektfreigabe.",
  "Never invent coordinates, blueprints, material availability, or world state. Du darfst keine Koordinaten, Baupläne, Materialverfügbarkeit oder Weltzustände erfinden.",
  "Commands/Befehle: status, help/hilfe, stop/stopp, hold/bleib, follow me/folge mir, come/komm; build starter house/baue Starterhaus (fixed 5x5 prototype, project approval plus separate material permission); build house/baue Haus never silently selects one. plan house/plane Haus A, B, or C creates a relative block/material/layer preview only, never a build or world inspection. House concepts: A Bavarian timber, B modern courtyard, C Alpine lodge. Dig/grabe WxHxD (max 10x10x10); plant wheat farm/pflanze Weizenfeld (max 25x50, existing hydrated soil and seeds only); gather/mine allowlisted resources.",
  "Every house, excavation, and farm project still needs a clear yes/no approval. Haus-, Grab- und Farmprojekte brauchen eine ausdrückliche Ja/Nein-Freigabe.",
  "Wenn du unsicher bist, verweise auf 'hilfe' oder bitte um eine klarere Formulierung.",
].join(" ");

function isEnglishOrGermanReply(value: string): boolean {
  const words = value.toLowerCase().match(/[a-zäöüß]+/gi) ?? [];
  if (words.length === 0) return false;
  const normalized = words.map((word) => word.toLowerCase());
  if (words.length <= 3 && SHORT_ALLOWED_REPLIES.has(normalized.join(" "))) return true;
  const englishMarkers = new Set(normalized.filter((word) => ENGLISH_MARKERS.has(word)));
  const germanMarkers = new Set(normalized.filter((word) => GERMAN_MARKERS.has(word)));
  return englishMarkers.size >= 2 || germanMarkers.size >= 2;
}

function cleanReply(value: string): string | null {
  const cleaned = value
    .replace(/<think>[\s\S]*?<\/think>/gi, " ")
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_REPLY_CHARS);
  if (!cleaned || /^(?:null|undefined)$/i.test(cleaned)) return null;
  // Mineflayer chat beginning with a slash is sent as a server command; the model may never emit one.
  if (/^[\/\uFF0F\u2215\u2044\u29F8]/u.test(cleaned)) return null;

  // Ollama is a text helper, never an execution reporter. Fail closed rather than relay an
  // apparent claim that it built/gathered/changed something or is about to do so.
  if (ACTION_CLAIM_PATTERNS.some((pattern) => pattern.test(cleaned)) || NON_ENGLISH_GERMAN_SCRIPT.test(cleaned)) return null;
  if (!isEnglishOrGermanReply(cleaned)) return null;
  return cleaned;
}

/**
 * Optional local Ollama chat helper. It is never used for recognized commands, approval decisions, movement,
 * safety, or block geometry. Requests are single-flight; the first gets a longer budget while the model loads,
 * an unavailable server is circuit-broken so it cannot stall ordinary chat, and answers the safety filter keeps
 * refusing pause the helper for the session instead of paying the timeout on every message.
 */
export class OllamaChatResponder implements MinecraftChatResponder {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly coldTimeoutMs: number;
  private readonly cooldownMs: number;
  private readonly maxRejections: number;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private unavailableUntil = 0;
  private unavailable: string | null = null;
  private inFlight = false;
  private completedRequest = false;
  private consecutiveRejections = 0;
  private paused = false;

  constructor(private readonly options: OllamaChatResponderOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.model = options.model ?? DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.coldTimeoutMs = options.coldTimeoutMs ?? DEFAULT_COLD_TIMEOUT_MS;
    this.cooldownMs = options.unavailableCooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.maxRejections = options.maxConsecutiveRejections ?? DEFAULT_MAX_REJECTIONS;
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;

    const parsedUrl = new URL(this.baseUrl);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error("Ollama URL must use HTTP or HTTPS.");
    }
    if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
      throw new Error("Ollama URL must not contain credentials, a query, or a fragment.");
    }
    if (!/^[\w./:-]{1,100}$/.test(this.model)) throw new Error("Ollama model name contains unsupported characters.");
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 10_000) {
      throw new Error("Ollama timeout must be an integer from 100 to 10000 ms.");
    }
    if (!Number.isInteger(this.coldTimeoutMs) || this.coldTimeoutMs < 100 || this.coldTimeoutMs > 60_000) {
      throw new Error("Ollama cold-start timeout must be an integer from 100 to 60000 ms.");
    }
    if (!Number.isInteger(this.cooldownMs) || this.cooldownMs < 1_000 || this.cooldownMs > 300_000) {
      throw new Error("Ollama unavailable cooldown must be an integer from 1000 to 300000 ms.");
    }
    if (!Number.isInteger(this.maxRejections) || this.maxRejections < 1 || this.maxRejections > 100) {
      throw new Error("Ollama rejection limit must be an integer from 1 to 100.");
    }
  }

  /** Why the helper cannot answer right now, or null when the last exchange was healthy. */
  unavailableReason(): string | null {
    return this.unavailable;
  }

  async reply(message: string): Promise<string | null> {
    const text = message.trim().slice(0, MAX_PROMPT_CHARS);
    if (!text || this.inFlight || this.now() < this.unavailableUntil) return null;
    if (this.paused) {
      this.options.logger?.debug({ model: this.model }, "Local Ollama chat helper stays paused after repeated refusals; deterministic chat remains active");
      return null;
    }

    this.inFlight = true;
    // Loading the model into memory is slower than one warm answer, so the first request gets the longer
    // budget; a missing model is not mistaken for an outage and answered with the deterministic fallback.
    const timeoutMs = this.completedRequest ? this.timeoutMs : Math.max(this.timeoutMs, this.coldTimeoutMs);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Ollama reply timed out.")), timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetcher(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          stream: false,
          keep_alive: "5m",
          options: { temperature: 0.1, num_predict: 80, num_ctx: 1_024 },
          messages: [
            { role: "system", content: NAVIGATION_PROMPT },
            { role: "user", content: text },
          ],
        }),
      });
      if (!response.ok) {
        this.unavailableUntil = this.now() + this.cooldownMs;
        this.unavailable = response.status === 404
          ? `the model '${this.model}' is not installed on the Ollama server (run: ollama pull ${this.model})`
          : `the Ollama server answered with HTTP ${response.status}`;
        this.options.logger?.warn({ status: response.status, model: this.model, reason: this.unavailable }, "Local Ollama chat helper is unavailable; deterministic chat remains active");
        return null;
      }
      const payload = await response.json() as OllamaChatResponse;
      this.completedRequest = true;
      const content = payload.message?.content;
      if (typeof content !== "string") {
        this.unavailable = "it answered without a message";
        return null;
      }
      const cleaned = cleanReply(content);
      if (cleaned === null) {
        this.consecutiveRejections += 1;
        this.unavailable = `its last ${this.consecutiveRejections} answer(s) were refused by the safety filter`;
        if (this.consecutiveRejections >= this.maxRejections) {
          this.paused = true;
          this.unavailable = `its answers were refused ${this.consecutiveRejections} times in a row by the safety filter, so it is paused for this session`;
          this.options.logger?.warn({ model: this.model, rejections: this.consecutiveRejections }, "Local Ollama chat helper paused after repeated refusals; deterministic chat remains active");
        }
        return null;
      }
      this.consecutiveRejections = 0;
      this.unavailable = null;
      return cleaned;
    } catch (error) {
      this.unavailableUntil = this.now() + this.cooldownMs;
      this.unavailable = controller.signal.aborted
        ? `it did not answer within ${timeoutMs} ms`
        : `the Ollama server at ${this.baseUrl} is not reachable`;
      if (!controller.signal.aborted) {
        this.options.logger?.warn({ err: error, model: this.model, reason: this.unavailable }, "Local Ollama chat helper failed; deterministic chat remains active");
      }
      return null;
    } finally {
      clearTimeout(timer);
      this.inFlight = false;
    }
  }
}

export function ollamaChatResponderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  logger?: Logger,
): OllamaChatResponder {
  const timeout = env.GAMEMIND_OLLAMA_TIMEOUT_MS === undefined ? DEFAULT_TIMEOUT_MS : Number(env.GAMEMIND_OLLAMA_TIMEOUT_MS);
  const coldTimeout = env.GAMEMIND_OLLAMA_COLD_TIMEOUT_MS === undefined ? DEFAULT_COLD_TIMEOUT_MS : Number(env.GAMEMIND_OLLAMA_COLD_TIMEOUT_MS);
  const cooldown = env.GAMEMIND_OLLAMA_COOLDOWN_MS === undefined ? DEFAULT_COOLDOWN_MS : Number(env.GAMEMIND_OLLAMA_COOLDOWN_MS);
  const maxRejections = env.GAMEMIND_OLLAMA_MAX_REJECTIONS === undefined ? DEFAULT_MAX_REJECTIONS : Number(env.GAMEMIND_OLLAMA_MAX_REJECTIONS);
  return new OllamaChatResponder({
    baseUrl: env.GAMEMIND_OLLAMA_URL ?? DEFAULT_BASE_URL,
    model: env.GAMEMIND_OLLAMA_MODEL ?? DEFAULT_MODEL,
    timeoutMs: timeout,
    coldTimeoutMs: coldTimeout,
    unavailableCooldownMs: cooldown,
    maxConsecutiveRejections: maxRejections,
    ...(logger ? { logger } : {}),
  });
}
