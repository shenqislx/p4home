import { createHash } from "node:crypto";

import type { AuditStore } from "@p4home/storage-sqlite";

import { getRoleProfile } from "./role-profiles.ts";

export interface CatAuditSessionIdentity {
  readonly session_id: string;
  readonly agent_profile_id: string;
  readonly migration: {
    readonly from_session_id: string;
    readonly from_agent_profile_id: string;
    readonly to_session_id: string;
    readonly to_agent_profile_id: string;
    readonly role_profile_revision: string;
  } | null;
}

export async function prepareCatAuditSession(
  store: AuditStore,
  runtimeSessionId: string,
  createdAtMs: number,
  updatedAtMs: number,
): Promise<CatAuditSessionIdentity> {
  const profile = getRoleProfile("cat");
  const profileId = `${profile.revision}:cat`;
  const storedProfile = await store.getSessionAgentProfile(runtimeSessionId);
  let auditSessionId = runtimeSessionId;
  let migration: CatAuditSessionIdentity["migration"] = null;
  if (storedProfile !== null && storedProfile.agent_profile_id !== profileId) {
    const suffix = createHash("sha256")
      .update(`${runtimeSessionId}\0${profileId}`)
      .digest("hex")
      .slice(0, 16);
    auditSessionId = `cat-session:${profile.revision.replace("/", "-")}:${suffix}`;
    migration = {
      from_session_id: runtimeSessionId,
      from_agent_profile_id: storedProfile.agent_profile_id,
      to_session_id: auditSessionId,
      to_agent_profile_id: profileId,
      role_profile_revision: profile.revision,
    };
  }
  await store.saveAgentProfile({
    agent_profile_id: profileId,
    name: "P4 Home cat",
    locale: "zh-CN",
    allowed_tools: profile.allowed_tools,
  });
  await store.saveSession({
    session_id: auditSessionId,
    agent_profile_id: profileId,
    created_at_ms: createdAtMs,
    updated_at_ms: updatedAtMs,
  });
  return {
    session_id: auditSessionId,
    agent_profile_id: profileId,
    migration,
  };
}
