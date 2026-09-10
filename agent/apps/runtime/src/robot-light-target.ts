import type { RobotHaCapability } from "@p4home/contracts";

// Semantic alias vocabulary; no private HA entity IDs or server attributes.
// Unknown alias conventions remain unnamed and use the existing clarification path.
const ROOMS: Readonly<Record<string, string>> = {
  living_room: "客厅", dining_room: "餐厅", study: "书房", kitchen: "厨房",
  balcony_bedroom: "阳台卧", balcony: "阳台", master_bathroom: "主卫",
  master_bedroom: "主卧", walk_in_closet: "衣帽间",
};
const LIGHTS: Readonly<Record<string, string>> = {
  light: "灯", main_light: "大灯", ceiling_light: "吸顶灯", spot_light: "射灯",
  spotlight: "射灯", display_light: "展示灯", wall_light: "壁灯", down_light: "筒灯",
  cabinet_light: "柜灯", mirror_cabinet_light: "镜柜灯", fan_light: "风扇灯",
  hallway_light: "过道灯", archway_light: "拱门灯", flower_light: "花灯",
  cup_light: "杯子灯", bar_light: "吧台灯", linear_light: "线灯",
};

export function robotLightName(capability: RobotHaCapability): string | null {
  if (capability.domain !== "light" && capability.domain !== "switch") return null;
  const exact = LIGHTS[capability.alias];
  if (exact !== undefined) return exact;
  for (const [room, name] of Object.entries(ROOMS)) {
    if (!capability.alias.startsWith(`${room}_`)) continue;
    const light = LIGHTS[capability.alias.slice(room.length + 1)];
    if (light !== undefined) return name + light;
  }
  return null;
}

interface ParsedLightRequest {
  readonly raw_name: string;
  readonly name: string;
  readonly action: "turn_on" | "turn_off" | "get_entity";
  readonly corrected: boolean;
}

function parseLightRequest(text: string): ParsedLightRequest | null {
  const body = text.trim().replace(/^(?:(?:请|麻烦|帮我|替我)\s*)+/u, "")
    .replace(/[。！!？?\s]+$/u, "");
  const direct = /^(打开|开启|关闭|关掉|开|关)\s*(.+?)(?:\s*一下)?$/u.exec(body);
  const reversed = /^把\s*(.+?)\s*(打开|开启|关闭|关掉|开|关)(?:\s*一下)?$/u.exec(body);
  const read = /^(?:查询|查看|查一下|看看)\s*(.+?)(?:的?状态)?$/u.exec(body);
  const rawName = direct?.[2] ?? reversed?.[1] ?? read?.[1];
  if (rawName === undefined || /[，,。！!？?“”「」"\n]/u.test(rawName)) return null;
  const compact = rawName.replace(/\s+/gu, "").replace(/的/gu, "");
  // Only the lamp noun changes; room, verb, negation and multi-clause text do not.
  // Candidate homophones beyond 设灯/设登 are bounded spelling variants, not
  // evidence that the microphone actually produced each variant.
  const name = compact.replace(/[射设社涉摄舍][灯登]$/u, "射灯")
    .replace(/[筒桶统同铜通][灯登]$/u, "筒灯")
    .replace(/(?<!吸)顶灯$/u, "吸顶灯");
  const roomQualified = Object.values(ROOMS).some(room =>
    ["射灯", "筒灯", "吸顶灯"].some(kind => name === room + kind));
  if (compact !== name && !roomQualified && !["射灯", "筒灯", "吸顶灯"].includes(name)) return null;
  const verb = direct?.[1] ?? reversed?.[2];
  return {
    raw_name: rawName, name, corrected: compact !== name,
    action: verb === undefined ? "get_entity" : ["打开", "开启", "开"].includes(verb) ? "turn_on" : "turn_off",
  };
}

export function lightHomophoneRoutingHint(text: string): string {
  const request = parseLightRequest(text);
  return request?.corrected === true
    ? `本句家居设备词的同音识别提示：${JSON.stringify({ heard: request.raw_name, name: request.name })}。仅辅助语义分类，assignment.text 必须保留原文，不得按提示改写。`
    : "";
}

export function resolveLightRequest(text: string, capabilities: readonly RobotHaCapability[]):
  (ParsedLightRequest & { readonly aliases: readonly string[] }) | null {
  const request = parseLightRequest(text);
  if (request === null) return null;
  const aliases = capabilities.filter(capability => robotLightName(capability) === request.name)
    .map(capability => capability.alias);
  // An unresolvable correction remains explicit ambiguity, never another room's lamp.
  const knownName = Object.values(LIGHTS).some(kind => kind !== "灯" && (request.name === kind
    || Object.values(ROOMS).some(room => request.name === room + kind)));
  return aliases.length === 0 && !request.corrected && !knownName ? null : { ...request, aliases };
}

/** Exact single-target veto only: never supplies tools, changes permissions or handles batches. */
export function explicitLightTarget(
  text: string, capabilities: readonly RobotHaCapability[],
): { readonly aliases: readonly string[]; readonly action: "turn_on" | "turn_off" } | null {
  const request = resolveLightRequest(text, capabilities);
  return request === null || request.action === "get_entity" ? null
    : { aliases: request.aliases, action: request.action };
}
