import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRecipePlanningContext,
  listSkillManifests,
  matchRecipeForGoal
} from "../src/index.js";

test("skill manifests include OpenClaw-first automation workflow recipes", () => {
  const skills = listSkillManifests();
  const ids = new Set(skills.map((skill) => skill.id));

  assert.ok(ids.has("approval_workflow"));
  assert.ok(ids.has("browser_data_collection"));
  assert.ok(ids.has("email_or_slack_delivery"));
  assert.ok(ids.has("dataset_analysis_delivery"));
  assert.ok(ids.has("pdf_or_docx_export"));
});

test("recipe matcher prefers automation-oriented workflow manifests for matching goals", () => {
  assert.equal(
    matchRecipeForGoal("请在审批后通过 webhook 发送这条通知")?.id,
    "approval_workflow"
  );
  assert.equal(
    matchRecipeForGoal("访问网页并下载附件，保留截图证据")?.id,
    "browser_data_collection"
  );
  assert.equal(
    matchRecipeForGoal("读取上传的 CSV 并导出最终交付")?.id,
    "dataset_analysis_delivery"
  );
  assert.equal(
    matchRecipeForGoal("做一个关于伊朗战争的最新简报带时间轴，输出 pdf")?.id,
    "timeline_brief"
  );
});

test("recipe planning context exposes workflow-specific hints and deliverables", () => {
  const context = buildRecipePlanningContext("approval_workflow");
  const recipe = context["recipe"] as Record<string, unknown>;

  assert.equal(recipe["id"], "approval_workflow");
  assert.ok(Array.isArray(recipe["plannerHints"]));
  assert.ok(Array.isArray(recipe["preferredDeliverables"]));
});
