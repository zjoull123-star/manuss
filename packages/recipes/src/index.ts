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
    id: "approval_workflow",
    title: "审批工作流",
    taskClass: TaskClass.ActionExecution,
    plannerHints: [
      "Prefer an approval-first action workflow when the goal requires sending, posting, or creating external side effects.",
      "Always produce a concise payload draft before requesting approval and require a delivery receipt after execution."
    ],
    requiredSections: ["执行摘要", "审批原因", "目标动作", "回执"],
    qualityProfileOverrides: {
      requiredEvidence: ["deliveryReceipt"],
      requireApprovalReceipt: true,
      requireOutputReadable: true
    },
    preferredAgents: ["DocumentAgent", "ActionAgent"],
    preferredDeliverables: [DeliveryKind.Webhook, DeliveryKind.Email, DeliveryKind.Slack, DeliveryKind.Notion]
  },
  {
    id: "browser_data_collection",
    title: "浏览器数据采集",
    taskClass: TaskClass.ResearchBrowser,
    plannerHints: [
      "Use BrowserAgent to inspect pages, persist screenshots/downloads, and return evidence-backed extraction results.",
      "Prefer canonical source URLs and capture downloaded artifacts for downstream steps."
    ],
    requiredSections: ["采集范围", "关键证据", "下载产物", "来源"],
    qualityProfileOverrides: {
      requiredEvidence: ["sourceUrls", "evidencePoints"],
      minSourceCount: 1,
      requireFileArtifacts: true,
      requireOutputReadable: true
    },
    preferredAgents: ["BrowserAgent", "DocumentAgent"],
    preferredDeliverables: [DeliveryKind.Markdown, DeliveryKind.Json]
  },
  {
    id: "email_or_slack_delivery",
    title: "邮件或 Slack 交付",
    taskClass: TaskClass.ActionExecution,
    plannerHints: [
      "Draft a short deliverable first, then deliver it through email or Slack after approval.",
      "Ensure the final action step includes a durable delivery receipt."
    ],
    requiredSections: ["交付摘要", "目标渠道", "发送内容", "回执"],
    qualityProfileOverrides: {
      requiredEvidence: ["deliveryReceipt"],
      requireApprovalReceipt: true,
      requireOutputReadable: true
    },
    preferredAgents: ["DocumentAgent", "ActionAgent"],
    preferredDeliverables: [DeliveryKind.Email, DeliveryKind.Slack, DeliveryKind.Markdown]
  },
  {
    id: "dataset_analysis_delivery",
    title: "数据分析交付",
    taskClass: TaskClass.CodingPython,
    plannerHints: [
      "Analyze uploaded datasets with CodingAgent first, then package the results into a deliverable file.",
      "Require structured outputs, readable summaries, and a final export-ready artifact."
    ],
    requiredSections: ["输入数据", "分析方法", "关键发现", "交付物"],
    qualityProfileOverrides: {
      requiredEvidence: ["generatedFiles", "reportPreview"],
      requireFileArtifacts: true,
      requireSchemaValid: true,
      requireOutputReadable: true
    },
    preferredAgents: ["CodingAgent", "DocumentAgent"],
    preferredDeliverables: [DeliveryKind.Markdown, DeliveryKind.Pdf, DeliveryKind.Docx, DeliveryKind.Xlsx]
  },
  {
    id: "pdf_or_docx_export",
    title: "PDF 或 DOCX 导出",
    taskClass: TaskClass.DocumentExport,
    plannerHints: [
      "Generate a readable markdown draft first, then export to the requested final document format and validate the artifact.",
      "Prefer PDF for brief/report tasks and DOCX for editable document delivery."
    ],
    requiredSections: ["标题", "正文", "来源", "交付校验"],
    qualityProfileOverrides: {
      requiredEvidence: ["reportPreview", "artifactValidation"],
      requireFileArtifacts: true,
      requireOutputReadable: true
    },
    preferredAgents: ["DocumentAgent", "CodingAgent"],
    preferredDeliverables: [DeliveryKind.Markdown, DeliveryKind.Pdf, DeliveryKind.Docx]
  },
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
    recipe.id === "approval_workflow"
      ? "Approval-first workflow skill for external side effects with resumable delivery."
      : recipe.id === "browser_data_collection"
        ? "Browser workflow skill for extraction, screenshots, downloads, and evidence capture."
        : recipe.id === "email_or_slack_delivery"
          ? "Delivery workflow skill for drafting and sending updates through email or Slack."
          : recipe.id === "dataset_analysis_delivery"
            ? "Dataset workflow skill for uploaded files, analysis, and final exports."
            : recipe.id === "pdf_or_docx_export"
              ? "Document export workflow skill for validated PDF or DOCX deliverables."
      : recipe.id === "feasibility_report"
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

const RECIPE_PRIORITIES: Record<string, number> = {
  approval_workflow: 80,
  browser_data_collection: 70,
  email_or_slack_delivery: 75,
  dataset_analysis_delivery: 85,
  pdf_or_docx_export: 20,
  feasibility_report: 95,
  timeline_brief: 95,
  market_research: 90,
  dataset_analysis: 85,
  browser_workflow: 70,
  pdf_export: 30
};

const KEYWORD_MAP: Array<{ recipeId: string; keywords: string[] }> = [
  { recipeId: "approval_workflow", keywords: ["审批", "approval", "批准", "发送", "通知", "delivery"] },
  { recipeId: "browser_data_collection", keywords: ["browser", "网页", "下载", "screenshot", "采集", "collect"] },
  { recipeId: "email_or_slack_delivery", keywords: ["email", "邮件", "slack", "发送", "通知"] },
  { recipeId: "dataset_analysis_delivery", keywords: ["dataset", "csv", "xlsx", "upload", "上传", "交付"] },
  { recipeId: "pdf_or_docx_export", keywords: ["docx", "word", "pdf", "导出", "export"] },
  { recipeId: "feasibility_report", keywords: ["可行性", "落地", "实施路径", "监管", "制造", "factory", "feasibility"] },
  { recipeId: "timeline_brief", keywords: ["时间线", "时间轴", "timeline", "最新动态", "战情", "简报", "brief"] },
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
    matchCount: entry.keywords.reduce(
      (total, keyword) => total + (normalizedGoal.includes(keyword.toLowerCase()) ? 1 : 0),
      0
    ),
    priority: RECIPE_PRIORITIES[entry.recipeId] ?? 50
  }))
    .filter((entry) => entry.matchCount > 0)
    .sort((left, right) => {
      if (right.matchCount !== left.matchCount) {
        return right.matchCount - left.matchCount;
      }
      return right.priority - left.priority;
    });

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
