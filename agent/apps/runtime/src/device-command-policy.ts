/** Conservative veto for explicitly negated device operations, never an authorization parser. */
export function hasNegatedDeviceCommand(text: string): boolean {
  return /(?:不要|先别|别|不许|禁止|勿|不用|不能)\s*(?:再|给我|帮我|替我|把.{0,20}?)?\s*(?:打开|开启|关闭|关掉|开|关|启动|停止|控制|执行)/u.test(text);
}
