import type { Logger } from "pino";
import { countItemAndEquipment } from "./recipes.js";
import {
  mineResourceTaskSchema,
  gatherResourceTaskSchema,
  craftItemTaskSchema,
  buildShelterTaskSchema,
  buildHouseTaskSchema,
  farmWheatTaskSchema,
  secureFoodTaskSchema,
  excavateVolumeTaskSchema,
  type MinecraftTask,
  type ExcavateVolumeTask,
  type BuildHouseTask,
  type FarmWheatTask,
} from "./task.js";
import type { MinecraftObservation } from "./observation.js";
import type { MinecraftTaskResult } from "./task-runner.js";
import type { CompanionController } from "./companion-controller.js";
import type { GameMindRuntime } from "../../core/game-mind-runtime.js";
import type { SkillRuntime } from "../../core/skill-runtime.js";
import { verifySkillPostcondition } from "./skill-contracts.js";
import { parseMinecraftChatCommand, describeMinecraftChatHelp, describeUnknownChatFallback, describeChatHelperUnavailable, detectChatLanguage, suggestMinecraftChatCommand, type MinecraftChatCommand } from "./chat-commands.js";
import { minecraftCraftTaskItemNames, minecraftFoodNames, minecraftPickupNames, minecraftLogNames } from "./capabilities.js";
import { generateLargeHouseBlueprint } from "./house-blueprint.js";
import { bestPickaxeTier, minecraftMiningRequirements } from "./mining.js";
import type { MinecraftChatResponder } from "./ollama-chat-responder.js";
import { ChatLatencyMetrics, chatLatencyBreaches, type ChatLatency, type ChatLatencySample, type ChatMessageTiming } from "./chat-latency.js";

export interface MinecraftChatMessage {
  readonly username: string;
  readonly message: string;
}

export interface MinecraftChatTransport {
  onChatMessage(listener: (message: MinecraftChatMessage) => void): () => void;
  sendChat(message: string): void;
  onDeath?(listener: () => void): () => void;
  onRespawn?(listener: () => void): () => void;
}

interface ResourceOrder {
  readonly resourceName: string;
  readonly itemName: string;
  readonly label: string;
  readonly requestedCount: number;
  readonly countMode: "additional" | "total";
  readonly initialCount: number;
}

interface PendingDelivery {
  readonly itemName: string;
  readonly count: number;
  readonly label: string;
  readonly expiresAt: number;
}

interface PendingResume {
  readonly task: MinecraftTask;
  readonly order: ResourceOrder | null;
  readonly expiresAt: number;
}

interface PendingProjectApproval {
  readonly task: ExcavateVolumeTask | BuildHouseTask | FarmWheatTask;
  readonly expiresAt: number;
}

interface PendingMaterialApproval {
  readonly task: BuildHouseTask;
  readonly expiresAt: number;
}

export interface MinecraftChatControllerOptions {
  readonly operatorUsername: string;
  readonly transport: MinecraftChatTransport;
  readonly runtime: GameMindRuntime<MinecraftObservation>;
  readonly skills: SkillRuntime<MinecraftObservation>;
  readonly companion: CompanionController;
  readonly logger: Logger;
  runTask(task: MinecraftTask): Promise<MinecraftTaskResult>;
  currentTask(): MinecraftTask | null;
  taskRunning(): boolean;
  requestTaskStop(reason: string): void;
  /** How long a yes/no reply remains valid. Expired delivery/resume prompts fail closed. */
  readonly confirmationTimeoutMs?: number;
  readonly deliveryTimeoutMs?: number;
  /**
   * How long one queued chat step may take before the queue abandons it and moves on. Defaults to
   * {@link CHAT_HANDLE_TIMEOUT_MS}; injectable so tests can exercise the recovery path in milliseconds
   * instead of waiting out the production value.
   */
  readonly chatTimeoutMs?: number;
  /** Optional local model for brief conversational guidance only; recognized commands never use it. */
  readonly chatResponder?: MinecraftChatResponder;
}

const HANDOFF_DISTANCE = 2.5;
const HANDOFF_TIMEOUT_MS = 120_000;
const RESPAWN_OBSERVE_TIMEOUT_MS = 10_000;

function itemCount(state: MinecraftObservation, itemName: string): number {
  return countItemAndEquipment(state.inventory, state.equipment, itemName);
}

