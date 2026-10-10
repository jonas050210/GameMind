// Types for the browser policy module, so the TypeScript tests can import it. The browser loads policy.js directly.
export declare const HEADLESS_STORAGE_KEY: string;
export declare function parseHeadless(stored: unknown): boolean;
export declare function isTrainingActive(training: unknown): boolean;
export declare function renderingSuspended(snapshot: unknown, headless: boolean): boolean;
export declare const ROADMAP_CATEGORY_ORDER: readonly string[];
export declare const ROADMAP_KIND_LABELS: Readonly<Record<string, string>>;
export declare const ROADMAP_STATUS_LABELS: Readonly<Record<string, string>>;
export declare function isClosed(item: { status: string }): boolean;
export declare function filterRoadmap<T extends { status: string; kind?: string; category?: string }>(
  items: readonly T[],
  options?: { category?: string; kind?: string; showClosed?: boolean },
): T[];
export declare function groupByCategory<T extends { category: string }>(items: readonly T[]): Array<[string, T[]]>;
export declare function roadmapActionsFor(item: { status: string }): string[];
export declare const ROADMAP_ACTION_LABELS: Readonly<Record<string, string>>;
export declare const ROADMAP_ACTIONS_WITH_NOTE: ReadonlySet<string>;
