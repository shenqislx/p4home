import assert from "node:assert/strict";
import test from "node:test";

import {
  productVoiceAllowsCatAutonomy,
  productVoiceAllowsRobot,
  resolveProductVoiceRoleMode,
} from "@p4home/runtime";

test("product Voice defaults to Human-only and does not allow Robot", () => {
  const mode = resolveProductVoiceRoleMode(undefined);
  assert.equal(mode, "human-only");
  assert.equal(productVoiceAllowsRobot(mode), false);
  assert.equal(productVoiceAllowsCatAutonomy(mode), false);
  assert.equal(resolveProductVoiceRoleMode("  human-only  "), "human-only");
});

test("product Voice requires an explicit valid mode before enabling Robot", () => {
  const mode = resolveProductVoiceRoleMode("human-robot");
  assert.equal(productVoiceAllowsRobot(mode), true);
  assert.equal(productVoiceAllowsCatAutonomy(mode), true);
  assert.throws(
    () => resolveProductVoiceRoleMode("robot-only"),
    /invalid_p4home_product_role_mode/,
  );
});
