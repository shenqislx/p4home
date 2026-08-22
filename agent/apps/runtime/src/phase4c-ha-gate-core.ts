import type {
  RobotHaProjectedState,
  RobotHaStateObservation,
  RobotHaWriteClient,
} from "@p4home/transport-ha";
import type { RobotHaWriteAction } from "@p4home/contracts";

export interface RobotIdentity {
  readonly is_admin: boolean;
  readonly is_owner: boolean;
}

export interface GateDispatchResult {
  readonly accepted: boolean;
  readonly observed: boolean;
}

export interface GateRestoreResult {
  readonly accepted: boolean;
  readonly observed: boolean;
  readonly attempts: number;
  readonly error: "dispatch_unknown" | "reconcile_unknown" | null;
  readonly restored: boolean;
  readonly final_state: RobotHaProjectedState | null;
}

export function parseRobotIdentity(result: unknown): RobotIdentity {
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("identity_protocol");
  }
  const record = result as Record<string, unknown>;
  if (typeof record.is_admin !== "boolean" || typeof record.is_owner !== "boolean") {
    throw new Error("identity_protocol");
  }
  return { is_admin: record.is_admin, is_owner: record.is_owner };
}

export async function waitForStableProjectedState(
  client: Pick<RobotHaWriteClient, "getState" | "onState" | "state">,
  alias: string,
  timeoutMs = 60_000,
  settleMs = 30_000,
): Promise<RobotHaProjectedState | null> {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a positive integer");
  }
  if (!Number.isInteger(settleMs) || settleMs < 0 || settleMs >= timeoutMs) {
    throw new TypeError("settleMs must be a non-negative integer below timeoutMs");
  }

  return await new Promise((resolve) => {
    let settled = false;
    let candidate: RobotHaProjectedState | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;
    let unsubscribePending = false;
    const cleanupSubscription = (): void => {
      if (unsubscribe === null) {
        unsubscribePending = true;
        return;
      }
      const current = unsubscribe;
      unsubscribe = null;
      current();
    };
    const finish = (state: RobotHaProjectedState | null): void => {
      if (settled) return;
      settled = true;
      if (settleTimer !== null) clearTimeout(settleTimer);
      clearTimeout(timeoutTimer);
      cleanupSubscription();
      resolve(state === null ? null : structuredClone(state));
    };
    const invalidate = (): void => {
      candidate = null;
      if (settleTimer !== null) {
        clearTimeout(settleTimer);
        settleTimer = null;
      }
    };
    const verifyCandidate = (): void => {
      if (settled) return;
      let current: RobotHaProjectedState | null;
      try {
        current = client.state === "ready" ? client.getState(alias) : null;
      } catch {
        finish(null);
        return;
      }
      if (
        current === null
        || current.alias !== alias
        || !current.available
        || (current.state !== "on" && current.state !== "off")
      ) {
        invalidate();
        return;
      }
      if (candidate?.state !== current.state || !candidate.available) {
        consider(current);
        return;
      }
      finish(current);
    };
    const consider = (state: RobotHaProjectedState | null): void => {
      if (settled) return;
      if (state === null) {
        invalidate();
        return;
      }
      if (state.alias !== alias) return;
      if (!state.available || (state.state !== "on" && state.state !== "off")) {
        invalidate();
        return;
      }
      const unchanged = candidate?.state === state.state && candidate.available;
      candidate = structuredClone(state);
      if (unchanged && settleTimer !== null) return;
      if (settleTimer !== null) clearTimeout(settleTimer);
      if (settleMs === 0) {
        verifyCandidate();
      } else {
        settleTimer = setTimeout(verifyCandidate, settleMs);
      }
    };
    const timeoutTimer = setTimeout(() => finish(null), timeoutMs);
    try {
      const registered = client.onState((state) => consider(state));
      unsubscribe = registered;
      if (unsubscribePending || settled) {
        cleanupSubscription();
      }
      if (!settled) {
        consider(client.getState(alias));
      }
    } catch {
      finish(null);
    }
  });
}

