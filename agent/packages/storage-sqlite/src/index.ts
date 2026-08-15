import type { Action, Event, Run, Session, ToolResult } from "@p4home/core";

export interface AuditStore {
  saveSession(session: Session): Promise<void>;
  saveRun(run: Run): Promise<void>;
  saveAction(action: Action): Promise<void>;
  saveToolResult(runId: string, result: ToolResult): Promise<void>;
  appendEvent(event: Event): Promise<void>;
}
