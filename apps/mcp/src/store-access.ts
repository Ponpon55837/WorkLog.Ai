import { DatabaseInitializationError, type WorkIntelligenceStore } from "@work-intelligence/storage";

export interface McpStartupFailure {
  code: string;
  message: string;
}

export type StoreResolution = { store: WorkIntelligenceStore } | { failure: McpStartupFailure };

export interface McpStoreAccessOptions {
  /** Milliseconds between two open attempts; calls in between answer the last failure without waiting. */
  retryIntervalMs?: number;
  now?: () => number;
  onFailure?: (failure: McpStartupFailure) => void;
}

// Failures the owner can clear without restarting the Agent; every other startup failure stays until restart.
const TRANSIENT_STARTUP_CODES: ReadonlySet<string> = new Set([
  "DATABASE_BUSY",
  "DATABASE_READ_ONLY",
  "DATABASE_DISK_FULL",
]);
const DEFAULT_RETRY_INTERVAL_MS = 1000;
const UNOPENABLE_DATABASE: McpStartupFailure = {
  code: "DATABASE_INITIALIZATION_FAILED",
  message: "Work Intelligence 資料庫無法開啟，請檢查資料庫檔案、目錄與權限。",
};

function classifyStartupFailure(error: unknown): McpStartupFailure {
  return error instanceof DatabaseInitializationError
    ? { code: error.code, message: error.message }
    : UNOPENABLE_DATABASE;
}

export function isTransientStartupFailure(failure: McpStartupFailure): boolean {
  return TRANSIENT_STARTUP_CODES.has(failure.code);
}

/** At most one open attempt per call and per retry interval, so a burst of calls against a locked database does not queue a burst of opens. */
export class McpStoreAccess {
  private store: WorkIntelligenceStore | undefined;
  private failure: McpStartupFailure | undefined;
  private lastAttemptAt = 0;
  private readonly retryIntervalMs: number;
  private readonly now: () => number;

  public constructor(
    private readonly open: () => WorkIntelligenceStore,
    private readonly options: McpStoreAccessOptions = {},
  ) {
    this.retryIntervalMs = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.attempt();
  }

  public get startupFailure(): McpStartupFailure | undefined {
    return this.failure;
  }

  public resolve(): StoreResolution {
    if (this.store) return { store: this.store };
    const failure = this.failure!;
    if (isTransientStartupFailure(failure) && this.now() - this.lastAttemptAt >= this.retryIntervalMs) {
      this.attempt();
    }
    return this.store ? { store: this.store } : { failure: this.failure! };
  }

  public close(): void {
    this.store?.close();
    this.store = undefined;
  }

  private attempt(): void {
    this.lastAttemptAt = this.now();
    try {
      this.store = this.open();
      this.failure = undefined;
    } catch (error) {
      this.failure = classifyStartupFailure(error);
      this.options.onFailure?.(this.failure);
    }
  }
}