export async function dispatchCausalWrite(
  client: RobotHaWriteClient,
  alias: string,
  action: RobotHaWriteAction,
  expected: string,
  timeoutMs = 10_000,
  onDispatched?: () => void,
): Promise<GateDispatchResult> {
  let cursor: { readonly connection_generation: number; readonly sequence: number } | null = null;
  const buffered: RobotHaStateObservation[] = [];
  let resolveObserved: ((value: boolean) => void) | null = null;
  const observedPromise = new Promise<boolean>((resolve) => {
    resolveObserved = resolve;
  });
  const acceptObservation = (observation: RobotHaStateObservation): void => {
    if (cursor === null) {
      if (buffered.length < 8) {
        buffered.push(structuredClone(observation));
      }
      return;
    }
    if (
      observation.connection_generation === cursor.connection_generation
      && observation.sequence > cursor.sequence
      && observation.state.alias === alias
      && observation.state.available
      && observation.state.state === expected
    ) {
      resolveObserved?.(true);
    }
  };
  const unsubscribe = client.onObservation(acceptObservation);
  try {
    const attempt = client.beginWrite(alias, action);
    onDispatched?.();
    cursor = structuredClone(attempt.dispatch_cursor);
    for (const observation of buffered) {
      acceptObservation(observation);
    }
    buffered.length = 0;
    const response = await attempt.response;
    const accepted = response.request_id === attempt.request_id && response.accepted;
    if (!accepted) {
      return { accepted: false, observed: false };
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const observed = await Promise.race([
      observedPromise,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    if (timer !== null) {
      clearTimeout(timer);
    }
    return { accepted: true, observed };
  } finally {
    unsubscribe();
  }
}

export async function restoreRobotState(
  client: RobotHaWriteClient,
  alias: string,
  initialState: "on" | "off",
  observationTimeoutMs = 3_000,
  settleMs = 2_000,
): Promise<GateRestoreResult> {
  const action: RobotHaWriteAction = initialState === "on" ? "turn_on" : "turn_off";
  let accepted = false;
  let observed = false;
  let attempts = 0;
  const settle = async (): Promise<void> => {
    if (settleMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, settleMs));
    }
  };
  const dispatchRestore = async (): Promise<GateDispatchResult | null> => {
    try {
      return await dispatchCausalWrite(
        client,
        alias,
        action,
        initialState,
        observationTimeoutMs,
        () => {
          attempts += 1;
        },
      );
    } catch {
      return null;
    }
  };
  const reconcile = async (): Promise<RobotHaProjectedState | null> => {
    try {
      return await client.reconcileState(alias, AbortSignal.timeout(5_000));
    } catch {
      return null;
    }
  };

  const firstDispatch = await dispatchRestore();
  await settle();
  let finalState = await reconcile();
  if (firstDispatch === null) {
    return {
      accepted: false,
      observed: false,
      attempts,
      error: "dispatch_unknown",
      restored: false,
      final_state: finalState,
    };
  }
  accepted = firstDispatch.accepted;
  observed = firstDispatch.observed;
  if (finalState === null) {
    return {
      accepted,
      observed,
      attempts,
      error: "reconcile_unknown",
      restored: false,
      final_state: null,
    };
  }
  if (
    firstDispatch.accepted
    && finalState.available
    && finalState.state !== initialState
  ) {
    const correction = await dispatchRestore();
    await settle();
    finalState = await reconcile();
    if (correction === null) {
      return {
        accepted: false,
        observed,
        attempts,
        error: "dispatch_unknown",
        restored: false,
        final_state: finalState,
      };
    }
    accepted = accepted && correction.accepted;
    observed = observed || correction.observed;
    if (finalState === null) {
      return {
        accepted,
        observed,
        attempts,
        error: "reconcile_unknown",
        restored: false,
        final_state: null,
      };
    }
  }
  return {
    accepted,
    observed,
    attempts,
    error: null,
    restored: accepted && finalState.available && finalState.state === initialState,
    final_state: finalState,
  };
}
