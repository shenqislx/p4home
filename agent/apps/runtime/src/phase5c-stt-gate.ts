import { createHash } from "node:crypto";

export const PHASE5C_TRANSCRIPT_NORMALIZATION = "nfkc-strip-space-punctuation-v1";
export const PHASE5C_EXPECTED_TRANSCRIPT_SHA256 =
  "cd1c667a089b4486c36f7c0d262c663bed74b9cd51462a84a0b698a385eb3621";
export const PHASE5C_MAX_VOICE_ATTEMPTS = 3;

export type Phase5cAttemptDecision = "continue" | "fail" | "pass";

export function phase5cTranscriptSha256(text: string): string {
  const normalized = text.normalize("NFKC")
    .replace(/[\s,.，。!?！？、:：;；'"“”‘’]+/gu, "");
  return createHash("sha256").update(normalized).digest("hex");
}

export function phase5cTranscriptMatches(text: string): boolean {
  return phase5cTranscriptSha256(text) === PHASE5C_EXPECTED_TRANSCRIPT_SHA256;
}

export function phase5cAttemptDecision(outcomes: readonly string[]): Phase5cAttemptDecision {
  if (outcomes.includes("dispatched")) return "pass";
  return outcomes.length >= PHASE5C_MAX_VOICE_ATTEMPTS ? "fail" : "continue";
}