function distance(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function taskName(task: MinecraftTask): string {
  switch (task.kind) {
    case "mine_resource": return `mine ${task.resourceName}`;
    case "gather_resource": return `gather ${task.resourceName}`;
    case "craft_item": return `craft ${task.targetItem}`;
    case "secure_food": return "secure food";
    case "build_shelter": return "build a shelter";
    case "build_house": return "build a small house";
    case "farm_wheat": return `plant wheat in ${task.width}×${task.depth} plot`;
    case "excavate_volume": return `excavate ${task.width}×${task.height}×${task.depth}`;
  }
}

function itemLabel(itemName: string, count: number): string {
  return `${count} ${itemName.replaceAll("_", " ")}${count === 1 ? "" : "s"}`;
}

function inventoryAndGearSummary(state: MinecraftObservation): string {
  const gear = [
    `hand ${state.equipment.hand?.name ?? "empty"}`,
    `head ${state.equipment.head?.name ?? "empty"}`,
    `torso ${state.equipment.torso?.name ?? "empty"}`,
    `legs ${state.equipment.legs?.name ?? "empty"}`,
    `feet ${state.equipment.feet?.name ?? "empty"}`,
  ].join(", ");
  const items = state.inventory.slice(0, 8).map((item) => `${item.name}×${item.count}`).join(", ") || "inventory empty";
  return `${gear}; inventory ${items}; health ${state.player.health ?? "unknown"}/20, food ${state.player.food ?? "unknown"}/20`;
}

const CHAT_DUPLICATE_WINDOW_MS = 1_200;
const CHAT_DEDUPE_MAX_ENTRIES = 64;
const CHAT_REPLY_MAX_CHARS = 240;
/** A single queued chat command that takes longer than this is abandoned so the queue cannot jam behind it. */
const CHAT_HANDLE_TIMEOUT_MS = 20_000;

/**
 * Chat controls answered without waiting for the queue. `status` only reads; the others change what the agent
 * does, so they also supersede queued work that has not reached its side effect yet. `come` and `follow` are
 * here because they are how the operator keeps the agent near them - waiting behind an unrelated slow command
 * is exactly the moment they are needed.
 */
const CHAT_PRIORITY_MODES: ReadonlySet<string> = new Set(["status", "stop", "hold", "come", "follow"]);

/** Thrown when a chat step is abandoned; lets a caller tell a timeout from a command that failed. */
export class ChatTimeoutError extends Error {
  constructor(readonly timeoutMs: number, label: string) {
    super(`Chat command timed out after ${timeoutMs} ms: ${label.slice(0, 40)}`);
    this.name = "ChatTimeoutError";
  }
}

/** Rejects if `work` does not settle in time; the caller reports the failure and the queue moves on. */
export function withChatTimeout<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ChatTimeoutError(timeoutMs, label)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Live chat gate and finite command interpreter; only authorized unrecognized chat may reach the optional local helper. */
export class MinecraftChatController {
  private unsubscribers: Array<() => void> = [];
  private stopped = false;
  private processing: Promise<void> = Promise.resolve();
  private readonly latency = new ChatLatencyMetrics();
  /**
   * The message being answered right now, so `say` attributes its first reply to the message that caused it.
   * Saved and restored around every answer because priority controls bypass the queue and can interleave
   * with a queued command.
   */
  private activeTiming: ChatMessageTiming | null = null;
  private readonly recentMessages = new Map<string, number>();
  private workflowGeneration = 0;
  private activeTask: MinecraftTask | null = null;
  private activeOrder: ResourceOrder | null = null;
  private lastResource: Pick<ResourceOrder, "resourceName" | "itemName" | "label"> | null = null;
  private pendingDelivery: PendingDelivery | null = null;
  private pendingResume: PendingResume | null = null;
  private pendingProjectApproval: PendingProjectApproval | null = null;
  private pendingMaterialApproval: PendingMaterialApproval | null = null;
  private interruptedTask: MinecraftTask | null = null;
  private interruptedOrder: ResourceOrder | null = null;
  private deathPosition: { readonly x: number; readonly y: number; readonly z: number } | null = null;
  private deliveryGeneration = 0;
  private questionTimer: NodeJS.Timeout | null = null;
  /** Bumped by every queue-bypassing control that changes behaviour, so queued work can see it was overtaken. */
  private priorityGeneration = 0;
  /** The priority generation in force when the message being handled now was let through; null outside the queue. */
  private queuedPriorityAt: number | null = null;
  private helperUnavailableNoted = false;

  constructor(private readonly options: MinecraftChatControllerOptions) {
    if (!/^[A-Za-z0-9_]{3,16}$/.test(options.operatorUsername)) {
      throw new Error("Chat operator must be one exact 3 to 16 character Minecraft username.");
    }
  }

  start(): void {
    if (this.unsubscribers.length > 0) return;
    this.stopped = false;
    this.unsubscribers.push(this.options.transport.onChatMessage((message) => {
      // This check is intentionally repeated even though the adapter exposes an operator setting.
      // No other player, including a look-alike with different letter case, can start an action.
      if (message.username !== this.options.operatorUsername) {
        this.latency.messageIgnored();
        return;
      }
      const normalized = message.message.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
      if (!normalized) {
        this.latency.messageIgnored();
        return;
      }
      const command = parseMinecraftChatCommand(message.message);
      const confirmationStage = command?.kind === "confirm"
        ? this.pendingDelivery ? "delivery"
          : this.pendingResume ? "resume"
            : this.pendingMaterialApproval ? "material"
              : this.pendingProjectApproval ? "project"
                : "none"
        : "";
      const now = Date.now();
      for (const [key, at] of this.recentMessages) {
        if (now - at > 10_000) this.recentMessages.delete(key);
      }
      // Identical confirmations in two successive approval stages are distinct operator decisions.
      const fingerprint = `${message.username}\u0000${confirmationStage}\u0000${normalized}`;
      const previousAt = this.recentMessages.get(fingerprint);
      if (previousAt !== undefined && now - previousAt < CHAT_DUPLICATE_WINDOW_MS) {
        this.latency.messageIgnored();
        return;
      }
      this.recentMessages.set(fingerprint, now);
      while (this.recentMessages.size > CHAT_DEDUPE_MAX_ENTRIES) {
        const oldest = this.recentMessages.keys().next().value;
        if (oldest === undefined) break;
        this.recentMessages.delete(oldest);
      }
      const timing = this.latency.messageReceived();
      if (command?.kind === "mode" && CHAT_PRIORITY_MODES.has(command.mode)) {
        // A queued project preflight or local-model reply must never delay status or the operator's stop.
        // The control itself is still bounded: a hanging adapter call must not leave the operator without an
        // answer, and for anything but `status` the fallback stops the task instead of trusting the mode call.
        if (command.mode !== "status") this.priorityGeneration += 1;
        this.answerOutsideQueue(
          timing,
          () => withChatTimeout(this.handleMode(command.mode), this.chatTimeoutMs, `mode ${command.mode}`),
          (error: unknown) => {
            this.options.logger.error({ err: error, mode: command.mode }, "Priority Minecraft chat control failed");
            this.say("Der Steuerbefehl ist fehlgeschlagen. Der laufende Auftrag wird vorsichtshalber gestoppt.");
            if (command.mode !== "status") this.options.requestTaskStop("priority chat control failed");
          },
        );
        return;
      }

      if (command?.kind === "help") {
        // Help has no side effects; it must answer even while a task or a slow reply holds the queue.
        this.answerOutsideQueue(timing, () => {
          for (const line of describeMinecraftChatHelp(detectChatLanguage(message.message, "en"))) this.say(line);
        });
        return;
      }

      const receivedPosition = this.positionAtChatReceipt();
      this.processing = this.processing
        .then(() => this.answerInQueue(timing, message.message, receivedPosition))
        .catch((error: unknown) => {
          // Safety net: the answer itself reports its own failures, so only a bug in the queue or the
          // measurement reaches this. It must not be able to jam the chain either.
          this.options.logger.error({ err: error }, "Minecraft chat queue link failed");
        });
    }));
    if (this.options.transport.onDeath) this.unsubscribers.push(this.options.transport.onDeath(() => this.onDeath()));
    if (this.options.transport.onRespawn) this.unsubscribers.push(this.options.transport.onRespawn(() => this.onRespawn()));
  }

  stop(): void {
    this.stopped = true;
    this.workflowGeneration += 1;
    this.deliveryGeneration += 1;
    this.clearQuestionTimer();
    if (this.options.taskRunning()) this.options.requestTaskStop("Minecraft chat controller stopped");
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.pendingDelivery = null;
    this.pendingResume = null;
    this.pendingProjectApproval = null;
    this.pendingMaterialApproval = null;
  }

  /** One queued message: wait for the chain, handle it under the queue timeout, then report what it cost. */
  private async answerInQueue(
    timing: ChatMessageTiming,
    raw: string,
    receivedPosition: { readonly x: number; readonly y: number; readonly z: number } | null,
  ): Promise<void> {
    const outer = this.activeTiming;
    const outerPriorityAt = this.queuedPriorityAt;
    this.activeTiming = timing;
    // Captured before the first await, so a control that bypasses the queue while this message is being
    // handled is still visible at the point where the message would take over the agent.
    this.queuedPriorityAt = this.priorityGeneration;
    this.latency.handlingStarted(timing);
    let failure: unknown = null;
    try {
      await withChatTimeout(this.handle(raw, receivedPosition), this.chatTimeoutMs, raw);
    } catch (error: unknown) {
      failure = error;
      this.options.logger.error({ err: error }, "Operator chat command failed");
      this.say("Der Chatbefehl ist fehlgeschlagen; ich habe keine erfolgreiche Aktion bestätigt.");
    } finally {
      this.reportLatency(this.latency.handlingFinished(timing, { timedOut: failure instanceof ChatTimeoutError }));
      this.activeTiming = outer;
      this.queuedPriorityAt = outerPriorityAt;
    }
  }

  /**
   * One message answered without the queue: priority controls and help. `answer` runs immediately, so a stop
   * is never delayed by measurement; a promise it returns is waited for only to time the answer.
   */
  private answerOutsideQueue(
    timing: ChatMessageTiming,
    answer: () => Promise<void> | void,
    onFailure: (error: unknown) => void = () => undefined,
  ): void {
    const outer = this.activeTiming;
    this.activeTiming = timing;
    this.latency.handlingStarted(timing);
    const finish = (error: unknown): void => {
      if (error !== null) onFailure(error);
      this.reportLatency(this.latency.handlingFinished(timing, { timedOut: error instanceof ChatTimeoutError }));
      this.activeTiming = outer;
    };
    let outcome: Promise<void> | void;
    try {
      outcome = answer();
    } catch (error: unknown) {
      finish(error);
      return;
    }
    if (outcome === undefined) {
      finish(null);
      return;
    }
    void outcome.then(() => finish(null), (error: unknown) => finish(error));
  }

  /** One log line per answered message, and a warning naming the target it breached. */
  private reportLatency(sample: ChatLatencySample | null): void {
    if (sample === null) return;
    const breaches = chatLatencyBreaches(sample);
    if (breaches.length > 0) {
      this.options.logger.warn({ chat: sample, breaches }, "Minecraft chat answer breached a response-time target");
      return;
    }
    this.options.logger.debug({ chat: sample }, "Minecraft chat latency");
  }

  /**
   * True when a control that bypasses the queue arrived while the queued message now running was handled.
   * The message may still answer, but it must not take over the agent afterwards: the operator's newer
   * command is the one that counts. `deliverToOperator` is covered by `deliveryGeneration` instead, which
   * `cancelPendingWorkflow` already bumps, so it aborts between its own steps.
   */
  private supersededByPriority(): boolean {
    return this.queuedPriorityAt !== null && this.priorityGeneration !== this.queuedPriorityAt;
  }

  /** Measured chat response times: for the Control Center, and for reading a live session afterwards. */
  chatLatency(): ChatLatency {
    return this.latency.summary();
  }

  private say(message: string): void {
    if (this.stopped) return;
    if (this.activeTiming !== null) this.latency.replySent(this.activeTiming);
    // Mineflayer chat has no line breaks: a multi-line reply becomes one chat message per line, so a
    // command list arrives as a readable list instead of a run-on sentence.
    for (const line of message.split(/\r\n|\r|\n/)) this.sayChunks(line);
  }

  private sayChunks(line: string): void {
    if (this.stopped) return;
    let remainder = line.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
    if (!remainder) return;
    const chunks: string[] = [];
    while (remainder.length > CHAT_REPLY_MAX_CHARS) {
      let splitAt = remainder.lastIndexOf(" ", CHAT_REPLY_MAX_CHARS);
      if (splitAt <= 0) splitAt = CHAT_REPLY_MAX_CHARS;
      chunks.push(remainder.slice(0, splitAt).trim());
      remainder = remainder.slice(splitAt).trim();
    }
    if (remainder) chunks.push(remainder);
    for (const [index, chunk] of chunks.entries()) {
      try {
        this.options.transport.sendChat(chunk);
      } catch (error) {
        this.options.logger.warn({ err: error, chunk: index + 1 }, "Could not send Minecraft chat reply");
      }
    }
  }

  private clearQuestionTimer(): void {
    if (this.questionTimer) clearTimeout(this.questionTimer);
    this.questionTimer = null;
  }

  /** One queued chat step may take this long before the queue abandons it and moves on. */
  private get chatTimeoutMs(): number {
    return this.options.chatTimeoutMs ?? CHAT_HANDLE_TIMEOUT_MS;
  }

  /**
   * Tells the operator once per session why the optional local helper is silent (no Ollama server, missing
   * model, or answers the safety filter refused), so terse deterministic replies do not look like a bug.
   */
  private noteChatHelperUnavailable(responder: MinecraftChatResponder, language: "de" | "en"): void {
    if (this.helperUnavailableNoted) return;
    const reason = responder.unavailableReason?.();
    if (!reason) return;
    this.helperUnavailableNoted = true;
    this.say(describeChatHelperUnavailable(language, reason));
  }

  private scheduleQuestionTimeout(): void {
    this.clearQuestionTimer();
    const expiresAt = this.pendingDelivery?.expiresAt ?? this.pendingResume?.expiresAt ?? this.pendingProjectApproval?.expiresAt ?? this.pendingMaterialApproval?.expiresAt;
    if (expiresAt === undefined) return;
    this.questionTimer = setTimeout(() => {
      this.questionTimer = null;
      // This link is appended outside the message handler, so it needs a timeout of its own. Without one a
      // hang while resuming follow mode leaves `processing` unsettled forever and blocks every later
      // message permanently, instead of costing the queue one timeout like a hung command does.
      // `expirePendingQuestion` clears all pending approvals before its only await, so an expiry abandoned
      // here has still failed closed: nothing is left that a late "ja" could act on.
      this.processing = this.processing
        .then(() => withChatTimeout(this.expirePendingQuestion(), this.chatTimeoutMs, "confirmation deadline"))
        .catch((error: unknown) => {
          this.options.logger.warn({ err: error }, "Could not expire a Minecraft chat confirmation");
        });
    }, Math.max(0, expiresAt - Date.now()));
    this.questionTimer.unref?.();
  }

  private async expirePendingQuestionIfNeeded(): Promise<void> {
    const expiresAt = this.pendingDelivery?.expiresAt ?? this.pendingResume?.expiresAt ?? this.pendingProjectApproval?.expiresAt ?? this.pendingMaterialApproval?.expiresAt;
    if (expiresAt !== undefined && Date.now() >= expiresAt) await this.expirePendingQuestion();
  }

  private async expirePendingQuestion(): Promise<void> {
    const expiresAt = this.pendingDelivery?.expiresAt ?? this.pendingResume?.expiresAt ?? this.pendingProjectApproval?.expiresAt ?? this.pendingMaterialApproval?.expiresAt;
    if (expiresAt === undefined) return;
    if (Date.now() < expiresAt) {
      this.scheduleQuestionTimeout();
      return;
    }
    this.pendingDelivery = null;
    this.pendingResume = null;
    this.pendingProjectApproval = null;
    this.pendingMaterialApproval = null;
    this.clearQuestionTimer();
    this.say("Die Bestätigungsfrist ist abgelaufen. Ich starte keine Rückkehr, Fortsetzung, Materialsammlung oder Projektänderung und nehme den Follow-Modus wieder auf.");
    await this.resumeFollowing();
  }

  private positionAtChatReceipt(): { readonly x: number; readonly y: number; readonly z: number } | null {
    const world = this.options.runtime.currentWorldState;
    if (!world || world.state.player.alive !== true) return null;
    const observedAt = Date.parse(world.observedAt);
    const age = Date.now() - observedAt;
    if (!Number.isFinite(observedAt) || age < -500 || age > 2_000) return null;
    return { ...world.state.player.position };
  }

  private async handle(raw: string, receivedPosition: { readonly x: number; readonly y: number; readonly z: number } | null): Promise<void> {
    if (this.stopped || !raw.trim()) return;
    await this.expirePendingQuestionIfNeeded();
    const command = parseMinecraftChatCommand(raw);
    if (!command) {
      const language = detectChatLanguage(raw, "de");
      // A near-miss of a control word gets a question, never an action: the operator confirms by sending the words.
      const suggestion = suggestMinecraftChatCommand(raw);
      if (suggestion) {
        this.say(language === "de"
          ? `Meintest du „${suggestion}“? Dann sende genau dieses Wort. Ich habe noch nichts ausgeführt.`
          : `Did you mean “${suggestion}”? Send exactly that word. I have not run anything yet.`);
        return;
      }
      const responder = this.options.chatResponder;
      if (responder) {
        const responderStartedAt = Date.now();
        const reply = await responder.reply(raw);
        if (this.activeTiming !== null) this.latency.recordResponder(this.activeTiming, Math.max(0, Date.now() - responderStartedAt));
        if (this.stopped) return;
        if (reply) {
          this.say(reply);
          return;
        }
      }
      // No model answer (none configured, unavailable, or refused): the deterministic answer still
      // teaches the operator the commands instead of only pointing at 'hilfe'.
      for (const line of describeUnknownChatFallback(language)) this.say(line);
      if (responder) this.noteChatHelperUnavailable(responder, language);
      return;
    }
    if (command.kind === "confirm") return this.handleConfirmation(command.yes);
    if (command.kind === "mode") return this.handleMode(command.mode);
    if (command.kind === "help") {
      for (const line of describeMinecraftChatHelp(detectChatLanguage(raw, "en"))) this.say(line);
      return;
    }
    if (command.kind === "resource") {
      this.lastResource = { resourceName: command.resourceName, itemName: command.itemName, label: command.label };
      const order = await this.prepareResourceOrder(command);
      if (order) await this.startTask(this.makeResourceTask(order), order);
      return;
    }
    if (command.kind === "continue-resource") {
      if (!this.lastResource) {
        this.say("Ich weiß noch nicht, welche Ressource du meinst. Nenne bitte Stein, Eisen, Kohle, Kupfer, Holz oder Diamanten.");
        return;
      }
      const state = await this.freshState();
      if (!state) return;
      const initialCount = itemCount(state, this.lastResource.itemName);
      const total = command.countMode === "total" ? command.count : initialCount + command.count;
      if (total < 1 || total > 64) {
        this.say(`Das Ziel ${total} überschreitet das sichere Auftragslimit von 64 Gegenständen.`);
        return;
      }
      const order: ResourceOrder = {
        ...this.lastResource,
        requestedCount: command.count,
        countMode: command.countMode,
        initialCount,
      };
      await this.startTask(this.makeResourceTask(order, total), order);
      return;
    }
    if (command.kind === "craft") {
      const state = await this.freshState();
      if (!state) return;
      const total = itemCount(state, command.itemName) + command.count;
      if (total > 64) {
        this.say("Das Crafting-Ziel überschreitet das sichere Auftragslimit von 64 Gegenständen.");
        return;
      }
      const task = craftItemTaskSchema.parse({
        id: `chat-craft-${command.itemName}-${Date.now().toString(36)}`,
        kind: "craft_item",
        targetItem: command.itemName,
        targetCount: total,
        maxActions: 80,
        maxDurationMs: 300_000,
      });
      await this.startTask(task, null);
      return;
    }
    if (command.kind === "house_plan") {
      const canceledQuestion = this.cancelPendingQuestions();
      const german = /\b(?:baue|bau|errichte|haus|hütte|huette)\b/i.test(raw);
      const activeTaskNotice = this.options.taskRunning()
        ? german ? "Ein bereits laufender Auftrag bleibt unverändert aktiv; sende status oder stopp."
          : "An already-running task continues unchanged; send status or stop."
        : german ? "Ein vorheriger Auftrag kann bereits Blöcke geändert haben; sende status."
          : "A previous task may already have changed blocks; send status to check.";
      const canceledQuestionNotice = canceledQuestion
        ? german ? "Eine frühere Ja/Nein-Rückfrage wurde verworfen und kann nichts für diese Anfrage freigeben."
          : "An earlier yes/no question was canceled and cannot authorize this request."
        : "";
      this.say(german
        ? `Ich ersetze deinen Wunsch nach einem großen Haus nicht stillschweigend durch den festen 5×5-Prototyp. Die Entwürfe A (bayerisches Fachwerk), B (moderner Innenhof) und C (Alpen-Lodge) sind verfügbar; sage „plane Haus A“, „plane Haus B“ oder „plane Haus C“ für einen reinen Offline-Blockplan. Für diese Anfrage habe ich keinen Bau gestartet. ${activeTaskNotice} ${canceledQuestionNotice}`
        : `I will not silently replace your large-house request with the fixed 5×5 prototype. Drafts A (Bavarian timber), B (modern courtyard), and C (Alpine lodge) are available; say “plan house A”, “plan house B”, or “plan house C” for a planning-only blueprint. No build was started. ${activeTaskNotice} ${canceledQuestionNotice}`);
      return;
    }
    if (command.kind === "house_blueprint") {
      const canceledQuestion = this.cancelPendingQuestions();
      const blueprint = generateLargeHouseBlueprint(command.conceptId);
      const materialPreview = Object.entries(blueprint.materials)
        .slice(0, 6)
        .map(([material, count]) => `${material.replace("minecraft:", "")}×${count}`)
        .join(", ");
      const roomPreview = blueprint.rooms
        .filter((room) => room.floor === "ground")
        .map((room) => room.name)
        .slice(0, 4)
        .join(", ");
      const german = /\b(?:plane|entwirf|haus|hütte|huette|entwurf)\b/i.test(raw);
      const canceledNotice = canceledQuestion
        ? german ? " Eine frühere Ja/Nein-Rückfrage wurde verworfen und kann keine Aktion freigeben." : " An earlier yes/no prompt was canceled and cannot authorize an action."
        : "";
      this.say(german
        ? `Offline-Entwurf ${blueprint.conceptId}: ${blueprint.name}, ${blueprint.dimensions.x}×${blueprint.dimensions.y}×${blueprint.dimensions.z}, ${blueprint.blocks.length} Blockzellen. Erdgeschoss: ${roomPreview}. Materialien: ${materialPreview}.`
        : `Offline plan ${blueprint.conceptId}: ${blueprint.name}, ${blueprint.dimensions.x}×${blueprint.dimensions.y}×${blueprint.dimensions.z}, ${blueprint.blocks.length} block cells. Ground floor: ${roomPreview}. Materials: ${materialPreview}.`);
      this.say(german
        ? `Das ist nur ein relativer Entwurf: keine Welterkundung, kein Terraforming, keine Materialsammlung und kein Bau. --house-plan ${blueprint.conceptId} druckt eine Übersicht; mit --house-plan-json ./house-${blueprint.conceptId.toLowerCase()}.json werden alle Blockzellen exportiert.${canceledNotice}`
        : `This is a relative plan only: no world inspection, terrain work, material gathering, or build. --house-plan ${blueprint.conceptId} prints a summary; add --house-plan-json ./house-${blueprint.conceptId.toLowerCase()}.json to export every block cell.${canceledNotice}`);
      return;
    }
    if (command.kind === "house") {
      this.beginHouse(command, receivedPosition);
      return;
    }
    if (command.kind === "shelter") {
      const task = buildShelterTaskSchema.parse({
        id: `chat-shelter-${Date.now().toString(36)}`,
        mode: "full",
        maxBlocks: 26,
        maxActions: 150,
        maxDurationMs: 420_000,
      });
      await this.startTask(task, null);
      return;
    }
    if (command.kind === "excavate") {
      this.beginExcavation(command, receivedPosition);
      return;
    }
    if (command.kind === "farm_wheat") {
      this.beginWheatFarm(command, receivedPosition);
      return;
    }
    if (command.kind === "food") {
      const task = secureFoodTaskSchema.parse({
        id: `chat-food-${Date.now().toString(36)}`,
        targetHunger: 18,
        maxActions: 64,
        maxDurationMs: 180_000,
      });
      await this.startTask(task, null);
    }
  }

  private beginExcavation(
    command: Extract<MinecraftChatCommand, { kind: "excavate" }>,
    receivedPosition: { readonly x: number; readonly y: number; readonly z: number } | null,
  ): void {
    this.cancelPendingWorkflow("operator requested a new destructive volume plan");
    if (this.options.taskRunning()) {
      this.say("Ich stoppe den bisherigen Auftrag, aber der Scheduler läuft noch aus. Sende den Grabauftrag erneut, sobald status ‚idle‘ meldet.");
      return;
    }
    const totalCells = command.width * command.height * command.depth;
    if (totalCells < 1 || totalCells > 1_000 || command.width > 10 || command.height > 10 || command.depth > 10) {
      this.say("Ein Grabauftrag ist auf höchstens 10×10×10 = 1.000 Zellen begrenzt.");
      return;
    }
    let origin: { x: number; y: number; z: number };
    let topY: number;
    if (command.coordinates) {
      topY = command.coordinates.y;
      origin = { x: command.coordinates.x, y: topY - command.height + 1, z: command.coordinates.z };
    } else {
      if (!receivedPosition) {
        this.say("Ich habe beim Empfang keine frische Spielerposition. Wiederhole den Befehl oder nenne Koordinaten.");
        return;
      }
      topY = Math.floor(receivedPosition.y) - 1;
      origin = {
        x: Math.floor(receivedPosition.x) - Math.floor(command.width / 2),
        y: topY - command.height + 1,
        z: Math.floor(receivedPosition.z) - Math.floor(command.depth / 2),
      };
    }
    let task: ExcavateVolumeTask;
    try {
      task = excavateVolumeTaskSchema.parse({
        id: `chat-excavate-${Date.now().toString(36)}`,
        kind: "excavate_volume",
        origin,
        width: command.width,
        height: command.height,
        depth: command.depth,
        maxActions: Math.min(5_000, totalCells * 4 + 32),
        maxDurationMs: 1_800_000,
        maxTargetDistance: 96,
        dangerRadius: 6,
      });
    } catch (error) {
      this.say(`Der Grabplan ist ungültig: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.pendingProjectApproval = {
      task,
      expiresAt: Date.now() + (this.options.confirmationTimeoutMs ?? 120_000),
    };
    this.scheduleQuestionTimeout();
    const anchor = command.coordinates
      ? `Oberseite bei ${command.coordinates.x},${topY},${command.coordinates.z}`
      : `Empfangsposition, Oberseite y=${topY}, untere Ecke ${origin.x},${origin.y},${origin.z}`;
    this.say(`Plan: ${command.width}×${command.height}×${command.depth}; ${anchor}; höchstens ${totalCells} Zellen. „Hier“ ist horizontal zentriert.`);
    this.say("Ich verlasse zuerst die Grundfläche, prüfe jede Zelle und grabe von oben nach unten. Unbekannte, instabile oder nicht unterstützte Blöcke stoppen den Auftrag. Noch keine Änderung: Ja/Nein?");
  }

  private beginHouse(
    command: Extract<MinecraftChatCommand, { kind: "house" }>,
    receivedPosition: { readonly x: number; readonly y: number; readonly z: number } | null,
  ): void {
    this.cancelPendingWorkflow("operator requested a new house project plan");
    if (this.options.taskRunning()) {
      this.say("Ich stoppe den bisherigen Auftrag, aber der Scheduler läuft noch aus. Wiederhole den Hausbau-Befehl, sobald kein Task mehr aktiv ist.");
      return;
    }
    if (!command.coordinates && !receivedPosition) {
      this.say("Ich habe beim Empfang keine frische Spielerposition. Wiederhole den Hausbau-Befehl nahe dem gewünschten Bauplatz.");
      return;
    }
    const origin = command.coordinates ?? {
      x: Math.floor(receivedPosition!.x) - 2,
      y: Math.floor(receivedPosition!.y),
      z: Math.floor(receivedPosition!.z) - 2,
    };
    let task: BuildHouseTask;
    try {
      task = buildHouseTaskSchema.parse({
        id: `chat-house-${Date.now().toString(36)}`,
        kind: "build_house",
        origin,
        materialName: "oak_planks",
        maxActions: 1_000,
        maxDurationMs: 1_800_000,
      });
    } catch (error) {
      this.say(`Der Hausplan ist ungültig: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.pendingProjectApproval = {
      task,
      expiresAt: Date.now() + (this.options.confirmationTimeoutMs ?? 120_000),
    };
    this.scheduleQuestionTimeout();
    const placement = command.coordinates ? "an der angegebenen unteren Ecke" : "um die beim Empfang gemessene Spielerposition";
    this.say(`Starterhaus-Prototyp: geschlossenes 5×5-Holzhaus mit offenem Eingang ${placement}, Start ${task.origin.x},${task.origin.y},${task.origin.z}; Bedarf 80 Eichenbretter. Das ist nicht der geplante große Hausentwurf.`);
    this.say("Ich prüfe zuerst Boden und Platz und nutze nur mitgeführte Materialien. Falls Sammeln nötig wäre, frage ich danach separat (höchstens 20 sichtbare Eichenstämme innerhalb 24 Blöcken). Bei unsicherem Platz stoppe ich. Starterhaus prüfen/bauen? Ja/Nein?");
  }

  private beginWheatFarm(
    command: Extract<MinecraftChatCommand, { kind: "farm_wheat" }>,
    receivedPosition: { readonly x: number; readonly y: number; readonly z: number } | null,
  ): void {
    this.cancelPendingWorkflow("operator requested a new wheat-farm project plan");
    if (this.options.taskRunning()) {
      this.say("Ich stoppe den bisherigen Auftrag, aber der Scheduler läuft noch aus. Wiederhole den Farmbefehl, sobald kein Task mehr aktiv ist.");
      return;
    }
    const cells = command.width * command.depth;
    if (cells < 1 || cells > 1_250 || command.width > 25 || command.depth > 50) {
      this.say("Ein Weizenfeld ist auf höchstens 25×50 = 1.250 Zellen begrenzt.");
      return;
    }
    if (!command.coordinates && !receivedPosition) {
      this.say("Ich habe beim Empfang keine frische Spielerposition. Wiederhole den Farmbefehl oder nenne Koordinaten.");
      return;
    }
    const origin = command.coordinates
      ? { ...command.coordinates }
      : {
          x: Math.floor(receivedPosition!.x) - Math.floor(command.width / 2),
          y: Math.floor(receivedPosition!.y),
          z: Math.floor(receivedPosition!.z) - Math.floor(command.depth / 2),
        };
    let task: FarmWheatTask;
    try {
      task = farmWheatTaskSchema.parse({
        id: `chat-farm-wheat-${Date.now().toString(36)}`,
        kind: "farm_wheat",
        origin,
        width: command.width,
        depth: command.depth,
        maxActions: 5_000,
        maxDurationMs: 1_800_000,
        maxTargetDistance: 48,
      });
    } catch (error) {
      this.say(`Der Farmplan ist ungültig: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.pendingProjectApproval = {
      task,
      expiresAt: Date.now() + (this.options.confirmationTimeoutMs ?? 120_000),
    };
    this.scheduleQuestionTimeout();
    this.say(`Farmplan: ${task.width}×${task.depth} Weizen ab Pflanzzelle ${task.origin.x},${task.origin.y},${task.origin.z}; höchstens ${cells} Pflanzen.`);
    this.say("Voraussetzung: vollständig bewässerte Ackerbodenfläche und Samen für alle leeren Zellen. Ich entferne keine Bäume, pflüge nicht und setze kein Wasser. Erst nach kompletter Prüfung pflanze ich. Ja/Nein?");
  }

  private async prepareResourceOrder(command: Extract<MinecraftChatCommand, { kind: "resource" }>): Promise<ResourceOrder | null> {
    const state = await this.freshState();
    if (!state) return null;
    const initialCount = itemCount(state, command.itemName);
    const total = command.countMode === "total" ? command.count : initialCount + command.count;
    if (total < 1 || total > 64) {
      this.say(`Das Ziel ${total} überschreitet das sichere Auftragslimit von 64 Gegenständen.`);
      return null;
    }
    return {
      resourceName: command.resourceName,
      itemName: command.itemName,
      label: command.label,
      requestedCount: command.count,
      countMode: command.countMode,
      initialCount,
    };
  }

  private makeResourceTask(order: ResourceOrder, explicitTotal?: number): MinecraftTask {
    const total = explicitTotal ?? (order.countMode === "total" ? order.requestedCount : order.initialCount + order.requestedCount);
    const id = `chat-${order.itemName}-${Date.now().toString(36)}`;
    const limits = { maxActions: 160, maxDurationMs: 900_000, maxExplorationLegs: 20, explorationRadius: 96 };
    if ((minecraftLogNames as readonly string[]).includes(order.resourceName)) {
      return gatherResourceTaskSchema.parse({ id, resourceName: order.resourceName, targetCount: total, ...limits });
    }
    return mineResourceTaskSchema.parse({ id, kind: "mine_resource", resourceName: order.resourceName, targetCount: total, ...limits });
  }

  private async freshState(): Promise<MinecraftObservation | null> {
    const world = await this.options.runtime.observeIfStale(0);
    if (!world || world.state.player.alive === false) {
      this.say("Ich habe gerade keinen bestätigten lebenden Spielerzustand; ich starte keinen Auftrag.");
      return null;
    }
    return world.state;
  }

  private async startTask(task: MinecraftTask, order: ResourceOrder | null): Promise<void> {
    if (this.supersededByPriority()) {
      this.options.logger.info({ task: taskName(task) }, "Queued chat command superseded by a newer control; no task started");
      this.say(`Ich habe „${taskName(task)}“ nicht gestartet: Dein Steuerbefehl danach hat Vorrang. Sage es erneut, wenn ich es ausführen soll.`);
      return;
    }
    if (this.options.taskRunning() && !this.options.currentTask()) {
      this.say("Der Task-Scheduler ist beschäftigt; ich kann den Chat-Auftrag gerade nicht sicher annehmen.");
      return;
    }
    this.workflowGeneration += 1;
    const generation = this.workflowGeneration;
    this.deliveryGeneration += 1;
    this.clearQuestionTimer();
    this.pendingDelivery = null;
    this.pendingResume = null;
    this.pendingProjectApproval = null;
    this.pendingMaterialApproval = null;
    this.interruptedTask = null;
    this.interruptedOrder = null;
    this.activeTask = task;
    this.activeOrder = order;
    this.say(`Auftrag gestartet: ${taskName(task)}${order ? `, Ziel ${order.countMode === "total" ? order.requestedCount : order.initialCount + order.requestedCount} ${order.label}` : ""}. Folgebewegung pausiert bis zum Abschluss.`);
    void this.options.runTask(task).then(async (result) => {
      if (generation !== this.workflowGeneration || this.stopped) return;
      this.activeTask = null;
      this.activeOrder = null;
      await this.finishTask(task, order, result);
    }).catch(async (error: unknown) => {
      if (generation !== this.workflowGeneration || this.stopped) return;
      this.activeTask = null;
      this.activeOrder = null;
      const message = error instanceof Error ? error.message : String(error);
      this.say(`Auftrag konnte nicht ausgeführt werden: ${message}`);
      await this.resumeFollowing();
    });
  }

  private async finishTask(task: MinecraftTask, order: ResourceOrder | null, result: MinecraftTaskResult): Promise<void> {
    if (order) {
      const state = result.finalObservation?.state ?? this.options.runtime.currentWorldState?.state ?? null;
      const gained = result.metrics.targetItemsGained;
      const available = state ? itemCount(state, order.itemName) : 0;
      const deliverCount = order.countMode === "total"
        ? Math.min(order.requestedCount, available)
        : Math.min(order.requestedCount, gained, available);
      if (deliverCount > 0) {
        this.pendingDelivery = {
          itemName: order.itemName,
          count: deliverCount,
          label: order.label,
          expiresAt: Date.now() + (this.options.confirmationTimeoutMs ?? 120_000),
        };
        this.scheduleQuestionTimeout();
        const hold = await this.options.companion.setMode("hold");
        if (!hold.ok) this.options.logger.warn({ message: hold.message }, "Could not hold after resource task");
        const resultText = result.status === "succeeded" ? "Ziel erreicht" : `Teilziel nach ${result.status}`;
        this.say(`${resultText}: Ich habe ${deliverCount} ${order.label} bereit. Soll ich zu dir kommen und sie ablegen? Antworte Ja oder Nein.`);
        return;
      }
    }
    const ending = result.status === "succeeded"
      ? `${taskName(task)} abgeschlossen.`
      : `${taskName(task)} beendet: ${result.failure?.code ?? result.status}${result.failure?.message ? ` — ${result.failure.message}` : ""}`;
    this.say(ending);
    await this.resumeFollowing();
  }

  private async handleMode(mode: "follow" | "come" | "hold" | "stop" | "status"): Promise<void> {
    if (mode === "status") {
      const status = await this.options.companion.getStatus();
      const task = this.activeTask ?? this.options.currentTask();
      const workflow = this.pendingDelivery
        ? `Offene Rückfrage: ${this.pendingDelivery.count} ${this.pendingDelivery.label} ablegen?`
        : this.pendingResume
          ? `Offene Rückfrage: ${taskName(this.pendingResume.task)} nach Respawn fortsetzen?`
          : this.pendingProjectApproval
            ? `Offene Freigabe: ${taskName(this.pendingProjectApproval.task)} ausführen?`
            : this.pendingMaterialApproval
              ? "Offene separate Freigabe: bis zu 20 sichtbare Eichenstämme für das Starterhaus sammeln?"
              : task
            ? `Aktueller Auftrag: ${taskName(task)}.`
            : this.options.taskRunning()
              ? "Ein Scheduler-Auftrag läuft."
              : "Kein Chat-Auftrag aktiv.";
      this.say(`${status.message} ${workflow}`);
      return;
    }
    this.cancelPendingWorkflow(`operator chat mode ${mode}`);
    if (mode === "stop" || mode === "hold") {
      const result = await this.options.companion.setMode("hold");
      this.say(result.ok ? "Stopp. Ich bleibe hier und starte keinen neuen Auftrag." : result.message);
      return;
    }
    const result = await this.options.companion.setMode(mode, { targetPlayer: this.options.operatorUsername });
    this.say(result.message);
  }

  private async handleConfirmation(yes: boolean): Promise<void> {
    if (this.pendingProjectApproval) {
      const approval = this.pendingProjectApproval;
      this.pendingProjectApproval = null;
      this.clearQuestionTimer();
      if (!yes) {
        this.say(approval.task.kind === "excavate_volume"
          ? "Verstanden. Der Grabplan wurde verworfen; es wurde kein Block verändert. Ich folge dir wieder."
          : approval.task.kind === "build_house"
            ? "Verstanden. Der Hausplan wurde verworfen; es wurde kein Block verändert. Ich folge dir wieder."
            : "Verstanden. Der Farmplan wurde verworfen; es wurde kein Samen gepflanzt. Ich folge dir wieder.");
        await this.resumeFollowing();
        return;
      }
      if (this.options.taskRunning()) {
        this.say(approval.task.kind === "excavate_volume"
          ? "Der Scheduler ist noch beschäftigt. Ich verwerfe die Freigabe ohne Änderungen; sende den Grabauftrag später erneut."
          : approval.task.kind === "build_house"
            ? "Der Scheduler ist noch beschäftigt. Ich verwerfe die Freigabe ohne Änderungen; sende den Hausbau-Befehl später erneut."
            : "Der Scheduler ist noch beschäftigt. Ich verwerfe die Freigabe ohne Änderungen; sende den Farmbefehl später erneut.");
        await this.resumeFollowing();
        return;
      }
      if (approval.task.kind === "build_house" && !approval.task.allowMaterialGathering) {
        this.pendingMaterialApproval = {
          task: approval.task,
          expiresAt: Date.now() + (this.options.confirmationTimeoutMs ?? 120_000),
        };
        this.scheduleQuestionTimeout();
        this.say("Separate Freigabe für Materialsammlung: Darf ich nur bei Bedarf bis zu 20 sichtbare Eichenstämme im Umkreis von 24 Blöcken sammeln? Ja/Nein. Bei Nein nutze ich ausschließlich mitgeführte Materialien und stoppe vor dem Bauen, falls sie nicht reichen.");
        return;
      }
      this.say(approval.task.kind === "excavate_volume"
        ? "Freigegeben. Ich grabe den bestätigten Plan Zelle für Zelle und stoppe bei jeder unbekannten oder unsicheren Stelle."
        : approval.task.kind === "build_house"
          ? "Freigegeben. Ich prüfe beim Bauen jeden Untergrund und Block; bei jeder Änderung oder Gefahr stoppe ich."
          : "Freigegeben. Ich pflanze nur auf vollständig geprüfter, bewässerter Erde und stoppe bei Änderungen oder Gefahr.");
      await this.startTask(approval.task, null);
      return;
    }
    if (this.pendingMaterialApproval) {
      const pending = this.pendingMaterialApproval;
      this.pendingMaterialApproval = null;
      this.clearQuestionTimer();
      if (this.options.taskRunning()) {
        this.say("Der Scheduler ist noch beschäftigt. Materialfreigabe verworfen; es wird nichts gesammelt oder gebaut.");
        await this.resumeFollowing();
        return;
      }
      const task = buildHouseTaskSchema.parse({ ...pending.task, allowMaterialGathering: yes });
      this.say(yes
        ? "Separate Materialsammlung freigegeben: nur die zum 80-Bretter-Budget fehlenden, sichtbaren Eichenstämme bis höchstens 20 Stück und 24 Blöcke Entfernung. Erst nach erneuter Sicherheitsprüfung beginnt der Bau."
        : "Materialsammlung abgelehnt. Ich nutze nur mitgeführte Bretter/Stämme; falls das nicht reicht, stoppe ich vor dem ersten Bau-Block.");
      await this.startTask(task, null);
      return;
    }
    if (this.pendingDelivery) {
      const delivery = this.pendingDelivery;
      this.pendingDelivery = null;
      this.clearQuestionTimer();
      if (!yes) {
        this.say("Verstanden. Ich lege nichts ab und folge dir wieder.");
        await this.resumeFollowing();
        return;
      }
      const deliveryGeneration = ++this.deliveryGeneration;
      void this.deliverToOperator(delivery, deliveryGeneration).catch((error: unknown) => {
        this.options.logger.error({ err: error }, "Minecraft chat hand-off workflow failed");
        if (!this.stopped && deliveryGeneration === this.deliveryGeneration) {
          this.say("Die bestätigte Ablage ist fehlgeschlagen; ich lege nichts weiter ab und halte an.");
          void this.options.companion.setMode("hold");
        }
      });
      return;
    }
    if (this.pendingResume) {
      const resume = this.pendingResume;
      this.pendingResume = null;
      this.clearQuestionTimer();
      if (!yes) {
        this.interruptedTask = null;
        this.interruptedOrder = null;
        this.say("Verstanden. Ich setze den letzten Auftrag nicht fort und folge dir wieder.");
        await this.resumeFollowing();
        return;
      }
      const state = await this.freshState();
      if (!state) return;
      if (resume.task.kind === "mine_resource") {
        const carried = [
          ...state.inventory.map((item) => ({ name: item.name })),
          ...Object.values(state.equipment).filter((item): item is NonNullable<typeof item> => item !== null).map((item) => ({ name: item.name })),
        ];
        const tier = bestPickaxeTier(carried).tier;
        const requirement = minecraftMiningRequirements[resume.task.resourceName];
        if (requirement.minPickaxeTier >= 3 && tier < requirement.minPickaxeTier) {
          this.say(`${resume.task.resourceName} benötigt mindestens eine Eisenspitzhacke. Sie ist nach dem Respawn nicht vorhanden; ich setze diesen Auftrag nicht fort.`);
          this.interruptedTask = null;
          this.interruptedOrder = null;
          await this.resumeFollowing();
          return;
        }
      }
      this.interruptedTask = null;
      this.interruptedOrder = null;
      this.say(`Ich setze ${taskName(resume.task)} jetzt fort.`);
      await this.startTask(resume.task, resume.order);
      return;
    }
    this.say("Es gibt gerade keine offene Ja/Nein-Rückfrage.");
  }

  /** Cancels stale yes/no context without stopping an unrelated task or changing its workflow generation. */
  private cancelPendingQuestions(): boolean {
    const hadPendingQuestion = Boolean(
      this.pendingDelivery || this.pendingResume || this.pendingProjectApproval || this.pendingMaterialApproval || this.interruptedTask,
    );
    if (this.pendingDelivery) this.deliveryGeneration += 1;
    if (this.pendingResume || this.interruptedTask || this.interruptedOrder) {
      this.workflowGeneration += 1;
      this.deathPosition = null;
    }
    this.clearQuestionTimer();
    this.pendingDelivery = null;
    this.pendingResume = null;
    this.pendingProjectApproval = null;
    this.pendingMaterialApproval = null;
    this.interruptedTask = null;
    this.interruptedOrder = null;
    return hadPendingQuestion;
  }

  private cancelPendingWorkflow(reason: string): void {
    this.workflowGeneration += 1;
    this.deliveryGeneration += 1;
    this.clearQuestionTimer();
    this.pendingDelivery = null;
    this.pendingResume = null;
    this.pendingProjectApproval = null;
    this.pendingMaterialApproval = null;
    this.interruptedTask = null;
    this.interruptedOrder = null;
    this.activeTask = null;
    this.activeOrder = null;
    if (this.options.taskRunning()) this.options.requestTaskStop(reason);
  }

  private async resumeFollowing(): Promise<void> {
    if (this.stopped) return;
    const result = await this.options.companion.setMode("follow", { targetPlayer: this.options.operatorUsername });
    if (!result.ok) this.options.logger.warn({ message: result.message }, "Could not resume operator follow mode");
  }

  private async deliverToOperator(delivery: PendingDelivery, generation: number): Promise<void> {
    const come = await this.options.companion.setMode("come", { targetPlayer: this.options.operatorUsername });
    if (this.stopped || generation !== this.deliveryGeneration) return;
    if (!come.ok) {
      this.say(`Ich kann gerade nicht zu dir kommen: ${come.message}`);
      await this.resumeFollowing();
      return;
    }
    this.say(`Ich komme zu dir. Ich lege ${itemLabel(delivery.itemName, delivery.count)} erst ab, wenn du sichtbar und nah bist.`);
    const deadline = Date.now() + (this.options.deliveryTimeoutMs ?? HANDOFF_TIMEOUT_MS);
    while (!this.stopped && generation === this.deliveryGeneration && Date.now() < deadline) {
      const world = await this.options.runtime.observeIfStale(500);
      if (world && world.state.player.alive === true) {
        const target = world.state.entities.find((entity) => entity.type === "player" && entity.name === this.options.operatorUsername);
        if (target && distance(target.position, world.state.player.position) <= HANDOFF_DISTANCE) {
          if (this.stopped || generation !== this.deliveryGeneration) return;
          const execution = await this.options.skills.run("minecraft.give-item", {
            itemName: delivery.itemName,
            count: delivery.count,
            targetUsername: this.options.operatorUsername,
            maxDistance: 3,
            dangerRadius: 6,
          }, { source: "operator-chat:confirmed-resource-delivery", timeoutMs: 10_000 });
          if (this.stopped || generation !== this.deliveryGeneration) return;
          const verification = execution.action.confirmed
            ? verifySkillPostcondition("minecraft.give-item", {
                itemName: delivery.itemName,
                count: delivery.count,
                targetUsername: this.options.operatorUsername,
                maxDistance: 3,
              }, execution.observationBefore?.state ?? null, execution.observationAfter?.state ?? null)
            : { verified: false, evidence: execution.action.failure?.message ?? "Adapter did not confirm the hand-off." };
          if (execution.action.status === "succeeded" && execution.action.confirmed && verification.verified === true) {
            this.say(`Abgelegt und Inventaränderung geprüft: ${itemLabel(delivery.itemName, delivery.count)}. Ich folge dir wieder.`);
            await this.resumeFollowing();
            return;
          }
          this.say(`Die Ablage ist nicht bestätigt: ${verification.evidence} Ich gebe nichts weiter aus und bleibe auf Abstand.`);
          await this.options.companion.setMode("hold");
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!this.stopped && generation === this.deliveryGeneration) {
      this.say("Ich konnte dich nicht sicher in Reichweite sehen; ich habe nichts abgelegt und bleibe stehen.");
      await this.options.companion.setMode("hold");
    }
  }

  private async equipCarriedGear(state: MinecraftObservation, generation: number): Promise<number> {
    let equipped = 0;
    const armorSlots = [
      { destination: "head" as const, itemPattern: /^(leather|chainmail|iron|golden|diamond|netherite|turtle)_helmet$/ },
      { destination: "torso" as const, itemPattern: /^(leather|chainmail|iron|golden|diamond|netherite)_chestplate$/ },
      { destination: "legs" as const, itemPattern: /^(leather|chainmail|iron|golden|diamond|netherite)_leggings$/ },
      { destination: "feet" as const, itemPattern: /^(leather|chainmail|iron|golden|diamond|netherite)_boots$/ },
    ];
    for (const slot of armorSlots) {
      if (this.stopped || generation !== this.workflowGeneration) return equipped;
      if (state.equipment[slot.destination]) continue;
      const carried = state.inventory.find((item) => slot.itemPattern.test(item.name));
      if (!carried) continue;
      try {
        const execution = await this.options.skills.run("minecraft.equip-item", {
          item: carried.name,
          destination: slot.destination,
        }, { source: "respawn:reequip-carried-armor", timeoutMs: 10_000 });
        if (this.stopped || generation !== this.workflowGeneration) return equipped;
        if (execution.action.status === "succeeded" && execution.action.confirmed) equipped += 1;
        if (execution.observationAfter) state = execution.observationAfter.state;
      } catch (error) {
        this.options.logger.warn({ err: error, itemName: carried.name }, "Could not re-equip carried respawn armor");
      }
    }

    const carriedPickaxe = bestPickaxeTier(state.inventory).name;
    const heldPickaxe = bestPickaxeTier(state.equipment.hand ? [state.equipment.hand] : []).name;
    if (carriedPickaxe && (!heldPickaxe || bestPickaxeTier(state.inventory).tier > bestPickaxeTier([state.equipment.hand!]).tier)) {
      try {
        const execution = await this.options.skills.run("minecraft.equip-item", {
          item: carriedPickaxe,
          destination: "hand",
        }, { source: "respawn:reequip-best-pickaxe", timeoutMs: 10_000 });
        if (!this.stopped && generation === this.workflowGeneration && execution.action.status === "succeeded" && execution.action.confirmed) equipped += 1;
      } catch (error) {
        this.options.logger.warn({ err: error, itemName: carriedPickaxe }, "Could not equip the best carried pickaxe after respawn");
      }
    }
    return equipped;
  }

  private async eatCarriedFood(state: MinecraftObservation, generation: number): Promise<number> {
    if (state.player.food === null || state.player.food >= 10) return 0;
    let meals = 0;
    let hunger = state.player.food;
    for (let attempt = 0; attempt < 3 && hunger < 10; attempt += 1) {
      if (this.stopped || generation !== this.workflowGeneration) break;
      const food = state.inventory.find((item) => (minecraftFoodNames as readonly string[]).includes(item.name));
      if (!food) break;
      try {
        const execution = await this.options.skills.run("minecraft.eat-food", { item: food.name }, {
          source: "respawn:eat-carried-food",
          timeoutMs: 10_000,
        });
        if (this.stopped || generation !== this.workflowGeneration) break;
        if (execution.action.status !== "succeeded" || !execution.action.confirmed || !execution.observationAfter) break;
        meals += 1;
        state = execution.observationAfter.state;
        hunger = state.player.food ?? hunger;
      } catch (error) {
        this.options.logger.warn({ err: error, itemName: food.name }, "Could not eat carried food after respawn");
        break;
      }
    }
    return meals;
  }

  private async rebuildBasicTools(state: MinecraftObservation, generation: number): Promise<number> {
    const plans = [
      { targetItem: "wooden_pickaxe" as const, names: new Set(["wooden_pickaxe", "stone_pickaxe", "iron_pickaxe", "diamond_pickaxe", "netherite_pickaxe"]), label: "Spitzhacke" },
      { targetItem: "wooden_axe" as const, names: new Set(["wooden_axe", "stone_axe", "iron_axe", "diamond_axe", "netherite_axe"]), label: "Axt" },
      { targetItem: "wooden_sword" as const, names: new Set(["wooden_sword", "stone_sword", "iron_sword", "diamond_sword", "netherite_sword"]), label: "Schwert" },
    ];
    let crafted = 0;
    for (const plan of plans) {
      if (this.stopped || generation !== this.workflowGeneration) return crafted;
      const current = this.options.runtime.currentWorldState?.state ?? state;
      const held = [
        ...current.inventory.map((item) => item.name),
        ...Object.values(current.equipment).filter((item): item is NonNullable<typeof item> => item !== null).map((item) => item.name),
      ];
      if (held.some((name) => plan.names.has(name))) continue;
      const task = craftItemTaskSchema.parse({
        id: `respawn-${plan.targetItem}-${Date.now().toString(36)}`,
        kind: "craft_item",
        targetItem: plan.targetItem,
        targetCount: 1,
        maxActions: 32,
        maxDurationMs: 90_000,
        maxExplorationLegs: 4,
        explorationRadius: 32,
      });
      this.activeTask = task;
      this.say(`Nach dem Respawn fehlt eine ${plan.label}; ich versuche, sie innerhalb eines begrenzten sicheren Budgets herzustellen.`);
      try {
        const result = await this.options.runTask(task);
        if (result.status === "succeeded") crafted += 1;
      } catch (error) {
        this.options.logger.warn({ err: error, itemName: plan.targetItem }, "Could not rebuild a basic tool after respawn");
      } finally {
        if (this.activeTask?.id === task.id) this.activeTask = null;
      }
    }
    return crafted;
  }

  private missingBasicGear(state: MinecraftObservation): string[] {
    const inventoryNames = new Set(state.inventory.map((item) => item.name));
    const gearNames = [state.equipment.hand?.name, state.equipment.head?.name, state.equipment.torso?.name, state.equipment.legs?.name, state.equipment.feet?.name].filter((name): name is string => Boolean(name));
    const held = new Set([...inventoryNames, ...gearNames]);
    const missing: string[] = [];
    if (!["wooden_pickaxe", "stone_pickaxe", "iron_pickaxe", "diamond_pickaxe", "netherite_pickaxe"].some((name) => held.has(name))) missing.push("Spitzhacke");
    if (!["wooden_axe", "stone_axe", "iron_axe", "diamond_axe", "netherite_axe"].some((name) => held.has(name))) missing.push("Axt");
    if (!["wooden_sword", "stone_sword", "iron_sword", "diamond_sword", "netherite_sword"].some((name) => held.has(name))) missing.push("Schwert");
    const hasArmor = [...inventoryNames, ...gearNames].some((name) => /^(leather|chainmail|iron|golden|diamond|netherite|turtle)_(helmet|chestplate|leggings|boots)$/.test(name));
    if (!hasArmor) missing.push("Rüstung");
    if (state.player.food !== null && state.player.food < 10 && !state.inventory.some((item) => (minecraftFoodNames as readonly string[]).includes(item.name))) missing.push("Essen");
    return missing;
  }

  private onDeath(): void {
    if (this.stopped) return;
    const state = this.options.runtime.currentWorldState?.state;
    this.deathPosition = state ? { ...state.player.position } : null;
    this.interruptedTask = this.options.currentTask() ?? this.activeTask;
    this.interruptedOrder = this.activeOrder;
    this.clearQuestionTimer();
    this.pendingDelivery = null;
    this.pendingResume = null;
    this.pendingProjectApproval = null;
    this.pendingMaterialApproval = null;
    this.workflowGeneration += 1;
    this.deliveryGeneration += 1;
    this.activeTask = null;
    this.activeOrder = null;
    this.options.requestTaskStop("death/respawn: pause the previous task until the operator confirms continuation");
    void this.options.companion.halt("player died; await operator confirmation after respawn").catch((error: unknown) => {
      this.options.logger.warn({ err: error }, "Could not halt companion after player death");
    });
    this.say("Ich bin gestorben. Ich stoppe den laufenden Auftrag und setze ihn nach dem Respawn nicht ohne deine Bestätigung fort.");
  }

  private onRespawn(): void {
    if (this.stopped) return;
    const generation = ++this.workflowGeneration;
    void this.inspectRespawn(generation).catch((error: unknown) => {
      this.options.logger.error({ err: error }, "Respawn inventory check failed");
      this.say("Respawn erkannt, aber ich konnte Inventar und Ausrüstung nicht sicher prüfen. Ich setze keinen Auftrag fort.");
    });
  }

  private async inspectRespawn(generation: number): Promise<void> {
    const started = Date.now();
    let state: MinecraftObservation | null = null;
    while (!this.stopped && generation === this.workflowGeneration && Date.now() - started < RESPAWN_OBSERVE_TIMEOUT_MS) {
      try {
        const world = await this.options.runtime.observe();
        if (this.stopped || generation !== this.workflowGeneration) return;
        if (world.state.player.alive !== false) {
          state = world.state;
          break;
        }
      } catch (error) {
        this.options.logger.debug({ err: error }, "Waiting for a fresh post-respawn observation");
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (this.stopped || generation !== this.workflowGeneration) return;
    if (!state) {
      this.say("Respawn erkannt, aber ein lebender Spielzustand wurde nicht bestätigt; ich bleibe gestoppt.");
      return;
    }
    await this.options.companion.setMode("hold");
    if (this.stopped || generation !== this.workflowGeneration) return;
    if (!await this.waitForTaskIdle(generation)) {
      if (generation === this.workflowGeneration) this.say("Der vorherige Task-Scheduler-Lauf ist noch nicht sicher beendet. Ich starte weder Ausrüstung noch den letzten Auftrag; bitte prüfe den Status.");
      return;
    }
    const recovered = await this.recoverNearbyDeathDrops(state, generation);
    if (this.stopped || generation !== this.workflowGeneration) return;
    let refreshed = this.options.runtime.currentWorldState?.state ?? state;
    const equipped = await this.equipCarriedGear(refreshed, generation);
    if (this.stopped || generation !== this.workflowGeneration) return;
    const meals = await this.eatCarriedFood(refreshed, generation);
    if (this.stopped || generation !== this.workflowGeneration) return;
    try {
      const world = await this.options.runtime.observe();
      if (this.stopped || generation !== this.workflowGeneration) return;
      refreshed = world.state;
    } catch (error) {
      this.options.logger.warn({ err: error }, "Could not refresh inventory after respawn equipment recovery");
    }
    const crafted = await this.rebuildBasicTools(refreshed, generation);
    if (this.stopped || generation !== this.workflowGeneration) return;
    try {
      const world = await this.options.runtime.observe();
      if (this.stopped || generation !== this.workflowGeneration) return;
      refreshed = world.state;
    } catch (error) {
      this.options.logger.warn({ err: error }, "Could not refresh inventory after respawn crafting");
    }
    const missing = this.missingBasicGear(refreshed);
    const task = this.interruptedTask;
    const recovery = [
      recovered ? `${recovered} sichtbare Gegenstände am Todesort geborgen` : "",
      equipped ? `${equipped} Ausrüstungsteil(e) angelegt` : "",
      meals ? `${meals} Portion(en) gegessen` : "",
      crafted ? `${crafted} Grundwerkzeug(e) hergestellt` : "",
    ].filter(Boolean).join("; ");
    const recoveryText = recovery ? `; ${recovery}` : "";
    if (task) {
      const order = this.interruptedOrder;
      this.pendingResume = { task, order, expiresAt: Date.now() + (this.options.confirmationTimeoutMs ?? 120_000) };
      this.scheduleQuestionTimeout();
      this.say(`Respawn geprüft. ${inventoryAndGearSummary(refreshed)}${recoveryText}.${missing.length ? ` Es fehlt: ${missing.join(", ")}.` : ""} Soll ich den letzten Auftrag (${taskName(task)}) fortsetzen? Ja/Nein.`);
      return;
    }
    this.say(`Respawn geprüft. ${inventoryAndGearSummary(refreshed)}${recoveryText}.${missing.length ? ` Es fehlt: ${missing.join(", ")}.` : ""} Kein Auftrag wartet auf Bestätigung; ich folge dir wieder.`);
    await this.resumeFollowing();
  }

  private async waitForTaskIdle(generation: number): Promise<boolean> {
    const deadline = Date.now() + RESPAWN_OBSERVE_TIMEOUT_MS;
    while (!this.stopped && generation === this.workflowGeneration && this.options.taskRunning() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return !this.stopped && generation === this.workflowGeneration && !this.options.taskRunning();
  }

  private async recoverNearbyDeathDrops(state: MinecraftObservation, generation: number): Promise<number> {
    const death = this.deathPosition;
    this.deathPosition = null;
    if (!death) return 0;
    const candidates = state.itemDrops
      .filter((drop) => (minecraftPickupNames as readonly string[]).includes(drop.name))
      .filter((drop) => distance(drop.position, death) <= 6)
      .filter((drop) => drop.distance <= 24)
      .sort((left, right) => left.distance - right.distance)
      .slice(0, 8);
    let recovered = 0;
    for (const drop of candidates) {
      if (this.stopped || generation !== this.workflowGeneration) break;
      if (this.options.taskRunning()) break;
      try {
        const result = await this.options.skills.run("minecraft.pickup-item", {
          x: Math.floor(drop.position.x),
          y: Math.floor(drop.position.y),
          z: Math.floor(drop.position.z),
          itemName: drop.name,
          dangerRadius: 6,
        }, { source: "respawn:recover-visible-death-drop", timeoutMs: 30_000 });
        if (result.action.status === "succeeded" && result.action.confirmed) recovered += 1;
      } catch (error) {
        this.options.logger.warn({ err: error, itemName: drop.name }, "Could not safely recover one observed death drop");
      }
    }
    return recovered;
  }
}
