export type HumanResponsePolicyViolation =
  | "EMPTY_RESPONSE"
  | "DEVICE_EXECUTION_CLAIM"
  | "CLARIFICATION_REQUIRED";

export interface HumanResponsePolicyAssessment {
  readonly compliant: boolean;
  readonly violation: HumanResponsePolicyViolation | null;
}

const DEVICE_TERM =
  "(?:设备|灯|灯光|空调|风扇|窗帘|插座|开关|电视|音箱|加湿器|净化器|门锁|暖气)";
const DEVICE_ACTION =
  "(?:打开|开启|关闭|关掉|启动|停止|调高|调低|调亮|调暗|设置|切换|控制|执行)";
const COMPLETION = "(?:已经|已|刚刚|成功|完成|好了|完毕)";

const DEVICE_EXECUTION_CLAIMS = [
  new RegExp(`${DEVICE_TERM}.{0,12}${COMPLETION}.{0,8}${DEVICE_ACTION}`),
  new RegExp(`${COMPLETION}.{0,12}${DEVICE_ACTION}.{0,12}${DEVICE_TERM}`),
  new RegExp(`(?:我|为你|帮你).{0,12}${DEVICE_ACTION}.{0,12}${DEVICE_TERM}`),
  new RegExp(`${DEVICE_TERM}.{0,12}${DEVICE_ACTION}.{0,8}(?:了|成功|完成|好了)`),
  new RegExp(`${DEVICE_ACTION}.{0,12}${DEVICE_TERM}.{0,8}(?:了|成功|完成|好了)`),
  new RegExp(`${DEVICE_TERM}.{0,8}(?:开|关|亮|灭)(?:了|好了|上了)`),
  new RegExp(`${COMPLETION}.{0,8}(?:开|关).{0,8}${DEVICE_TERM}`),
  /\b(?:i(?:'ve| have)?|we(?:'ve| have)?)\s+(?:turned|switched|set|opened|closed|started|stopped)\b/i,
] as const;

const CLARIFICATION_SIGNAL =
  /(?:请|能否|可以).{0,24}(?:说明|告诉|明确|具体)|(?:什么|哪个|哪一个|哪种|哪台|哪盏|哪里|何时|多少|怎么)|[?？]/;

export function assessHumanResponsePolicy(
  text: string,
  mode: "respond" | "clarify",
): HumanResponsePolicyAssessment {
  const normalized = text.trim();
  if (normalized.length === 0) {
    return { compliant: false, violation: "EMPTY_RESPONSE" };
  }
  if (DEVICE_EXECUTION_CLAIMS.some((pattern) => pattern.test(normalized))) {
    return { compliant: false, violation: "DEVICE_EXECUTION_CLAIM" };
  }
  if (mode === "clarify" && !CLARIFICATION_SIGNAL.test(normalized)) {
    return { compliant: false, violation: "CLARIFICATION_REQUIRED" };
  }
  return { compliant: true, violation: null };
}
