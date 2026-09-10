import assert from "node:assert/strict";
import test from "node:test";
import { explicitLightTarget, robotLightName, resolveLightRequest, lightHomophoneRoutingHint } from "../../apps/runtime/src/robot-light-target.ts";
import type { RobotHaCapability } from "@p4home/contracts";

const light = (alias: string, domain: RobotHaCapability["domain"] = "switch"): RobotHaCapability => ({
  alias, domain, readable: true, write_actions: ["turn_on", "turn_off"],
});

test("bounded spotlight and downlight homophones resolve across direct, reversed and query phrasing", () => {
  const capabilities = [light("living_room_spot_light"), light("living_room_down_light")];
  for (const [variants, name, alias] of [
    [["射灯", "设灯", "设登", "社灯", "涉灯", "摄灯", "舍灯"], "客厅射灯", "living_room_spot_light"],
    [["筒灯", "桶灯", "统灯", "同灯", "铜灯", "通灯", "筒登", "同登"], "客厅筒灯", "living_room_down_light"],
  ] as const) {
    for (const spelling of variants) for (const [text, action] of [
      [`打开客厅${spelling}`, "turn_on"], [`请把客厅的${spelling}关掉一下。`, "turn_off"],
      [`查询客厅的${spelling}状态`, "get_entity"],
    ]) {
      const resolved = resolveLightRequest(text!, capabilities);
      assert.equal(resolved?.name, name, text);
      assert.equal(resolved?.action, action, text);
      assert.deepEqual(resolved?.aliases, [alias], text);
    }
  }
});

test("homophones neither rewrite prose and negation nor borrow another room's lamp", () => {
  const capabilities = [light("living_room_down_light")];
  for (const text of ["不要打开客厅同灯", "如果天黑就打开客厅桶灯", "他说把客厅的设灯打开", "解释一下铜灯", "打开客厅设灯和筒灯", "打开客厅设灯，如果我回来", "打开‘客厅设灯’这几个字是什么意思"]) {
    assert.equal(lightHomophoneRoutingHint(text), "", text);
    assert.equal(resolveLightRequest(text, capabilities), null, text);
  }
  assert.deepEqual(resolveLightRequest("打开书房桶灯", capabilities)?.aliases, []);
  assert.deepEqual(resolveLightRequest("打开书房筒灯", capabilities)?.aliases, []);
  assert.equal(resolveLightRequest("打开客厅灯", capabilities), null);
  assert.equal(resolveLightRequest("打开客厅桶灯", capabilities)?.name, "客厅筒灯");
  assert.deepEqual(explicitLightTarget("把客厅的设灯打开", [light("living_room_spot_light")]), {
    aliases: ["living_room_spot_light"], action: "turn_on",
  });
});

test("lighting vocabulary preserves rooms and distinct fixture names", () => {
  for (const [alias, name] of [
    ["bar_light", "吧台灯"], ["balcony_main_light", "阳台大灯"],
    ["mirror_cabinet_light", "镜柜灯"], ["master_bathroom_mirror_cabinet_light", "主卫镜柜灯"],
    ["balcony_bedroom_fan_light", "阳台卧风扇灯"], ["study_ceiling_light", "书房吸顶灯"],
  ]) assert.equal(robotLightName(light(alias!)), name);
  assert.equal(robotLightName(light("unknown_switch")), null);
  assert.equal(robotLightName(light("bar_light", "climate")), null);
});

test("single light parsing retains intent, homophones and duplicate ambiguity without parsing batches", () => {
  const capabilities = [light("living_room_spot_light"), light("study_ceiling_light")];
  assert.deepEqual(explicitLightTarget("请关闭客厅设灯。", capabilities), {
    aliases: ["living_room_spot_light"], action: "turn_off",
  });
  assert.deepEqual(explicitLightTarget("打开书房顶灯一下", capabilities), {
    aliases: ["study_ceiling_light"], action: "turn_on",
  });
  for (const text of ["不要打开客厅射灯", "打开客厅射灯和书房吸顶灯", "打开不存在的灯", "灯怎么打开"]) {
    assert.equal(explicitLightTarget(text, capabilities), null);
  }
  assert.equal(explicitLightTarget("打开客厅射灯", [...capabilities, light("living_room_spotlight")])?.aliases.length, 2);
});
