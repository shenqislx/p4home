import { DatabaseSync } from "node:sqlite";

import type {
  Action,
  AgentProfile,
  Event,
  Message,
  Run,
  Session,
  ToolCall,
  ToolError,
  ToolResult,
} from "@p4home/core";

import type {
  AuditStore,
  AuditWriteBatch,
  RunAuditTrace,
  StoredToolCall,
} from "./types.ts";

const SCHEMA_VERSION = 1;

export interface SqliteAuditStoreOptions {
  readonly timeout_ms?: number;
}

export class AuditStorageError extends Error {
  public constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "AuditStorageError";
  }
}

function json(value: unknown, label: string): string {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new TypeError("value is not JSON serializable");
    }
    return encoded;
  } catch (error) {
    throw new AuditStorageError(`${label} is not JSON serializable`, { cause: error });
  }
}

function parseJson<T>(value: unknown, label: string): T {
  if (typeof value !== "string") {
    throw new AuditStorageError(`${label} is not stored as JSON text`);
  }
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new AuditStorageError(`${label} contains invalid JSON`, { cause: error });
  }
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new AuditStorageError(`${label} is not text`);
  }
  return value;
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new AuditStorageError(`${label} is not a safe integer`);
  }
  return value;
}

function nullableNumber(value: unknown, label: string): number | null {
  return value === null ? null : numberValue(value, label);
}

function allowedTools(value: unknown, label: string): readonly string[] {
  if (
    !Array.isArray(value)
    || value.some((item) => typeof item !== "string" || item.length === 0)
    || new Set(value).size !== value.length
  ) {
    throw new AuditStorageError(`${label} must be an array of unique non-empty strings`);
  }
  return value;
}

function messageFromRow(row: Record<string, unknown>): Message {
  const toolName = row.tool_name;
  if (toolName !== null && typeof toolName !== "string") {
    throw new AuditStorageError("messages.tool_name is invalid");
  }
  return {
    message_id: stringValue(row.message_id, "messages.message_id"),
    session_id: stringValue(row.session_id, "messages.session_id"),
    run_id: stringValue(row.run_id, "messages.run_id"),
    role: stringValue(row.role, "messages.role") as Message["role"],
    content: stringValue(row.content, "messages.content"),
    tool_name: toolName,
    created_at_ms: numberValue(row.created_at_ms, "messages.created_at_ms"),
    metadata: parseJson<Record<string, unknown>>(row.metadata_json, "messages.metadata_json"),
  };
}

function actionFromRow(row: Record<string, unknown>): Action {
  return {
    action_id: stringValue(row.action_id, "actions.action_id"),
    run_id: stringValue(row.run_id, "actions.run_id"),
    tool_call_id: stringValue(row.tool_call_id, "actions.tool_call_id"),
    status: stringValue(row.status, "actions.status") as Action["status"],
    created_at_ms: numberValue(row.created_at_ms, "actions.created_at_ms"),
  };
}

function eventFromRow(row: Record<string, unknown>): Event {
  return {
    event_id: stringValue(row.event_id, "events.event_id"),
    run_id: stringValue(row.run_id, "events.run_id"),
    type: stringValue(row.type, "events.type"),
    occurred_at_ms: numberValue(row.occurred_at_ms, "events.occurred_at_ms"),
    payload: parseJson<Record<string, unknown>>(row.payload_json, "events.payload_json"),
  };
}

function toolCallFromRow(row: Record<string, unknown>): StoredToolCall {
  const result = row.result_json === null
    ? null
    : parseJson<Record<string, unknown>>(row.result_json, "tool_calls.result_json");
  const error = row.error_json === null
    ? null
    : parseJson<ToolError>(row.error_json, "tool_calls.error_json");
  return {
    tool_call_id: stringValue(row.tool_call_id, "tool_calls.tool_call_id"),
    run_id: stringValue(row.run_id, "tool_calls.run_id"),
    name: stringValue(row.name, "tool_calls.name"),
    arguments: parseJson<Record<string, unknown>>(
      row.arguments_json,
      "tool_calls.arguments_json",
    ),
    status: stringValue(row.status, "tool_calls.status") as StoredToolCall["status"],
    created_at_ms: numberValue(row.created_at_ms, "tool_calls.created_at_ms"),
    completed_at_ms: nullableNumber(row.completed_at_ms, "tool_calls.completed_at_ms"),
    result,
    error,
  };
}

