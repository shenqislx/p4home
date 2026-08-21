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
const PAST_MARKER = "(?:已经|曾经|之前|刚刚|刚才|已|曾|刚)";
const STRONG_COMPLETION = "(?:成功|完成|好了|完毕)";
const NEGATION_BEFORE_ACTION = /(?:没有|并未|不曾|没|未)/u;
const INTENT_BEFORE_ACTION = /(?:想要?|打算|准备|计划|询问|能否|可以|怎么|如何)/u;
const QUESTION_SIGNAL = /[?？]|(?:什么|哪个|哪一个|哪种|哪台|哪盏|是否)/u;
const CLAUSE_BOUNDARY = /[。！!，,；;\n]+|(?:但是|而是|然后|随后|并且|不过|但|却)/u;
const ACTION_CONTEXT_BOUNDARY = /(?:但是|而是|然后|随后|接着|并且|不过|但|却|竟然|便|就|又)/gu;

const DEVICE_EXECUTION_CLAIMS = [
  /\b(?:i(?:'ve| have)?|we(?:'ve| have)?)\s+(?:(?:just|already)\s+)?(?:turned|switched|set|opened|closed|started|stopped)\b/i,
] as const;

function hasStructuredDeviceExecutionClaim(text: string): boolean {
  const actionPattern = new RegExp(DEVICE_ACTION, "gu");
  const devicePattern = new RegExp(DEVICE_TERM, "u");
  const pastPattern = new RegExp(PAST_MARKER, "u");
  const strongCompletionPattern = new RegExp(STRONG_COMPLETION, "u");
  const deviceThenCompletion = new RegExp(
    `${DEVICE_TERM}.{0,8}(?:了|过|成功|完成|好了|完毕)`,
    "u",
  );
  const stateCompletionPattern = new RegExp(
    `${DEVICE_TERM}.{0,8}?(没|未|不)?(?:再|能|会|继续)?(?:开|关|亮|灭)(?:了|好了|上了)`,
    "u",
  );
  for (const clause of text.split(CLAUSE_BOUNDARY)) {
    const devices = [...clause.matchAll(new RegExp(DEVICE_TERM, "gu"))].map(
      (match) => ({ start: match.index, end: match.index + match[0].length }),
    );
    if (devices.length === 0 || !devicePattern.test(clause)) continue;
    const questionIndex = QUESTION_SIGNAL.exec(clause)?.index ?? -1;
    const stateCompletion = stateCompletionPattern.exec(clause);
    if (
      stateCompletion !== null
      && stateCompletion[1] === undefined
      && (questionIndex < 0 || questionIndex >= stateCompletion.index + stateCompletion[0].length)
    ) return true;
    for (const match of clause.matchAll(actionPattern)) {
      const index = match.index;
      const action = match[0];
      const actionEnd = index + action.length;
      const device = devices.reduce((nearest, candidate) => {
        const candidateDistance = Math.min(
          Math.abs(candidate.start - actionEnd),
          Math.abs(index - candidate.end),
        );
        const nearestDistance = Math.min(
          Math.abs(nearest.start - actionEnd),
          Math.abs(index - nearest.end),
        );
        return candidateDistance < nearestDistance ? candidate : nearest;
      });
      const semanticPairEnd = Math.max(actionEnd, device.end);
      if (questionIndex >= 0 && questionIndex < semanticPairEnd) continue;
      const before = clause.slice(0, index);
      const after = clause.slice(actionEnd);
      let contextStart = 0;
      for (const boundary of before.matchAll(ACTION_CONTEXT_BOUNDARY)) {
        contextStart = boundary.index + boundary[0].length;
      }
      const actionContext = before.slice(contextStart);
      if (NEGATION_BEFORE_ACTION.test(actionContext)) continue;
      const intentContext = actionContext.replace(/(?:按|按照)计划/gu, "");
      if (INTENT_BEFORE_ACTION.test(intentContext)) continue;
      const explicitCompletion = /^(?:了|过|成功|完成)/u.test(after)
        || deviceThenCompletion.test(after);
      if (
        explicitCompletion
        || strongCompletionPattern.test(before)
        || pastPattern.test(before)
      ) return true;
    }
  }
  return false;
}

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
  if (
    DEVICE_EXECUTION_CLAIMS.some((pattern) => pattern.test(normalized))
    || hasStructuredDeviceExecutionClaim(normalized)
  ) {
    return { compliant: false, violation: "DEVICE_EXECUTION_CLAIM" };
  }
  if (mode === "clarify" && !CLARIFICATION_SIGNAL.test(normalized)) {
    return { compliant: false, violation: "CLARIFICATION_REQUIRED" };
  }
  return { compliant: true, violation: null };
}
