import { DeliveryKind, QualityProfile, TaskClass } from "../../core/src";
import { JsonObject } from "../../shared/src";

export interface RecipeDefinition {
  id: string;
  title: string;
  taskClass: TaskClass;
  plannerHints: string[];
  requiredSections: string[];
  qualityProfileOverrides?: QualityProfile;
  preferredAgents: string[];
  preferredDeliverables: DeliveryKind[];
}

export interface SkillManifestDefinition {
  id: string;
  version: string;
  title: string;
  summary: string;
  recipeId: string;
  taskClass: TaskClass;
  plannerHints: string[];
  requiredSections: string[];
  preferredAgents: string[];
  preferredDeliverables: DeliveryKind[];
  auditTags: string[];
}

const RECIPES: RecipeDefinition[] = [
  {
    id: "feasibility_report",
    title: "可行性报告",
    taskClass: TaskClass.WideResearch,
    plannerHints: [
      "Favor authoritative public sources and evidence-backed comparisons.",
      "Collect regulatory, cost, timeline, risk, and execution-path evidence before drafting."
    ],
    requiredSections: ["摘要", "监管要求", "成本模型", "时间线", "风险与建议", "来源"],
    qualityProfileOverrides: {
      requiredEvidence: ["sources", "findings"],
      minSourceCount: 4,
      requireOutputReadable: true,
      requireSchemaValid: true
    },
    preferredAgents: ["ResearchAgent", "BrowserAgent", "DocumentAgent"],
    preferredDeliverables: [DeliveryKind.Markdown, DeliveryKind.Pdf]
  },
  {
    id: "timeline_brief",
    title: "时间线简报",
    taskClass: TaskClass.WideResearch,
    plannerHints: [
      "Timeline tasks require date + event + sourceUrl evidence tuples.",
      "Prefer current and authoritative sources over long narrative summaries."
    ],
    requiredSections: ["摘要", "最新动态", "时间线", "风险观察", "来源"],
    qualityProfileOverrides: {
      requiredEvidence: ["sources", "timelineEvents"],
      minSourceCount: 3,
      requireOutputReadable: true
    },
    preferredAgents: ["ResearchAgent", "BrowserAgent", "DocumentAgent"],
    preferredDeliverables: [DeliveryKind.Markdown, DeliveryKind.Pdf]
  },
  {
    id: "market_research",
    title: "市场调研",
    taskClass: TaskClass.WideResearch,
    plannerHints: [
      "Collect competitors, pricing, channels, risks, and growth signals with citations."
    ],
    requiredSections: ["摘要", "市场概况", "竞争格局", "价格与渠道", "风险", "来源"],
    qualityProfileOverrides: {
      requiredEvidence: ["sources", "findings"],
      minSourceCount: 3,
      requireOutputReadable: true
    },
    preferredAgents: ["ResearchAgent", "BrowserAgent", "DocumentAgent"],
    preferredDeliverables: [DeliveryKind.Markdown, DeliveryKind.Pdf, DeliveryKind.Pptx]
  },
  {
    id: "dataset_analysis",
    title: "数据集分析",
    taskClass: TaskClass.CodingPython,
    plannerHints: [
      "Prefer CodingAgent and local Python sandbox for file-based analysis tasks.",
      "Require concrete output files and schema-usable results."
    ],
    requiredSections: ["方法", "结果", "结论"],
    qualityProfileOverrides: {
      requiredEvidence: ["generatedFiles"],
      requireFileArtifacts: true,
      requireSchemaValid: true,
      requireOutputReadable: true
    },
    preferredAgents: ["CodingAgent", "DocumentAgent"],
    preferredDeliverables: [DeliveryKind.Json, DeliveryKind.Markdown, DeliveryKind.Pdf, DeliveryKind.Xlsx]
  },
  {
    id: "browser_workflow",
    title: "浏览器工作流",
    taskClass: TaskClass.ResearchBrowser,
    plannerHints: [
      "Use BrowserAgent for stepwise inspection, download, screenshot, and evidence capture."
    ],
    requiredSections: ["步骤结果", "证据", "来源"],
    qualityProfileOverrides: {
      requiredEvidence: ["sourceUrls", "evidencePoints"],
      minSourceCount: 1,
      requireOutputReadable: true
    },
    preferredAgents: ["BrowserAgent", "DocumentAgent"],
    preferredDeliverables: [DeliveryKind.Markdown]
  },
  {
    id: "pdf_export",
    title: "PDF 导出",
    taskClass: TaskClass.DocumentExport,
    plannerHints: [
      "Always generate readable markdown first, then export and validate the final PDF."
    ],
    requiredSections: ["标题", "正文", "来源"],
    qualityProfileOverrides: {
      requiredEvidence: ["reportPreview", "artifactValidation"],
      requireFileArtifacts: true,
      requireOutputReadable: true
    },
    preferredAgents: ["DocumentAgent", "CodingAgent"],
    preferredDeliverables: [DeliveryKind.Markdown, DeliveryKind.Pdf]
  }
];