export class SqliteAuditStore implements AuditStore, Disposable {
  readonly #database: DatabaseSync;
  #closed = false;

  public constructor(path: string, options: SqliteAuditStoreOptions = {}) {
    const timeoutMs = options.timeout_ms ?? 5_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 120_000) {
      throw new RangeError("timeout_ms must be an integer between 0 and 120000");
    }
    this.#database = new DatabaseSync(path, {
      timeout: timeoutMs,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
      defensive: true,
    });
    try {
      this.#database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
      this.#migrate();
    } catch (error) {
      this.#database.close();
      this.#closed = true;
      throw error;
    }
  }

  public async saveAgentProfile(profile: AgentProfile): Promise<void> {
    this.#assertOpen();
    const profileAllowedTools = allowedTools(profile.allowed_tools, "allowed_tools");
    this.#database.prepare(`
      INSERT INTO agent_profiles (agent_profile_id, name, locale, allowed_tools_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(agent_profile_id) DO UPDATE SET
        name = excluded.name,
        locale = excluded.locale,
        allowed_tools_json = excluded.allowed_tools_json
    `).run(
      profile.agent_profile_id,
      profile.name,
      profile.locale,
      json(profileAllowedTools, "allowed_tools"),
    );
  }

  public async saveSession(session: Session): Promise<void> {
    this.#assertOpen();
    const write = this.#database.prepare(`
      INSERT INTO sessions (
        session_id, agent_profile_id, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        updated_at_ms = excluded.updated_at_ms
      WHERE sessions.agent_profile_id = excluded.agent_profile_id
        AND sessions.created_at_ms = excluded.created_at_ms
        AND excluded.updated_at_ms >= sessions.updated_at_ms
    `).run(
      session.session_id,
      session.agent_profile_id,
      session.created_at_ms,
      session.updated_at_ms,
    );
    if (Number(write.changes) !== 1) {
      throw new AuditStorageError(`session ${session.session_id} conflicts with stored identity or time`);
    }
  }

  public async saveRun(run: Run): Promise<void> {
    this.#assertOpen();
    this.#transaction(() => this.#writeRun(run));
  }

  public async saveMessage(message: Message): Promise<void> {
    this.#assertOpen();
    this.#transaction(() => this.#writeMessage(message));
  }

  public async saveToolCall(runId: string, call: ToolCall, createdAtMs: number): Promise<void> {
    this.#assertOpen();
    this.#transaction(() => this.#writeToolCall(runId, call, createdAtMs));
  }

  public async saveAction(action: Action): Promise<void> {
    this.#assertOpen();
    this.#transaction(() => this.#writeAction(action));
  }

  public async saveToolResult(
    runId: string,
    result: ToolResult,
    completedAtMs: number,
  ): Promise<void> {
    this.#assertOpen();
    this.#transaction(() => this.#writeToolResult(runId, result, completedAtMs));
  }

  public async appendEvent(event: Event): Promise<void> {
    this.#assertOpen();
    this.#transaction(() => this.#writeEvent(event));
  }

  public async writeBatch(batch: AuditWriteBatch): Promise<void> {
    this.#assertOpen();
    this.#transaction(() => {
      const terminalRun = batch.run !== undefined
        && !["pending", "running"].includes(batch.run.status);
      if (batch.run !== undefined && !terminalRun) {
        this.#writeRun(batch.run);
      }
      for (const message of batch.messages ?? []) {
        this.#writeMessage(message);
      }
      for (const write of batch.tool_calls ?? []) {
        this.#writeToolCall(write.run_id, write.call, write.created_at_ms);
      }
      for (const write of batch.tool_results ?? []) {
        this.#writeToolResult(write.run_id, write.result, write.completed_at_ms);
      }
      for (const action of batch.actions ?? []) {
        this.#writeAction(action);
      }
      for (const event of batch.events ?? []) {
        this.#writeEvent(event);
      }
      if (batch.run !== undefined && terminalRun) {
        this.#writeRun(batch.run);
      }
    });
  }

  public async getSessionAgentProfile(sessionId: string): Promise<AgentProfile | null> {
    this.#assertOpen();
    const row = this.#database.prepare(`
      SELECT p.agent_profile_id, p.name, p.locale, p.allowed_tools_json
      FROM sessions AS s
      JOIN agent_profiles AS p ON p.agent_profile_id = s.agent_profile_id
      WHERE s.session_id = ?
    `).get(sessionId);
    if (row === undefined) {
      return null;
    }
    return {
      agent_profile_id: stringValue(row.agent_profile_id, "agent_profiles.agent_profile_id"),
      name: stringValue(row.name, "agent_profiles.name"),
      locale: stringValue(row.locale, "agent_profiles.locale") as AgentProfile["locale"],
      allowed_tools: allowedTools(
        parseJson<unknown>(row.allowed_tools_json, "agent_profiles.allowed_tools_json"),
        "agent_profiles.allowed_tools_json",
      ),
    };
  }

  public async getRunTrace(runId: string): Promise<RunAuditTrace | null> {
    this.#assertOpen();
    return this.#readTransaction(() => {
      const runRow = this.#database.prepare(`
        SELECT run_id, session_id, status, started_at_ms, completed_at_ms
        FROM runs WHERE run_id = ?
      `).get(runId);
      if (runRow === undefined) {
        return null;
      }
      const run: Run = {
        run_id: stringValue(runRow.run_id, "runs.run_id"),
        session_id: stringValue(runRow.session_id, "runs.session_id"),
        status: stringValue(runRow.status, "runs.status") as Run["status"],
        started_at_ms: numberValue(runRow.started_at_ms, "runs.started_at_ms"),
        completed_at_ms: nullableNumber(runRow.completed_at_ms, "runs.completed_at_ms"),
      };
      return {
        run,
        messages: this.#database.prepare(`
          SELECT * FROM messages WHERE run_id = ? ORDER BY created_at_ms, message_id
        `).all(runId).map(messageFromRow),
        tool_calls: this.#database.prepare(`
          SELECT * FROM tool_calls WHERE run_id = ? ORDER BY created_at_ms, tool_call_id
        `).all(runId).map(toolCallFromRow),
        actions: this.#database.prepare(`
          SELECT * FROM actions WHERE run_id = ? ORDER BY created_at_ms, action_id
        `).all(runId).map(actionFromRow),
        events: this.#database.prepare(`
          SELECT * FROM events WHERE run_id = ? ORDER BY occurred_at_ms, event_id
        `).all(runId).map(eventFromRow),
      };
    });
  }

  public async listSessionMessages(sessionId: string): Promise<readonly Message[]> {
    this.#assertOpen();
    return this.#database.prepare(`
      SELECT * FROM messages WHERE session_id = ? ORDER BY created_at_ms, message_id
    `).all(sessionId).map(messageFromRow);
  }

  public close(): void {
    if (!this.#closed) {
      this.#database.close();
      this.#closed = true;
    }
  }

  public [Symbol.dispose](): void {
    this.close();
  }

  #writeRun(run: Run): void {
    const write = this.#database.prepare(`
      INSERT INTO runs (
        run_id, session_id, status, started_at_ms, completed_at_ms
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        status = excluded.status,
        completed_at_ms = excluded.completed_at_ms
      WHERE runs.session_id = excluded.session_id
        AND runs.started_at_ms = excluded.started_at_ms
        AND (
          (runs.status = 'pending') OR
          (runs.status = 'running' AND excluded.status != 'pending') OR
          (
            runs.status IN ('completed', 'failed', 'cancelled', 'timed_out')
            AND excluded.status = runs.status
            AND excluded.completed_at_ms IS runs.completed_at_ms
          )
        )
    `).run(
      run.run_id,
      run.session_id,
      run.status,
      run.started_at_ms,
      run.completed_at_ms,
    );
    if (Number(write.changes) !== 1) {
      throw new AuditStorageError(`run ${run.run_id} conflicts with stored identity or lifecycle`);
    }
    if (!["pending", "running"].includes(run.status)) {
      const unfinished = this.#database.prepare(`
        SELECT
          EXISTS(
            SELECT 1 FROM tool_calls
            WHERE run_id = ? AND status = 'pending'
          ) AS pending_tool_calls,
          EXISTS(
            SELECT 1 FROM actions
            WHERE run_id = ? AND status NOT IN ('completed', 'failed')
          ) AS pending_actions
      `).get(run.run_id, run.run_id);
      if (
        numberValue(unfinished?.pending_tool_calls, "pending_tool_calls") !== 0
        || numberValue(unfinished?.pending_actions, "pending_actions") !== 0
      ) {
        throw new AuditStorageError(`run ${run.run_id} cannot terminate with unfinished work`);
      }
    }
  }

  #writeMessage(message: Message): void {
    this.#assertRunWritable(message.run_id);
    this.#database.prepare(`
      INSERT INTO messages (
        message_id, session_id, run_id, role, content, tool_name, created_at_ms, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.message_id,
      message.session_id,
      message.run_id,
      message.role,
      message.content,
      message.tool_name,
      message.created_at_ms,
      json(message.metadata, "message.metadata"),
    );
  }

  #writeToolCall(runId: string, call: ToolCall, createdAtMs: number): void {
    this.#assertRunWritable(runId);
    this.#database.prepare(`
      INSERT INTO tool_calls (
        tool_call_id, run_id, name, arguments_json, status, created_at_ms
      ) VALUES (?, ?, ?, ?, 'pending', ?)
    `).run(
      call.tool_call_id,
      runId,
      call.name,
      json(call.arguments, "tool_call.arguments"),
      createdAtMs,
    );
  }

  #writeAction(action: Action): void {
    this.#assertRunWritable(action.run_id);
    const write = this.#database.prepare(`
      INSERT INTO actions (action_id, run_id, tool_call_id, status, created_at_ms)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(action_id) DO UPDATE SET status = excluded.status
      WHERE actions.run_id = excluded.run_id
        AND actions.tool_call_id = excluded.tool_call_id
        AND actions.created_at_ms = excluded.created_at_ms
        AND (
          (actions.status = 'requested') OR
          (actions.status = 'accepted' AND excluded.status IN ('accepted', 'started', 'completed', 'failed')) OR
          (actions.status = 'started' AND excluded.status IN ('started', 'completed', 'failed')) OR
          (actions.status IN ('completed', 'failed') AND excluded.status = actions.status)
        )
    `).run(
      action.action_id,
      action.run_id,
      action.tool_call_id,
      action.status,
      action.created_at_ms,
    );
    if (Number(write.changes) !== 1) {
      throw new AuditStorageError(
        `action ${action.action_id} conflicts with stored identity or lifecycle`,
      );
    }
  }

  #writeToolResult(runId: string, result: ToolResult, completedAtMs: number): void {
    const update = this.#database.prepare(`
      UPDATE tool_calls SET
        status = ?,
        completed_at_ms = ?,
        result_json = ?,
        error_json = ?
      WHERE tool_call_id = ? AND run_id = ? AND name = ? AND status = 'pending'
    `).run(
      result.status,
      completedAtMs,
      result.result === null ? null : json(result.result, "tool_result.result"),
      result.error === null ? null : json(result.error, "tool_result.error"),
      result.tool_call_id,
      runId,
      result.name,
    );
    if (Number(update.changes) !== 1) {
      throw new AuditStorageError(
        `pending tool call not found for result ${result.tool_call_id}`,
      );
    }
  }

  #writeEvent(event: Event): void {
    this.#assertRunWritable(event.run_id);
    this.#database.prepare(`
      INSERT INTO events (event_id, run_id, type, occurred_at_ms, payload_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      event.event_id,
      event.run_id,
      event.type,
      event.occurred_at_ms,
      json(event.payload, "event.payload"),
    );
  }

  #assertRunWritable(runId: string): void {
    const row = this.#database.prepare(`
      SELECT status FROM runs WHERE run_id = ?
    `).get(runId);
    const status = row === undefined ? null : stringValue(row.status, "runs.status");
    if (status !== "pending" && status !== "running") {
      throw new AuditStorageError(`run ${runId} is not writable`);
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new AuditStorageError("audit store is closed");
    }
  }

  #transaction(operation: () => void): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      operation();
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #readTransaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #migrate(): void {
    const versionRow = this.#database.prepare("PRAGMA user_version").get();
    const currentVersion = numberValue(versionRow?.user_version, "PRAGMA user_version");
    if (currentVersion > SCHEMA_VERSION) {
      throw new AuditStorageError(
        `database schema version ${currentVersion} is newer than supported ${SCHEMA_VERSION}`,
      );
    }
    if (currentVersion === SCHEMA_VERSION) {
      return;
    }
    this.#transaction(() => {
      this.#database.exec(`
        CREATE TABLE agent_profiles (
          agent_profile_id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          locale TEXT NOT NULL CHECK (locale = 'zh-CN'),
          allowed_tools_json TEXT NOT NULL CHECK (json_valid(allowed_tools_json))
        ) STRICT;

        CREATE TABLE sessions (
          session_id TEXT PRIMARY KEY,
          agent_profile_id TEXT NOT NULL REFERENCES agent_profiles(agent_profile_id),
          created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
          updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
        ) STRICT;

        CREATE TABLE runs (
          run_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(session_id),
          status TEXT NOT NULL CHECK (
            status IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'timed_out')
          ),
          started_at_ms INTEGER NOT NULL CHECK (started_at_ms >= 0),
          completed_at_ms INTEGER CHECK (
            completed_at_ms IS NULL OR completed_at_ms >= started_at_ms
          ),
          CHECK (
            (status IN ('pending', 'running') AND completed_at_ms IS NULL) OR
            (status IN ('completed', 'failed', 'cancelled', 'timed_out') AND completed_at_ms IS NOT NULL)
          ),
          UNIQUE (run_id, session_id)
        ) STRICT;

        CREATE TABLE messages (
          message_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
          content TEXT NOT NULL,
          tool_name TEXT,
          created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
          metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
          CHECK (
            (role = 'tool' AND tool_name IS NOT NULL) OR
            (role != 'tool' AND tool_name IS NULL)
          ),
          FOREIGN KEY (run_id, session_id) REFERENCES runs(run_id, session_id)
        ) STRICT;

        CREATE TABLE tool_calls (
          tool_call_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(run_id),
          name TEXT NOT NULL,
          arguments_json TEXT NOT NULL CHECK (json_valid(arguments_json)),
          status TEXT NOT NULL CHECK (status IN ('pending', 'success', 'error')),
          created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
          completed_at_ms INTEGER,
          result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
          error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
          CHECK (
            (status = 'pending' AND completed_at_ms IS NULL AND result_json IS NULL AND error_json IS NULL) OR
            (status = 'success' AND completed_at_ms IS NOT NULL AND result_json IS NOT NULL AND error_json IS NULL) OR
            (status = 'error' AND completed_at_ms IS NOT NULL AND result_json IS NULL AND error_json IS NOT NULL)
          ),
          CHECK (completed_at_ms IS NULL OR completed_at_ms >= created_at_ms),
          UNIQUE (tool_call_id, run_id)
        ) STRICT;

        CREATE TABLE actions (
          action_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(run_id),
          tool_call_id TEXT NOT NULL REFERENCES tool_calls(tool_call_id),
          status TEXT NOT NULL CHECK (
            status IN ('requested', 'accepted', 'started', 'completed', 'failed')
          ),
          created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
          FOREIGN KEY (tool_call_id, run_id) REFERENCES tool_calls(tool_call_id, run_id)
        ) STRICT;

        CREATE TABLE events (
          event_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(run_id),
          type TEXT NOT NULL,
          occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
          payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
        ) STRICT;

        CREATE INDEX messages_session_time_idx
          ON messages(session_id, created_at_ms, message_id);
        CREATE INDEX messages_run_time_idx
          ON messages(run_id, created_at_ms, message_id);
        CREATE INDEX tool_calls_run_time_idx
          ON tool_calls(run_id, created_at_ms, tool_call_id);
        CREATE INDEX actions_run_time_idx
          ON actions(run_id, created_at_ms, action_id);
        CREATE INDEX events_run_time_idx
          ON events(run_id, occurred_at_ms, event_id);
      `);
      this.#database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  }
}
