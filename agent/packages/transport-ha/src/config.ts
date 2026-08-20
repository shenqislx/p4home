import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

import {
  HaRuntimeContractError,
  validateRobotHaPolicy,
  type RobotHaPolicy,
} from "@p4home/contracts";

const TOKEN_FILE_MAX_BYTES = 4_096;
const POLICY_FILE_MAX_BYTES = 65_536;

export type RobotHaConfigErrorCode =
  | "INVALID_URL"
  | "INSECURE_TRANSPORT"
  | "TOKEN_FILE_INVALID"
  | "POLICY_FILE_INVALID";

export class RobotHaConfigError extends Error {
  public readonly code: RobotHaConfigErrorCode;

  public constructor(code: RobotHaConfigErrorCode, message: string) {
    super(message);
    this.name = "RobotHaConfigError";
    this.code = code;
  }
}

export interface LoadRobotHaRuntimeConfigOptions {
  readonly url: string;
  readonly token_file: string;
  readonly policy_file: string;
  readonly allow_insecure_ws?: boolean;
}

export interface RobotHaRuntimeConfig {
  readonly websocket_url: string;
  readonly rest_base_url: string;
  readonly access_token: string;
  readonly policy: RobotHaPolicy;
  readonly transport_security: "tls" | "explicit_insecure_ws";
}

async function readBoundedFile(
  path: string,
  maxBytes: number,
  privateFile: boolean,
  code: Extract<RobotHaConfigErrorCode, "TOKEN_FILE_INVALID" | "POLICY_FILE_INVALID">,
): Promise<string> {
  if (!isAbsolute(path)) {
    throw new RobotHaConfigError(code, "credential and policy paths must be absolute");
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new RobotHaConfigError(code, "file cannot be opened safely");
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size < 1 || stats.size > maxBytes) {
      throw new RobotHaConfigError(code, "file type or size is invalid");
    }
    if (privateFile) {
      const getuid = process.getuid;
      if ((stats.mode & 0o077) !== 0 || (getuid !== undefined && stats.uid !== getuid())) {
        throw new RobotHaConfigError(code, "token file must be owned by the current user with mode 0600 or stricter");
      }
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function normalizeUrls(
  input: string,
  allowInsecureWs: boolean,
): Pick<RobotHaRuntimeConfig, "websocket_url" | "rest_base_url" | "transport_security"> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new RobotHaConfigError("INVALID_URL", "Home Assistant URL is invalid");
  }
  if (
    url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
    || (url.pathname !== "/" && url.pathname !== "" && url.pathname !== "/api/websocket")
  ) {
    throw new RobotHaConfigError("INVALID_URL", "Home Assistant URL must not contain credentials, query, fragment, or a custom path");
  }
  const inputProtocol = url.protocol;
  if (!["http:", "https:", "ws:", "wss:"].includes(inputProtocol)) {
    throw new RobotHaConfigError("INVALID_URL", "Home Assistant URL must use http, https, ws, or wss");
  }
  const insecure = inputProtocol === "http:" || inputProtocol === "ws:";
  if (insecure && !allowInsecureWs) {
    throw new RobotHaConfigError(
      "INSECURE_TRANSPORT",
      "plain LAN Home Assistant transport requires explicit allow_insecure_ws",
    );
  }
  const websocket = new URL(url);
  websocket.protocol = insecure ? "ws:" : "wss:";
  websocket.pathname = "/api/websocket";
  const rest = new URL(url);
  rest.protocol = insecure ? "http:" : "https:";
  rest.pathname = "/api/states";
  return {
    websocket_url: websocket.toString(),
    rest_base_url: rest.toString().replace(/\/$/, ""),
    transport_security: insecure ? "explicit_insecure_ws" : "tls",
  };
}

export function assertRobotHaRuntimeConfigBoundary(config: RobotHaRuntimeConfig): void {
  let websocket: URL;
  let rest: URL;
  try {
    websocket = new URL(config.websocket_url);
    rest = new URL(config.rest_base_url);
  } catch {
    throw new RobotHaConfigError("INVALID_URL", "Home Assistant runtime URL is invalid");
  }
  if (
    websocket.username !== ""
    || websocket.password !== ""
    || websocket.search !== ""
    || websocket.hash !== ""
    || websocket.pathname !== "/api/websocket"
    || rest.username !== ""
    || rest.password !== ""
    || rest.search !== ""
    || rest.hash !== ""
    || rest.pathname !== "/api/states"
    || websocket.host !== rest.host
  ) {
    throw new RobotHaConfigError(
      "INVALID_URL",
      "Home Assistant runtime URLs must be credential-free, canonical, and use one host",
    );
  }
  const secure = websocket.protocol === "wss:" && rest.protocol === "https:";
  const explicitInsecure = websocket.protocol === "ws:" && rest.protocol === "http:";
  if (
    !["tls", "explicit_insecure_ws"].includes(config.transport_security)
    || (config.transport_security === "tls" && !secure)
    || (config.transport_security === "explicit_insecure_ws" && !explicitInsecure)
  ) {
    throw new RobotHaConfigError(
      "INSECURE_TRANSPORT",
      "Home Assistant runtime transport does not match its declared security mode",
    );
  }
  if (
    config.access_token.length < 32
    || config.access_token.length > TOKEN_FILE_MAX_BYTES
    || /\s/.test(config.access_token)
  ) {
    throw new RobotHaConfigError("TOKEN_FILE_INVALID", "token content is invalid");
  }
}

export async function loadRobotHaRuntimeConfig(
  options: LoadRobotHaRuntimeConfigOptions,
): Promise<RobotHaRuntimeConfig> {
  const urls = normalizeUrls(options.url, options.allow_insecure_ws === true);
  const tokenText = await readBoundedFile(
    options.token_file,
    TOKEN_FILE_MAX_BYTES,
    true,
    "TOKEN_FILE_INVALID",
  );
  const accessToken = tokenText.trim();
  if (
    accessToken.length < 32
    || accessToken.length > TOKEN_FILE_MAX_BYTES
    || /\s/.test(accessToken)
  ) {
    throw new RobotHaConfigError("TOKEN_FILE_INVALID", "token content is invalid");
  }
  const policyText = await readBoundedFile(
    options.policy_file,
    POLICY_FILE_MAX_BYTES,
    false,
    "POLICY_FILE_INVALID",
  );
  let policyInput: unknown;
  try {
    policyInput = JSON.parse(policyText) as unknown;
  } catch {
    throw new RobotHaConfigError("POLICY_FILE_INVALID", "policy JSON is invalid");
  }
  let policy: RobotHaPolicy;
  try {
    policy = validateRobotHaPolicy(policyInput);
  } catch (error) {
    if (error instanceof HaRuntimeContractError) {
      throw new RobotHaConfigError("POLICY_FILE_INVALID", error.message);
    }
    throw error;
  }
  return {
    ...urls,
    access_token: accessToken,
    policy,
  };
}
