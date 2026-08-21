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
  readonly restored: boolean;
  readonly final_state: RobotHaProjectedState;
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

export async function dispatchCausalWrite(
  client: RobotHaWriteClient,
  alias: string,
  action: RobotHaWriteAction,
  expected: string,
  timeoutMs = 10_000,
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
  settleMs = 500,
): Promise<GateRestoreResult> {
  const action: RobotHaWriteAction = initialState === "on" ? "turn_on" : "turn_off";
  const dispatch = await dispatchCausalWrite(
    client,
    alias,
    action,
    initialState,
    observationTimeoutMs,
  );
  if (settleMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, settleMs));
  }
  const finalState = await client.reconcileState(alias, AbortSignal.timeout(5_000));
  return {
    accepted: dispatch.accepted,
    observed: dispatch.observed,
    restored: dispatch.accepted && finalState.available && finalState.state === initialState,
    final_state: finalState,
  };
}
