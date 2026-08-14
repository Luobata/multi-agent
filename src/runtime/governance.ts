export type SideEffectDecision = "allowed" | "denied" | "approval-required";

export interface SideEffectIntent {
  kind: "provider-call" | "tool-call" | "filesystem-write" | "external-write";
  capability: string;
  principal: string;
  runId: string;
  nodeId?: string;
  providerId?: string;
  metadata?: Record<string, unknown>;
}

export interface SideEffectAuthorization {
  decision: SideEffectDecision;
  reason?: string;
  /** Present when a legacy permission was accepted during a compatibility window. */
  compatibilityWarning?: string;
}

export interface CapabilityBroker {
  authorize(intent: SideEffectIntent): Promise<SideEffectAuthorization> | SideEffectAuthorization;
}

export class SideEffectAuthorizationError extends Error {
  constructor(
    readonly decision: Exclude<SideEffectDecision, "allowed">,
    readonly intent: SideEffectIntent,
    message?: string
  ) {
    super(message ?? `side effect ${intent.capability} is ${decision}`);
    this.name = "SideEffectAuthorizationError";
  }
}

/** The authorization control plane failed, as distinct from an explicit deny decision. */
export class CapabilityBrokerUnavailableError extends Error {
  constructor(readonly intent: SideEffectIntent, cause: unknown) {
    super(`capability broker unavailable: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "CapabilityBrokerUnavailableError";
  }
}

export interface ExecutionBudgetLimits {
  wallClockMs?: number;
  providerCalls?: number;
  attempts?: number;
  gates?: number;
  delegations?: number;
  tokens?: number;
  cost?: number;
  toolCalls?: number;
  depth?: number;
}

export type ExecutionBudgetCounter = Exclude<keyof ExecutionBudgetLimits, "wallClockMs">;

export interface ExecutionBudgetSnapshot {
  startedAt: string;
  elapsedMs: number;
  limits: ExecutionBudgetLimits;
  used: Partial<Record<ExecutionBudgetCounter, number>>;
  reserved: Partial<Record<ExecutionBudgetCounter, number>>;
}

export class ExecutionBudgetExceededError extends Error {
  constructor(readonly counter: keyof ExecutionBudgetLimits, readonly limit: number) {
    super(`execution budget ${counter} exhausted (limit ${limit})`);
    this.name = "ExecutionBudgetExceededError";
  }
}

/** Mutable per-Run ledger. Persist snapshot() with the Run and restore it on recovery. */
export class ExecutionBudget {
  private readonly startedAtMs: number;
  private readonly used: Partial<Record<ExecutionBudgetCounter, number>>;
  private readonly reserved: Partial<Record<ExecutionBudgetCounter, number>>;

  constructor(
    readonly limits: ExecutionBudgetLimits,
    snapshot?: ExecutionBudgetSnapshot,
    private readonly clock: () => number = Date.now
  ) {
    this.startedAtMs = snapshot ? this.clock() - snapshot.elapsedMs : this.clock();
    this.used = { ...(snapshot?.used ?? {}) };
    this.reserved = { ...(snapshot?.reserved ?? {}) };
  }

  assertWallClock(): void {
    if (this.limits.wallClockMs !== undefined && this.elapsedMs() >= this.limits.wallClockMs) {
      throw new ExecutionBudgetExceededError("wallClockMs", this.limits.wallClockMs);
    }
  }

  reserve(counter: ExecutionBudgetCounter, amount = 1): { commit: () => void; release: () => void } {
    this.assertWallClock();
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("budget reservation amount must be positive");
    const limit = this.limits[counter];
    const used = this.used[counter] ?? 0;
    const reserved = this.reserved[counter] ?? 0;
    if (limit !== undefined && used + reserved + amount > limit) {
      throw new ExecutionBudgetExceededError(counter, limit);
    }
    this.reserved[counter] = reserved + amount;
    let settled = false;
    const settle = (commit: boolean) => {
      if (settled) return;
      settled = true;
      this.reserved[counter] = Math.max(0, (this.reserved[counter] ?? 0) - amount);
      if (commit) this.used[counter] = (this.used[counter] ?? 0) + amount;
    };
    return { commit: () => settle(true), release: () => settle(false) };
  }

  snapshot(): ExecutionBudgetSnapshot {
    return {
      startedAt: new Date(this.startedAtMs).toISOString(),
      elapsedMs: this.elapsedMs(),
      limits: { ...this.limits },
      used: { ...this.used },
      reserved: { ...this.reserved }
    };
  }

  private elapsedMs(): number {
    return Math.max(0, this.clock() - this.startedAtMs);
  }
}

export interface Checkpoint<T> {
  revision: number;
  owner: string;
  fencingToken: number;
  leaseExpiresAt: string;
  value: T;
}

/** In-memory CAS primitive; stores can implement the same contract atomically on durable media. */
export class CheckpointCell<T> {
  private current?: Checkpoint<T>;
  private nextFencingToken = 1;

  read(): Checkpoint<T> | undefined {
    return this.current ? structuredClone(this.current) : undefined;
  }

  acquire(owner: string, leaseMs: number, value: T, expectedRevision = this.current?.revision ?? 0): Checkpoint<T> {
    const now = Date.now();
    if (this.current && Date.parse(this.current.leaseExpiresAt) > now && this.current.owner !== owner) {
      throw new Error(`checkpoint lease is held by ${this.current.owner}`);
    }
    if ((this.current?.revision ?? 0) !== expectedRevision) throw new Error("checkpoint revision conflict");
    this.current = {
      revision: expectedRevision + 1,
      owner,
      fencingToken: this.nextFencingToken++,
      leaseExpiresAt: new Date(now + leaseMs).toISOString(),
      value: structuredClone(value)
    };
    return this.read()!;
  }

  compareAndSwap(owner: string, fencingToken: number, expectedRevision: number, value: T, leaseMs: number): Checkpoint<T> {
    if (!this.current || this.current.owner !== owner || this.current.fencingToken !== fencingToken) {
      throw new Error("checkpoint fencing token is stale");
    }
    if (this.current.revision !== expectedRevision) throw new Error("checkpoint revision conflict");
    return this.acquire(owner, leaseMs, value, expectedRevision);
  }
}
