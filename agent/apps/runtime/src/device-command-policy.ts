/** Conservative veto for explicitly negated device operations, never an authorization parser. */
export function hasNegatedDeviceCommand(text: string): boolean {
  return /(?:不要|先别|别|不许|禁止|勿|不用|不能)\s*(?:再|给我|帮我|替我|把.{0,20}?)?\s*(?:打开|开启|关闭|关掉|开|关|启动|停止|控制|执行)/u.test(text);
}

/** Third-person reported commands require direct confirmation, not execution. */
export function hasReportedDeviceCommand(text: string): boolean {
  return /^(?:他|她|他们|她们|别人|有人)(?:说|提到|问|要求)(?:过|了)?[：:，,\s“”"']*(?:把|打开|开启|关闭|关掉|开|关)/u.test(text.trim());
}
