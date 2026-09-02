export const PRODUCT_VOICE_ROLE_MODES = ["human-only", "human-robot"] as const;

export type ProductVoiceRoleMode = (typeof PRODUCT_VOICE_ROLE_MODES)[number];

/**
 * Human-only is the safe product default. Enabling Robot requires an explicit
 * deployment setting and is the only mode that may load Home Assistant
 * credentials or construct a Robot HA client.
 */
export function resolveProductVoiceRoleMode(
  value: string | undefined,
): ProductVoiceRoleMode {
  const normalized = value?.trim() || "human-only";
  if (!PRODUCT_VOICE_ROLE_MODES.includes(normalized as ProductVoiceRoleMode)) {
    throw new Error("invalid_p4home_product_role_mode");
  }
  return normalized as ProductVoiceRoleMode;
}

export function productVoiceAllowsRobot(mode: ProductVoiceRoleMode): boolean {
  return mode === "human-robot";
}

export function productVoiceAllowsCatAutonomy(
  mode: ProductVoiceRoleMode,
): boolean {
  return mode === "human-robot";
}