const SKILL_MANIFESTS: SkillManifestDefinition[] = RECIPES.map((recipe) => ({
  id: recipe.id,
  version: "1.0.0",
  title: recipe.title,
  summary:
    recipe.id === "feasibility_report"
      ? "Wide-research skill for evidence-heavy feasibility and landing reports."
      : recipe.id === "timeline_brief"
        ? "Wide-research skill for timeline briefs and live situation reports."
        : recipe.id === "market_research"
          ? "Wide-research skill for market/competitor/pricing research."
          : recipe.id === "dataset_analysis"
            ? "Local Python skill for uploaded datasets and structured analysis."
            : recipe.id === "browser_workflow"
              ? "Browser workflow skill for extraction, screenshots, downloads, and storage state."
              : "Document export skill for rendering Markdown into validated deliverables.",
  recipeId: recipe.id,
  taskClass: recipe.taskClass,
  plannerHints: recipe.plannerHints,
  requiredSections: recipe.requiredSections,
  preferredAgents: recipe.preferredAgents,
  preferredDeliverables: recipe.preferredDeliverables,
  auditTags: uniqueAuditTagsForRecipe(recipe)
}));

const KEYWORD_MAP: Array<{ recipeId: string; keywords: string[] }> = [
  { recipeId: "feasibility_report", keywords: ["可行性", "落地", "实施路径", "监管", "制造", "factory", "feasibility"] },
  { recipeId: "timeline_brief", keywords: ["时间线", "timeline", "最新动态", "战情", "brief"] },
  { recipeId: "market_research", keywords: ["市场", "竞品", "pricing", "market", "调研"] },
  { recipeId: "dataset_analysis", keywords: ["csv", "xlsx", "dataset", "数据分析", "python", "json"] },
  { recipeId: "browser_workflow", keywords: ["browser", "网页", "网站", "下载", "login", "表单"] },
  { recipeId: "pdf_export", keywords: ["pdf", "导出", "排版"] }
];

export const listRecipes = (): RecipeDefinition[] => RECIPES.map((recipe) => ({ ...recipe }));

export const listSkillManifests = (): SkillManifestDefinition[] =>
  SKILL_MANIFESTS.map((manifest) => ({ ...manifest }));

export const getRecipeById = (recipeId?: string): RecipeDefinition | undefined =>
  recipeId ? RECIPES.find((recipe) => recipe.id === recipeId) : undefined;

export const getSkillManifestById = (
  skillId?: string
): SkillManifestDefinition | undefined =>
  skillId ? SKILL_MANIFESTS.find((manifest) => manifest.id === skillId) : undefined;

export const matchRecipeForGoal = (goal: string): RecipeDefinition | undefined => {
  const normalizedGoal = goal.toLowerCase();
  const scored = KEYWORD_MAP.map((entry) => ({
    recipeId: entry.recipeId,
    score: entry.keywords.reduce(
      (total, keyword) => total + (normalizedGoal.includes(keyword.toLowerCase()) ? 1 : 0),
      0
    )
  }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);

  if (scored.length === 0) {
    return undefined;
  }

  return getRecipeById(scored[0]?.recipeId);
};

export const buildRecipePlanningContext = (recipeId: string | undefined): JsonObject => {
  const recipe = getRecipeById(recipeId);
  if (!recipe) {
    return {};
  }

  const qualityProfileOverrides: JsonObject = {
    ...(recipe.qualityProfileOverrides?.requiredEvidence
      ? { requiredEvidence: recipe.qualityProfileOverrides.requiredEvidence }
      : {}),
    ...(typeof recipe.qualityProfileOverrides?.minSourceCount === "number"
      ? { minSourceCount: recipe.qualityProfileOverrides.minSourceCount }
      : {}),
    ...(typeof recipe.qualityProfileOverrides?.requireFileArtifacts === "boolean"
      ? { requireFileArtifacts: recipe.qualityProfileOverrides.requireFileArtifacts }
      : {}),
    ...(typeof recipe.qualityProfileOverrides?.requireSchemaValid === "boolean"
      ? { requireSchemaValid: recipe.qualityProfileOverrides.requireSchemaValid }
      : {}),
    ...(typeof recipe.qualityProfileOverrides?.requireOutputReadable === "boolean"
      ? { requireOutputReadable: recipe.qualityProfileOverrides.requireOutputReadable }
      : {}),
    ...(typeof recipe.qualityProfileOverrides?.requireApprovalReceipt === "boolean"
      ? { requireApprovalReceipt: recipe.qualityProfileOverrides.requireApprovalReceipt }
      : {})
  };

  return {
    recipe: {
      id: recipe.id,
      title: recipe.title,
      taskClass: recipe.taskClass,
      plannerHints: recipe.plannerHints,
      requiredSections: recipe.requiredSections,
      qualityProfileOverrides,
      preferredAgents: recipe.preferredAgents,
      preferredDeliverables: recipe.preferredDeliverables
    }
  };
};

function uniqueAuditTagsForRecipe(recipe: RecipeDefinition): string[] {
  const tags = new Set<string>([
    recipe.taskClass,
    ...recipe.preferredAgents.map((agent) => agent.toLowerCase()),
    ...recipe.preferredDeliverables.map((deliveryKind) => deliveryKind.toLowerCase())
  ]);
  if (recipe.id.includes("research") || recipe.taskClass === TaskClass.WideResearch) {
    tags.add("wide_research");
  }
  if (recipe.id.includes("browser")) {
    tags.add("browser_session");
  }
  return [...tags];
}
