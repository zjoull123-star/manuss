import test from "node:test";
import assert from "node:assert/strict";
import {
  AgentKind,
  ErrorCode,
  StepStatus,
  TaskClass,
  TaskStatus,
  ToolName,
  UserProfile
} from "../../core/src";
import { ModelRouter } from "../../llm/src";
import {
  BrowserAgent,
  CodingAgent,
  DocumentAgent,
  PlannerAgent,
  ResearchAgent,
  RouterAgent,
  VerifierAgent
} from "../src";
import { ContextBuilder, InMemoryMemoryStore } from "../../memory/src";
import { ToolRuntime } from "../../tools/src";

test("router treats TASK-prefixed messages as executable work", async () => {
  const agent = new RouterAgent(new ModelRouter());

  const shortTask = await agent.route("   TASK: summarize the attached notes");
  const longTask = await agent.route(
    "TASK: research the Dubai EV rental market, compare the main players, include pricing and channel differences, and draft a concise linked report with sources for each finding."
  );

  assert.equal(shortTask.route, "single_step");
  assert.equal(longTask.route, "multi_step");
  assert.equal(shortTask.intent, "task_execution");
  assert.equal(longTask.intent, "task_execution");
});

test("planner rewrites action-only plans for non-side-effect goals", async () => {
  const llmClient = {
    isConfigured: () => true,
    generateJson: async () => ({
      data: {
        goal: "输出一段两行中文文本",
        assumptions: [],
        steps: [
          {
            id: "s1",
            title: "send output",
            agent: AgentKind.Action,
            objective: "Send the result externally",
            dependsOn: [],
            inputs: ["goal"],
            expectedOutput: "external action",
            successCriteria: ["delivered"]
          }
        ],
        taskSuccessCriteria: ["done"]
      }
    })
  } as const;

  const planner = new PlannerAgent(new ModelRouter(), llmClient as never, "live");
  const plan = await planner.createPlan("输出一段两行中文文本", {});

  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0]?.agent, AgentKind.Document);
  assert.equal(plan.steps[0]?.title, "Generate requested output");
});

test("planner fallback keeps non-market goals goal-aware", async () => {
  const llmClient = {
    isConfigured: () => true,
    generateJson: async () => {
      throw new Error("planner upstream timeout");
    }
  } as const;

  const planner = new PlannerAgent(new ModelRouter(), llmClient as never, "live");
  const plan = await planner.createPlan(
    "TASK: 生成《伊朗战情简报（最新72小时）》中文可转发版",
    {}
  );

  assert.match(plan.steps[0]?.objective ?? "", /伊朗战情简报/);
  assert.equal(plan.steps[0]?.agent, AgentKind.Research);
});

test("planner fallback routes python-oriented tasks to coding first", async () => {
  const planner = new PlannerAgent(new ModelRouter(), undefined, "mock");
  const plan = await planner.createPlan(
    "TASK: 用 Python 分析 12, 18, 25, 40 这四个数字并输出 JSON 和 markdown 摘要",
    {}
  );

  assert.equal(plan.steps[0]?.agent, AgentKind.Coding);
  assert.match(plan.steps[0]?.objective ?? "", /Python/);
});

test("planner normalizes coding-oriented plans to coding first", async () => {
  const llmClient = {
    isConfigured: () => true,
    generateJson: async () => ({
      data: {
        goal: "TASK: 用 Python 清洗 CSV 并输出 JSON",
        assumptions: [],
        steps: [
          {
            id: "step1",
            title: "整理输出",
            agent: AgentKind.Document,
            objective: "输出最终说明",
            dependsOn: [],
            inputs: ["goal"],
            expectedOutput: "说明文档",
            successCriteria: ["输出结果"]
          }
        ],
        taskSuccessCriteria: ["完成输出"]
      }
    })
  } as const;

  const planner = new PlannerAgent(new ModelRouter(), llmClient as never, "live");
  const plan = await planner.createPlan("TASK: 用 Python 清洗 CSV 并输出 JSON", {});

  assert.equal(plan.steps[0]?.agent, AgentKind.Coding);
});

test("planner normalizes report-only plans to document first", async () => {
  const llmClient = {
    isConfigured: () => true,
    generateJson: async () => ({
      data: {
        goal: "TASK: 生成一份简短中文总结报告",
        assumptions: [],
        steps: [
          {
            id: "step1",
            title: "运行脚本",
            agent: AgentKind.Coding,
            objective: "生成结果",
            dependsOn: [],
            inputs: ["goal"],
            expectedOutput: "输出",
            successCriteria: ["完成"]
          }
        ],
        taskSuccessCriteria: ["输出报告"]
      }
    })
  } as const;

  const planner = new PlannerAgent(new ModelRouter(), llmClient as never, "live");
  const plan = await planner.createPlan("TASK: 生成一份简短中文总结报告", {});

  assert.equal(plan.steps[0]?.agent, AgentKind.Document);
});

test("planner removes dangling dependencies when stripping action steps", async () => {
  const llmClient = {
    isConfigured: () => true,
    generateJson: async () => ({
      data: {
        goal: "输出一段两行中文文本",
        assumptions: [],
        steps: [
          {
            id: "step1",
            title: "send output",
            agent: AgentKind.Action,
            objective: "Send the result externally",
            dependsOn: [],
            inputs: ["goal"],
            expectedOutput: "external action",
            successCriteria: ["delivered"]
          },
          {
            id: "step2",
            title: "compose output",
            agent: AgentKind.Document,
            objective: "Compose the final text",
            dependsOn: ["step1"],
            inputs: ["goal"],
            expectedOutput: "final text",
            successCriteria: ["done"]
          }
        ],
        taskSuccessCriteria: ["done"]
      }
    })
  } as const;

  const planner = new PlannerAgent(new ModelRouter(), llmClient as never, "live");
  const plan = await planner.createPlan("输出一段两行中文文本", {});

  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0]?.agent, AgentKind.Document);
  assert.deepEqual(plan.steps[0]?.dependsOn, []);
});

test("planner appends a coding pdf export step when the goal requires pdf output", async () => {
  const llmClient = {
    isConfigured: () => true,
    generateJson: async () => ({
      data: {
        goal: "TASK: 做一个关于伊朗战争的最新简报带时间轴,输出pdf",
        assumptions: [],
        steps: [
          {
            id: "S1",
            title: "收集最新战事信息与时间轴事件",
            agent: AgentKind.Browser,
            objective: "检索并汇总伊朗相关战争/军事冲突的最新公开进展",
            dependsOn: [],
            inputs: ["goal"],
            expectedOutput: "结构化素材清单",
            successCriteria: ["覆盖最新进展"]
          },
          {
            id: "S2",
            title: "撰写中文简报并排版",
            agent: AgentKind.Document,
            objective: "基于收集素材生成一份简洁中文简报",
            dependsOn: ["S1"],
            inputs: ["S1"],
            expectedOutput: "一份已排版的简报文档",
            successCriteria: ["包含时间轴"]
          }
        ],
        taskSuccessCriteria: ["产出一份中文简报"]
      }
    })
  } as const;

  const planner = new PlannerAgent(new ModelRouter(), llmClient as never, "live");
  const plan = await planner.createPlan(
    "TASK: 做一个关于伊朗战争的最新简报带时间轴,输出pdf",
    {}
  );

  assert.equal(plan.steps.length, 3);
  assert.equal(plan.steps[2]?.agent, AgentKind.Coding);
  assert.equal(plan.steps[2]?.id, "S3");
  assert.deepEqual(plan.steps[2]?.dependsOn, ["S2"]);
  assert.match(plan.steps[2]?.objective ?? "", /PDF/);
  assert.equal(plan.taskSuccessCriteria.includes("最终输出为可打开的 PDF 文件"), true);
});

test("planner normalizes existing pdf export steps to coding", async () => {
  const llmClient = {
    isConfigured: () => true,
    generateJson: async () => ({
      data: {
        goal: "TASK: 生成系统连通性测试简报并导出 pdf",
        assumptions: [],
        steps: [
          {
            id: "step1",
            title: "起草中文简报",
            agent: AgentKind.Document,
            objective: "生成一份中文简报文稿",
            dependsOn: [],
            inputs: ["goal"],
            expectedOutput: "markdown 简报",
            successCriteria: ["文稿完成"]
          },
          {
            id: "step2",
            title: "排版并导出为 PDF",
            agent: AgentKind.Document,
            objective: "将简报内容整理为文档并导出为 PDF 文件",
            dependsOn: ["step1"],
            inputs: ["step1"],
            expectedOutput: "PDF 文件",
            successCriteria: ["成功生成 PDF"]
          }
        ],
        taskSuccessCriteria: ["生成 PDF"]
      }
    })
  } as const;

  const planner = new PlannerAgent(new ModelRouter(), llmClient as never, "live");
  const plan = await planner.createPlan("TASK: 生成系统连通性测试简报并导出 pdf", {});

  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[1]?.agent, AgentKind.Coding);
  assert.match(plan.steps[1]?.objective ?? "", /PDF/);
  assert.equal(plan.steps[1]?.expectedOutput, "PDF 文件。");
});

test("planner inserts a document step before pdf export when the goal requires markdown and pdf", async () => {
  const llmClient = {
    isConfigured: () => true,
    generateJson: async () => ({
      data: {
        goal: "TASK: 使用上传的 CSV 文件，先用 Python 做汇总，再输出 markdown 摘要和 pdf。",
        assumptions: [],
        steps: [
          {
            id: "step1",
            title: "读取 CSV 并生成汇总结果",
            agent: AgentKind.Coding,
            objective: "使用 Python 读取上传的 CSV 并生成结构化汇总结果",
            dependsOn: [],
            inputs: ["goal"],
            expectedOutput: "结构化分析结果",
            successCriteria: ["完成 CSV 汇总"]
          },
          {
            id: "step2",
            title: "导出 PDF",
            agent: AgentKind.Coding,
            objective: "将结果直接导出为 PDF",
            dependsOn: ["step1"],
            inputs: ["step1 结构化结果"],
            expectedOutput: "PDF 文件",
            successCriteria: ["生成 PDF"]
          }
        ],
        taskSuccessCriteria: ["生成 markdown 摘要", "生成 PDF"]
      }
    })
  } as const;

  const planner = new PlannerAgent(new ModelRouter(), llmClient as never, "live");
  const plan = await planner.createPlan(
    "TASK: 使用上传的 CSV 文件，先用 Python 做汇总，再输出 markdown 摘要和 pdf。",
    {}
  );

  assert.equal(plan.steps.length, 3);
  assert.equal(plan.steps[0]?.agent, AgentKind.Coding);
  assert.equal(plan.steps[1]?.agent, AgentKind.Document);
  assert.equal(plan.steps[2]?.agent, AgentKind.Coding);
  assert.deepEqual(plan.steps[2]?.dependsOn, [plan.steps[1]?.id]);
});

test("planner mock path preserves coding -> document -> pdf order for uploaded csv markdown pdf goals", async () => {
  const planner = new PlannerAgent(new ModelRouter(), undefined, "mock");
  const plan = await planner.createPlan(
    "读取上传的 CSV，输出关键发现、markdown 摘要并导出 PDF",
    { recipeId: "dataset_analysis" }
  );

  assert.deepEqual(
    plan.steps.map((step) => step.agent),
    [AgentKind.Coding, AgentKind.Document, AgentKind.Coding]
  );
  assert.equal(plan.steps[0]?.dependsOn.length, 0);
  assert.deepEqual(plan.steps[1]?.dependsOn, [plan.steps[0]?.id]);
  assert.deepEqual(plan.steps[2]?.dependsOn, [plan.steps[1]?.id]);
});

test("planner routes direct local pdf text replacement goals to a single coding step", async () => {
  const planner = new PlannerAgent(new ModelRouter(), undefined, "mock");
  const plan = await planner.createPlan(
    'TASK: 把 PDF 文件 /Users/ericesan/.openclaw/media/inbound/sample.pdf 中所有的 "ESAN TRADING FZE" 改成 "aerox space fze"，并输出新文件路径。',
    {}
  );

  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0]?.agent, AgentKind.Coding);
  assert.equal(plan.steps[0]?.taskClass, TaskClass.CodingPython);
  assert.match(
    plan.steps[0]?.objective ?? "",
    /replace the requested text inside the referenced PDF/i
  );
});

test("browser agent falls back to the next candidate when the first page is blocked", async () => {
  const attempts: string[] = [];
  const toolRuntime = {
    execute: async (request: {
      input: Record<string, unknown>;
      toolName: ToolName;
      stepId: string;
      taskId: string;
      action: string;
      callerAgent: AgentKind;
    }) => {
      const url = String(request.input.url ?? "");
      attempts.push(url);

      if (url.includes("blocked.example")) {
        return {
          status: "success" as const,
          summary: `Extracted browser content from ${url}`,
          output: {
            currentUrl: url,
            pageTitle: "Attention Required! | Cloudflare",
            extractedText: "Please enable cookies. Verify you are human."
          },
          artifacts: ["/tmp/blocked.png"]
        };
      }

      return {
        status: "success" as const,
        summary: `Extracted browser content from ${url}`,
        output: {
          currentUrl: url,
          pageTitle: "Competitor Pricing",
          extractedText: "Airport delivery, monthly plans, and EV fleet pricing."
        },
        artifacts: ["/tmp/success.png"]
      };
    }
  } as unknown as ToolRuntime;

  const agent = new BrowserAgent(toolRuntime, new ModelRouter(), undefined, "mock");
  const response = await agent.execute({
    taskId: "task_browser",
    stepId: "s2",
    goal: "调研竞品官网",
    context: {
      topResultUrl: "https://blocked.example",
      browserCandidateUrls: ["https://blocked.example", "https://success.example"]
    },
    successCriteria: [],
    artifacts: []
  });

  assert.equal(response.status, "success");
  assert.deepEqual(attempts, ["https://blocked.example", "https://success.example"]);
  assert.equal(response.structuredData?.currentUrl, "https://success.example");
  assert.equal(response.artifacts?.[0], "/tmp/success.png");
  assert.ok(Array.isArray(response.structuredData?.attemptSummaries));
});

test("browser agent falls back to the next candidate when the first page is low-substance", async () => {
  const attempts: string[] = [];
  const toolRuntime = {
    execute: async (request: {
      input: Record<string, unknown>;
      toolName: ToolName;
      stepId: string;
      taskId: string;
      action: string;
      callerAgent: AgentKind;
    }) => {
      const url = String(request.input.url ?? "");
      attempts.push(url);

      if (url.includes("404.example")) {
        return {
          status: "success" as const,
          summary: `Extracted browser content from ${url}`,
          output: {
            currentUrl: url,
            pageTitle: "404 - File or directory not found.",
            extractedText:
              "The resource you are looking for might have been removed, had its name changed, or is temporarily unavailable."
          },
          artifacts: ["/tmp/404.png"]
        };
      }

      return {
        status: "success" as const,
        summary: `Extracted browser content from ${url}`,
        output: {
          currentUrl: url,
          pageTitle: "Dubai Manufacturing Guidance",
          extractedText:
            "Industrial licensing, cosmetics registration, fire safety approvals, and customs duties are required."
        },
        artifacts: ["/tmp/success.png"]
      };
    }
  } as unknown as ToolRuntime;

  const agent = new BrowserAgent(toolRuntime, new ModelRouter(), undefined, "mock");
  const response = await agent.execute({
    taskId: "task_browser_404",
    stepId: "s2",
    goal: "调研在阿联酋开设香水制造公司的可行性",
    context: {
      topResultUrl: "https://404.example",
      browserCandidateUrls: ["https://404.example", "https://success.example"]
    },
    successCriteria: [],
    artifacts: []
  });

  assert.equal(response.status, "success");
  assert.deepEqual(attempts, ["https://404.example", "https://success.example"]);
  assert.equal(response.structuredData?.currentUrl, "https://success.example");
  assert.equal(response.artifacts?.[0], "/tmp/success.png");
});

test("browser agent bootstraps candidate urls with search when none are provided", async () => {
  const callOrder: string[] = [];
  const toolRuntime = {
    execute: async (request: {
      input: Record<string, unknown>;
      toolName: ToolName;
      stepId: string;
      taskId: string;
      action: string;
      callerAgent: AgentKind;
    }) => {
      if (request.toolName === ToolName.Search) {
        callOrder.push("search");
        return {
          status: "success" as const,
          summary: "Collected 2 web results",
          output: {
            results: [
              { url: "https://blocked.example", title: "blocked" },
              { url: "https://success.example", title: "success" }
            ]
          }
        };
      }

      callOrder.push(String(request.input.url ?? ""));
      if (String(request.input.url).includes("blocked.example")) {
        return {
          status: "success" as const,
          summary: "Blocked page",
          output: {
            currentUrl: String(request.input.url),
            pageTitle: "Attention Required! | Cloudflare",
            extractedText: "Verify you are human"
          }
        };
      }

      return {
        status: "success" as const,
        summary: "Competitor page",
        output: {
          currentUrl: String(request.input.url),
          pageTitle: "Pricing",
          extractedText: "Dubai EV rental with airport delivery."
        }
      };
    }
  } as unknown as ToolRuntime;

  const agent = new BrowserAgent(toolRuntime, new ModelRouter(), undefined, "live");
  const response = await agent.execute({
    taskId: "task_browser_bootstrap",
    stepId: "s1",
    goal: "调研迪拜新能源租车市场主要玩家",
    context: {},
    successCriteria: [],
    artifacts: []
  });

  assert.equal(response.status, "success");
  assert.deepEqual(callOrder, ["search", "https://blocked.example", "https://success.example"]);
  assert.equal(response.structuredData?.currentUrl, "https://success.example");
  assert.equal(response.structuredData?.bootstrapSearchSummary, "Collected 2 web results");
});

test("browser agent falls back to llm url suggestions when search bootstrap returns no sources", async () => {
  const callOrder: string[] = [];
  const toolRuntime = {
    execute: async (request: {
      input: Record<string, unknown>;
      toolName: ToolName;
      stepId: string;
      taskId: string;
      action: string;
      callerAgent: AgentKind;
    }) => {
      if (request.toolName === ToolName.Search) {
        callOrder.push("search");
        return {
          status: "success" as const,
          summary: "Collected ambiguous web response",
          output: {
            answer: "请先澄清你说的伊朗战争具体范围。"
          }
        };
      }

      callOrder.push(String(request.input.url ?? ""));
      return {
        status: "success" as const,
        summary: "Authority source page",
        output: {
          currentUrl: String(request.input.url),
          pageTitle: "Middle East live coverage",
          extractedText: "Latest timeline and official statements."
        }
      };
    }
  } as unknown as ToolRuntime;
  const llmClient = {
    isConfigured: () => true,
    generateJson: async () => ({
      id: "resp_browser_synthesis",
      model: "gpt-5-mini-2025-08-07",
      outputText: "",
      raw: {},
      data: {
        summary: "已通过权威来源页面提取最新局势摘要",
        currentUrl: "https://www.reuters.com/world/middle-east/",
        pageTitle: "Middle East live coverage",
        evidencePoints: ["权威来源页面可访问"],
        extractedFacts: ["页面包含最新动态与时间轴线索"],
        nextQuestions: []
      }
    }),
    generateText: async () => ({
      id: "resp_browser_url_fallback",
      model: "gpt-5-mini-2025-08-07",
      outputText: [
        "https://www.reuters.com/world/middle-east/",
        "https://www.bbc.com/news/world-middle-east-14541327"
      ].join("\n"),
      raw: {}
    })
  } as const;

  const agent = new BrowserAgent(toolRuntime, new ModelRouter(), llmClient as never, "live");
  const response = await agent.execute({
    taskId: "task_browser_llm_fallback",
    stepId: "s1",
    goal: "TASK: 做一个关于伊朗战争的最新简报带时间轴,输出pdf",
    context: {
      currentStep: {
        title: "收集最新局势与时间轴素材",
        objective: "检索权威公开来源，汇总伊朗战争相关的最新动态与时间轴素材"
      }
    },
    successCriteria: [],
    artifacts: []
  });

  assert.equal(response.status, "success");
  assert.deepEqual(callOrder, [
    "search",
    "https://www.reuters.com/world/middle-east/"
  ]);
  assert.match(String(response.structuredData?.bootstrapSearchSummary ?? ""), /llm_url_fallback/);
  assert.equal(
    response.structuredData?.currentUrl,
    "https://www.reuters.com/world/middle-east/"
  );
});

test("browser agent recovers from malformed synthesis json in live mode", async () => {
  let recoveryCalled = 0;
  const toolRuntime = {
    execute: async () => ({
      status: "success" as const,
      summary: "Authority source page",
      output: {
        currentUrl: "https://apnews.com/article/example",
        pageTitle: "Iran latest updates",
        extractedText: "Timeline and latest developments."
      },
      artifacts: ["/tmp/browser.png"]
    })
  } as unknown as ToolRuntime;
  const llmClient = {
    isConfigured: () => true,
    generateJson: async () => {
      throw new Error("Unterminated string in JSON at position 4235");
    },
    generateText: async () => {
      recoveryCalled += 1;
      return {
        id: "resp_browser_recovery",
        model: "gpt-5-mini-2025-08-07",
        outputText: `{
  "summary":"Recovered browser synthesis",
  "currentUrl":"https://apnews.com/article/example",
  "pageTitle":"Iran latest updates",
  "evidencePoints":["Authoritative page available"],
  "extractedFacts":"Timeline and latest developments",
  "nextQuestions":[]
}`,
        raw: {}
      };
    }
  } as const;

  const agent = new BrowserAgent(toolRuntime, new ModelRouter(), llmClient as never, "live");
  const response = await agent.execute({
    taskId: "task_browser_recovery",
    stepId: "s1",
    goal: "TASK: 做一个关于伊朗战争的最新简报带时间轴,输出pdf",
    context: {
      topResultUrl: "https://apnews.com/article/example"
    },
    successCriteria: [],
    artifacts: []
  });

  assert.equal(recoveryCalled, 1);
  assert.equal(response.status, "success");
  assert.equal(response.summary, "Recovered browser synthesis");
  assert.deepEqual(response.structuredData?.extractedFacts, ["Timeline and latest developments"]);
  assert.equal(response.artifacts?.[0], "/tmp/browser.png");
});

test("browser agent falls back to rule-based synthesis when json recovery also fails", async () => {
  const toolRuntime = {
    execute: async () => ({
      status: "success" as const,
      summary: "Authority source page",
      output: {
        currentUrl: "https://apnews.com/article/example",
        pageTitle: "Iran latest updates",
        extractedText:
          "Latest timeline and official statements.\nRegional tensions remain elevated with new retaliatory rhetoric."
      },
      artifacts: ["/tmp/browser.png"]
    })
  } as unknown as ToolRuntime;
  const llmClient = {
    isConfigured: () => true,
    generateJson: async () => {
      throw new Error("Unterminated string in JSON at position 4235");
    },
    generateText: async () => {
      throw new Error("Unexpected token in recovery output");
    }
  } as const;

  const agent = new BrowserAgent(toolRuntime, new ModelRouter(), llmClient as never, "live");
  const response = await agent.execute({
    taskId: "task_browser_rule_fallback",
    stepId: "s1",
    goal: "TASK: 做一个关于伊朗战争的最新简报带时间轴,输出pdf",
    context: {
      topResultUrl: "https://apnews.com/article/example"
    },
    successCriteria: [],
    artifacts: []
  });

  assert.equal(response.status, "success");
  assert.equal(response.structuredData?.synthesisFallbackUsed, true);
  assert.match(String(response.structuredData?.synthesisFallbackReason ?? ""), /browser_json_recovery_failed/);
  assert.equal(response.structuredData?.currentUrl, "https://apnews.com/article/example");
  assert.equal(response.artifacts?.[0], "/tmp/browser.png");
});

test("research agent fails in live mode when LLM synthesis errors are not parse-related", async () => {
  const toolRuntime = {
    execute: async () => ({
      status: "success" as const,
      summary: "Collected market sources",
      output: {
        answer: "Competitor pricing collected from live sources.",
        results: [{ url: "https://source.example", title: "Source" }]
      }
    })
  } as unknown as ToolRuntime;
  const llmClient = {
    isConfigured: () => true,
    generateJson: async () => {
      throw new Error("upstream timeout");
    }
  } as const;

  const agent = new ResearchAgent(toolRuntime, new ModelRouter(), llmClient as never, "live");
  const response = await agent.execute({
    taskId: "task_research_live_failure",
    stepId: "s1",
    goal: "调研迪拜新能源租车市场",
    context: {},
    successCriteria: [],
    artifacts: []
  });

  assert.equal(response.status, "failed");
  assert.equal(response.summary, "research synthesis failed");
  assert.equal(response.structuredData?.stage, "research");
  assert.match(String(response.error?.message), /research synthesis failed: upstream timeout/);
});

test("research agent returns retryable tool failure in live mode when search fails", async () => {
  const toolRuntime = {
    execute: async () => ({
      status: "failed" as const,
      summary: "OpenAI web search failed: This operation was aborted",
      error: {
        code: ErrorCode.NetworkError,
        message: "OpenAI web search failed: This operation was aborted",
        retryable: true
      }
    })
  } as unknown as ToolRuntime;

  const agent = new ResearchAgent(toolRuntime, new ModelRouter(), undefined, "live");
  const response = await agent.execute({
    taskId: "task_research_search_failure",
    stepId: "s1",
    goal: "TASK: 生成《伊朗战情简报（最新72小时）》中文可转发版",
    context: {
      currentStep: {
        objective: "Collect source-backed information needed to complete: 伊朗战情简报（最新72小时）"
      }
    },
    successCriteria: [],
    artifacts: []
  });

  assert.equal(response.status, "failed");
  assert.equal(response.summary, "OpenAI web search failed: This operation was aborted");
  assert.equal(response.structuredData?.stage, "research_search");
  assert.equal(response.error?.retryable, true);
});

test("research agent recovers from malformed synthesis json in live mode", async () => {
  let recoveryCalled = 0;
  const toolRuntime = {
    execute: async () => ({
      status: "success" as const,
      summary: "Collected market sources",
      output: {
        answer: "Competitor pricing collected from live sources.",
        results: [{ url: "https://source.example", title: "Source" }]
      }
    })
  } as unknown as ToolRuntime;
  const llmClient = {
    isConfigured: () => true,
    generateJson: async () => {
      throw new Error("Unterminated string in JSON at position 42");
    },
    generateText: async () => {
      recoveryCalled += 1;
      return {
        id: "resp_recovery_success",
        model: "gpt-5-mini-2025-08-07",
        outputText: `{
  "summary":"Recovered synthesis",
  "topResultUrl":"https://source.example",
  "findings":["第一条发现
第二行"],
  "marketSignals":"Airport demand is rising",
  "coverageGaps":[]
}`,
        raw: {}
      };
    }
  } as const;

  const agent = new ResearchAgent(toolRuntime, new ModelRouter(), llmClient as never, "live");
  const response = await agent.execute({
    taskId: "task_research_recovery_success",
    stepId: "s1",
    goal: "调研迪拜新能源租车市场",
    context: {},
    successCriteria: [],
    artifacts: []
  });

  assert.equal(recoveryCalled, 1);
  assert.equal(response.status, "success");
  assert.equal(response.summary, "Recovered synthesis");
  assert.equal(response.structuredData?.topResultUrl, "https://source.example");
  assert.deepEqual(response.structuredData?.findings, ["第一条发现\n第二行"]);
  assert.deepEqual(response.structuredData?.marketSignals, ["Airport demand is rising"]);
});

test("research agent normalizes nested list-like fields during malformed synthesis recovery", async () => {
  const toolRuntime = {
    execute: async () => ({
      status: "success" as const,
      summary: "Collected market sources",
      output: {
        answer: "Collected live research notes.",
        results: [{ url: "https://source.example", title: "Source", snippet: "Airport demand remains strong." }]
      }
    })
  } as unknown as ToolRuntime;
  const llmClient = {
    isConfigured: () => true,
    generateJson: async () => {
      throw new Error("Unterminated string in JSON at position 42");
    },
    generateText: async () => ({
      id: "resp_recovery_nested_fields",
      model: "gpt-5-mini-2025-08-07",
      outputText: `{
  "summary":"Recovered synthesis",
  "topResultUrl":"https://source.example",
  "findings":[{"text":"Regulatory scope spans cosmetics and related imports."}],
  "marketSignals":{"primary":"Airport demand is rising","secondary":["Luxury gifting","Tourism traffic"]},
  "coverageGaps":{"items":["Need current free-zone fee quotes"]}
}`,
      raw: {}
    })
  } as const;

  const agent = new ResearchAgent(toolRuntime, new ModelRouter(), llmClient as never, "live");
  const response = await agent.execute({
    taskId: "task_research_nested_recovery",
    stepId: "s1",
    goal: "调研迪拜新能源租车市场",
    context: {},
    successCriteria: [],
    artifacts: []
  });

  assert.equal(response.status, "success");
  assert.deepEqual(response.structuredData?.findings, [
    "Regulatory scope spans cosmetics and related imports."
  ]);
  assert.deepEqual(response.structuredData?.marketSignals, [
    "Airport demand is rising",
    "Luxury gifting",
    "Tourism traffic"
  ]);
  assert.deepEqual(response.structuredData?.coverageGaps, ["Need current free-zone fee quotes"]);
});

test("research agent falls back to rule-based synthesis when malformed recovery lacks schema fields", async () => {
  let recoveryCalled = 0;
  const toolRuntime = {
    execute: async () => ({
      status: "success" as const,
      summary: "Collected market sources",
      output: {
        answer: "Competitor pricing collected from live sources.",
        results: [{ url: "https://source.example", title: "Source" }]
      }
    })
  } as unknown as ToolRuntime;
  const llmClient = {
    isConfigured: () => true,
    generateJson: async () => {
      throw new Error("Unterminated string in JSON at position 42");
    },
    generateText: async () => {
      recoveryCalled += 1;
      return {
        id: "resp_recovery_failure",
        model: "gpt-5-mini-2025-08-07",
        outputText: `{"summary":"still bad"}`,
        raw: {}
      };
    }
  } as const;

  const agent = new ResearchAgent(toolRuntime, new ModelRouter(), llmClient as never, "live");
  const response = await agent.execute({
    taskId: "task_research_recovery_failure",
    stepId: "s1",
    goal: "调研迪拜新能源租车市场",
    context: {},
    successCriteria: [],
    artifacts: []
  });

  assert.equal(recoveryCalled, 1);
  assert.equal(response.status, "success");
  assert.equal(response.structuredData?.synthesisFallbackUsed, true);
  assert.match(
    String(response.structuredData?.synthesisFallbackReason ?? ""),
    /research_json_recovery_failed/
  );
  assert.ok(Array.isArray(response.structuredData?.findings));
  assert.ok((response.structuredData?.findings as string[]).length > 0);
});

test("research agent falls back to rule-based synthesis when json recovery remains unusable", async () => {
  let recoveryCalled = 0;
  const toolRuntime = {
    execute: async () => ({
      status: "success" as const,
      summary: "Collected market sources",
      output: {
        answer:
          "MOHAP registration applies to cosmetics sold in the UAE. Free-zone incorporation often reduces setup friction.",
        results: [
          {
            url: "https://u.ae/example",
            title: "UAE customs and import guidance",
            snippet: "Federal guidance covers customs, import and compliance requirements."
          },
          {
            url: "https://freezone.example",
            title: "Free zone setup guide",
            snippet: "Free-zone structures can streamline setup and visa sponsorship."
          }
        ]
      }
    })
  } as unknown as ToolRuntime;
  const llmClient = {
    isConfigured: () => true,
    generateJson: async () => {
      throw new Error("Unterminated string in JSON at position 42");
    },
    generateText: async () => {
      recoveryCalled += 1;
      return {
        id: "resp_recovery_unusable",
        model: "gpt-5-mini-2025-08-07",
        outputText: "not valid json at all",
        raw: {}
      };
    }
  } as const;

  const agent = new ResearchAgent(toolRuntime, new ModelRouter(), llmClient as never, "live");
  const response = await agent.execute({
    taskId: "task_research_rule_fallback",
    stepId: "s1",
    goal: "调研在阿联酋开设香水制造公司的可行性与落地路径",
    context: {},
    successCriteria: [],
    artifacts: []
  });

  assert.equal(recoveryCalled, 1);
  assert.equal(response.status, "success");
  assert.equal(response.structuredData?.synthesisFallbackUsed, true);
  assert.match(String(response.structuredData?.synthesisFallbackReason ?? ""), /research_json_recovery_failed/);
  assert.equal(response.structuredData?.topResultUrl, "https://u.ae/example");
  assert.ok(Array.isArray(response.structuredData?.findings));
  assert.ok((response.structuredData?.findings as string[]).length > 0);
});

test("research agent rejects zero-source output in live mode after successful synthesis", async () => {
  const toolRuntime = {
    execute: async () => ({
      status: "success" as const,
      summary: "Collected market sources",
      output: {
        answer: "Search completed but returned no links.",
        results: []
      }
    })
  } as unknown as ToolRuntime;
  const llmClient = {
    isConfigured: () => true,
    generateJson: async () => ({
      data: {
        summary: "Research complete",
        topResultUrl: "",
        findings: ["Demand remains elevated around airports."],
        marketSignals: [],
        coverageGaps: []
      }
    })
  } as const;

  const agent = new ResearchAgent(toolRuntime, new ModelRouter(), llmClient as never, "live");
  const response = await agent.execute({
    taskId: "task_research_zero_sources",
    stepId: "s1",
    goal: "调研迪拜新能源租车市场",
    context: {},
    successCriteria: [],
    artifacts: []
  });

  assert.equal(response.status, "failed");
  assert.equal(response.summary, "research quality guardrail failed");
  assert.equal(response.structuredData?.stage, "research_quality_guardrail");
  assert.deepEqual(response.structuredData?.qualitySignals, ["sourceCount=0 in live mode"]);
  assert.match(String(response.error?.message), /sourceCount=0 in live mode/);
});

test("research agent rejects synthetic findings in live mode when live synthesis is unavailable", async () => {
  const toolRuntime = {
    execute: async () => ({
      status: "success" as const,
      summary: "Collected market sources",
      output: {
        answer: "Synthetic search answer for 调研迪拜新能源租车市场",
        results: [{ url: "https://example.com/mock-competitor", title: "Source" }]
      }
    })
  } as unknown as ToolRuntime;
  const llmClient = {
    isConfigured: () => false
  } as const;

  const agent = new ResearchAgent(toolRuntime, new ModelRouter(), llmClient as never, "live");
  const response = await agent.execute({
    taskId: "task_research_synthetic_marker",
    stepId: "s1",
    goal: "调研迪拜新能源租车市场",
    context: {},
    successCriteria: [],
    artifacts: []
  });

  assert.equal(response.status, "failed");
  assert.equal(response.summary, "research quality guardrail failed");
  assert.equal(response.structuredData?.stage, "research_quality_guardrail");
  assert.deepEqual(response.structuredData?.qualitySignals, ["findings contain synthetic marker"]);
  assert.match(String(response.error?.message), /findings contain synthetic marker/);
});

test("research agent rejects failed tool fallback with zero sources in live mode", async () => {
  const toolRuntime = {
    execute: async () => ({
      status: "failed" as const,
      summary: "OpenAI web search failed: timeout",
      error: {
        code: ErrorCode.NetworkError,
        message: "OpenAI web search failed: timeout",
        retryable: true
      }
    })
  } as unknown as ToolRuntime;

  const agent = new ResearchAgent(toolRuntime, new ModelRouter(), undefined, "live");
  const response = await agent.execute({
    taskId: "task_research_tool_failure",
    stepId: "s1",
    goal: "调研迪拜新能源租车市场",
    context: {},
    successCriteria: [],
    artifacts: []
  });

  assert.equal(response.status, "failed");
  assert.equal(response.summary, "OpenAI web search failed: timeout");
  assert.equal(response.structuredData?.stage, "research_search");
  assert.equal(response.error?.retryable, true);
  assert.match(String(response.error?.message), /OpenAI web search failed: timeout/);
});

test("document agent fails in live mode when LLM synthesis errors", async () => {
  let renderCalled = false;
  const toolRuntime = {
    execute: async () => {
      renderCalled = true;
      return {
        status: "success" as const,
        summary: "Rendered markdown document",
        artifacts: ["/tmp/report.md"]
      };
    }
  } as unknown as ToolRuntime;
  const llmClient = {
    isConfigured: () => true,
    generateJson: async () => {
      throw new Error("model output invalid");
    }
  } as const;

  const agent = new DocumentAgent(toolRuntime, new ModelRouter(), llmClient as never, "live");
  const response = await agent.execute({
    taskId: "task_document_live_failure",
    stepId: "s2",
    goal: "生成包含来源链接的报告",
    context: {
      previousStepSummaries: ["发现 A", "发现 B"]
    },
    successCriteria: [],
    artifacts: []
  });

  assert.equal(renderCalled, false);
  assert.equal(response.status, "failed");
  assert.equal(response.summary, "document synthesis failed");
  assert.equal(response.structuredData?.stage, "document");
  assert.match(String(response.error?.message), /document synthesis failed: model output invalid/);
});

test("document agent falls back to local rendering on quota-style llm failure", async () => {
  let renderCalled = false;
  const toolRuntime = {
    execute: async () => {
      renderCalled = true;
      return {
        status: "success" as const,
        summary: "Rendered markdown document",
        artifacts: ["/tmp/report.md"]
      };
    }
  } as unknown as ToolRuntime;
  const llmClient = {
    isConfigured: () => true,
    generateJson: async () => {
      throw new Error("OpenAI Responses API error (429): insufficient_quota");
    }
  } as const;

  const agent = new DocumentAgent(toolRuntime, new ModelRouter(), llmClient as never, "live");
  const response = await agent.execute({
    taskId: "task_document_quota_fallback",
    stepId: "s2",
    goal: "生成 markdown 摘要",
    context: {
      previousStepSummaries: ["发现 A", "发现 B"]
    },
    successCriteria: [],
    artifacts: []
  });

  assert.equal(response.status, "success");
  assert.equal(renderCalled, true);
  assert.equal(response.structuredData?.llmFallbackUsed, true);
  assert.equal(response.structuredData?.llmFallbackCategory, "quota");
  assert.match(String(response.structuredData?.llmFallbackReason), /insufficient_quota/);
  assert.equal(response.summary, "OpenAI 配额不足，已切换到本地文档 fallback");
});

test("document agent rejects placeholder output in live mode", async () => {
  let renderCalled = false;
  const toolRuntime = {
    execute: async () => {
      renderCalled = true;
      return {
        status: "success" as const,
        summary: "Rendered markdown document",
        artifacts: ["/tmp/report.md"]
      };
    }
  } as unknown as ToolRuntime;
  const llmClient = {
    isConfigured: () => true,
    generateJson: async () => ({
      data: {
        summary: "Drafted report",
        title: "竞品报告",
        markdownBody: "## Key Findings\n- Placeholder source: https://example.com/mock-competitor",
        keySections: ["Key Findings"]
      }
    })
  } as const;

  const agent = new DocumentAgent(toolRuntime, new ModelRouter(), llmClient as never, "live");
  const response = await agent.execute({
    taskId: "task_document_guardrail",
    stepId: "s3",
    goal: "生成包含来源链接的竞品报告",
    context: {
      previousStepSummaries: ["发现 A"]
    },
    successCriteria: [],
    artifacts: []
  });

  assert.equal(renderCalled, false);
  assert.equal(response.status, "failed");
  assert.equal(response.structuredData?.stage, "document_quality_guardrail");
  assert.match(
    String(response.error?.message),
    /document_quality_guardrail failed: contains mock placeholder URL/
  );
});

test("document agent exposes a report preview for downstream verification", async () => {
  const toolRuntime = {
    execute: async () => ({
      status: "success" as const,
      summary: "Rendered markdown document",
      artifacts: ["/tmp/report.md"]
    })
  } as unknown as ToolRuntime;

  const agent = new DocumentAgent(toolRuntime, new ModelRouter(), undefined, "mock");
  const response = await agent.execute({
    taskId: "task_document_preview",
    stepId: "s2",
    goal: "生成一份中文简报",
    context: {
      previousStepSummaries: ["第一条摘要", "第二条摘要"]
    },
    successCriteria: [],
    artifacts: []
  });

  assert.equal(response.status, "success");
  assert.equal(typeof response.structuredData?.title, "string");
  assert.match(String(response.structuredData?.reportPreview ?? ""), /第一条摘要/);
});

test("verifier accepts pdf export steps when pdf artifact and preview evidence are present", async () => {
  const verifier = new VerifierAgent(new ModelRouter(), undefined, "mock");

  const decision = await verifier.verifyStep(
    {
      id: "task_pdf_verification",
      userId: "tester",
      goal: "TASK: 生成简报并导出 PDF",
      status: TaskStatus.Running,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentPlanVersion: 1,
      plan: {
        goal: "TASK: 生成简报并导出 PDF",
        assumptions: [],
        steps: [],
        taskSuccessCriteria: ["生成 PDF"]
      },
      steps: []
    },
    {
      id: "step3",
      title: "导出 PDF",
      agent: AgentKind.Coding,
      objective: "将 Markdown 简报排版并导出为 PDF",
      dependsOn: ["step2"],
      status: StepStatus.Running,
      retryCount: 0,
      successCriteria: ["生成 PDF 交付物"],
      inputArtifacts: [],
      outputArtifacts: [],
      structuredData: {}
    },
    {
      status: "success",
      summary: "Exported PDF via DocumentTool",
      artifacts: ["/tmp/brief.pdf"],
      structuredData: {
        reportPreview: "## 摘要\n- 第一条\n- 第二条",
        keySections: ["摘要", "时间轴"],
        generatedFiles: ["/tmp/brief.pdf"]
      }
    }
  );

  assert.equal(decision.verdict, "pass");
  assert.equal(Array.isArray(decision.missingCriteria), true);
});

test("verifier allows browser steps to reuse prior timeline evidence", async () => {
  const verifier = new VerifierAgent(new ModelRouter(), undefined, "mock");

  const decision = await verifier.verifyStep(
    {
      id: "task_browser_timeline_reuse",
      userId: "tester",
      goal: "TASK: 做一个关于伊朗战争的最新简报带时间轴",
      status: TaskStatus.Running,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentPlanVersion: 1,
      plan: {
        goal: "TASK: 做一个关于伊朗战争的最新简报带时间轴",
        assumptions: [],
        steps: [],
        taskSuccessCriteria: ["生成带时间轴的简报"]
      },
      steps: [
        {
          id: "step1",
          title: "收集时间轴",
          agent: AgentKind.Research,
          objective: "先收集上游研究时间线",
          dependsOn: [],
          status: StepStatus.Completed,
          retryCount: 0,
          successCriteria: [],
          inputArtifacts: [],
          outputArtifacts: [],
          structuredData: {
            timelineEvents: [
              {
                date: "2026-03-01",
                event: "event",
                sourceUrl: "https://example.com/source"
              }
            ]
          }
        }
      ]
    },
    {
      id: "step2",
      title: "Inspect source evidence",
      agent: AgentKind.Browser,
      objective: "Inspect candidate web pages for the latest conflict evidence",
      dependsOn: ["step1"],
      status: StepStatus.Running,
      retryCount: 0,
      successCriteria: ["A page was extracted"],
      inputArtifacts: [],
      outputArtifacts: [],
      structuredData: {}
    },
    {
      status: "success",
      summary: "Inspected follow-up sources",
      artifacts: ["/tmp/page.png"],
      structuredData: {
        sources: [
          {
            title: "Example source",
            url: "https://example.com/source",
            snippet: "updated evidence",
            tier: "tier1"
          },
          {
            title: "Second source",
            url: "https://example.com/source-2",
            snippet: "additional evidence",
            tier: "tier2"
          },
          {
            title: "Third source",
            url: "https://example.com/source-3",
            snippet: "supporting evidence",
            tier: "tier2"
          }
        ],
        extractedFacts: ["An updated fact from the browser step."],
        sourceUrls: [
          "https://example.com/source",
          "https://example.com/source-2",
          "https://example.com/source-3"
        ]
      }
    }
  );

  assert.equal(decision.verdict, "pass");
  assert.ok(!(decision.qualityDefects ?? []).includes("timeline evidence missing"));
});

test("verifier only requires timeline events when the quality profile explicitly asks for them", async () => {
  const verifier = new VerifierAgent(new ModelRouter(), undefined, "mock");

  const decision = await verifier.verifyStep(
    {
      id: "task_feasibility_verifier",
      userId: "tester",
      goal: "TASK: 调研在阿联酋开设香水制造公司的可行性与落地路径，输出可执行报告。要求包含监管、设立路径、成本模型、供应链、渠道、时间线、风险与来源。",
      status: TaskStatus.Running,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentPlanVersion: 1,
      plan: {
        goal: "TASK: 调研在阿联酋开设香水制造公司的可行性与落地路径，输出可执行报告。要求包含监管、设立路径、成本模型、供应链、渠道、时间线、风险与来源。",
        assumptions: [],
        steps: [],
        taskSuccessCriteria: ["生成报告"]
      },
      steps: []
    },
    {
      id: "s1",
      title: "Research source-backed information",
      agent: AgentKind.Research,
      objective: "Collect source-backed feasibility evidence",
      dependsOn: [],
      status: StepStatus.Running,
      retryCount: 0,
      successCriteria: ["At least one relevant source found"],
      inputArtifacts: [],
      outputArtifacts: [],
      structuredData: {},
      taskClass: TaskClass.ResearchBrowser,
      qualityProfile: {
        requiredEvidence: ["sources", "findings"],
        minSourceCount: 4,
        requireOutputReadable: true,
        requireSchemaValid: true
      }
    },
    {
      status: "success",
      summary: "Collected feasibility evidence",
      artifacts: [],
      structuredData: {
        sources: [
          "https://example.com/source-1",
          "https://example.com/source-2",
          "https://example.com/source-3",
          "https://example.com/source-4"
        ],
        sourceCount: 4,
        findings: ["监管要求", "设立路径", "成本模型"]
      }
    }
  );

  assert.equal(decision.verdict, "pass");
  assert.ok(!(decision.qualityDefects ?? []).includes("timeline evidence missing"));
  assert.ok(!(decision.missingEvidence ?? []).includes("timelineEvents"));
});

test("coding agent falls back to local python draft on quota-style llm failure", async () => {
  let pythonCalled = false;
  const toolRuntime = {
    execute: async () => {
      pythonCalled = true;
      return {
        status: "success" as const,
        summary: "Executed python script",
        artifacts: ["/tmp/coding.py", "/tmp/coding-output.json"],
        output: {
          stdout: "{\"generated\":[\"coding-output.json\"]}",
          stderr: "",
          generatedFiles: ["/tmp/coding-output.json"],
          scriptPath: "/tmp/coding.py"
        }
      };
    }
  } as unknown as ToolRuntime;
  const llmClient = {
    isConfigured: () => true,
    generateJson: async () => {
      throw new Error("OpenAI Responses API error (429): insufficient_quota");
    }
  } as const;

  const agent = new CodingAgent(toolRuntime, new ModelRouter(), llmClient as never, "live");
  const response = await agent.execute({
    taskId: "task_coding_quota_fallback",
    stepId: "s1",
    goal: "用 Python 分析 12, 18, 25, 40 这四个数字，输出 JSON 和 markdown 摘要",
    context: {
      currentStep: {
        id: "s1",
        title: "Run local Python analysis",
        objective: "Use Python in the local sandbox to produce structured results"
      }
    },
    successCriteria: [],
    artifacts: []
  });

  assert.equal(response.status, "success");
  assert.equal(pythonCalled, true);
  assert.equal(response.structuredData?.llmFallbackUsed, true);
  assert.equal(response.structuredData?.llmFallbackCategory, "quota");
  assert.match(String(response.structuredData?.llmFallbackReason), /insufficient_quota/);
  assert.equal(response.summary, "OpenAI 配额不足，已切换到本地 Python fallback");
});

test("coding agent recovers from malformed synthesis json in live mode", async () => {
  let recoveryCalled = 0;
  let executedFilename = "";
  let executedCode = "";
  const toolRuntime = {
    execute: async (request: {
      input: Record<string, unknown>;
    }) => {
      executedFilename = String(request.input.filename ?? "");
      executedCode = String(request.input.code ?? "");
      return {
        status: "success" as const,
        summary: "Executed python script",
        artifacts: ["/tmp/recovered.py", "/tmp/result.json"],
        output: {
          stdout: "{\"generated\":[\"result.json\"]}",
          stderr: "",
          generatedFiles: ["/tmp/result.json"],
          scriptPath: "/tmp/recovered.py"
        }
      };
    }
  } as unknown as ToolRuntime;
  const llmClient = {
    isConfigured: () => true,
    generateJson: async () => {
      throw new Error("Unterminated string in JSON at position 4775");
    },
    generateText: async () => {
      recoveryCalled += 1;
      return {
        id: "resp_coding_recovery",
        model: "gpt-5-mini-2025-08-07",
        outputText: `{
  "summary":"Recovered coding draft",
  "filename":"recovered-task",
  "pythonCode":"print('ok')",
  "expectedArtifacts":"result.json"
}`,
        raw: {}
      };
    }
  } as const;

  const agent = new CodingAgent(toolRuntime, new ModelRouter(), llmClient as never, "live");
  const response = await agent.execute({
    taskId: "task_coding_recovery",
    stepId: "s3",
    goal: "TASK: 用 Python 处理一组数据并输出 JSON",
    context: {
      currentStep: {
        id: "s3",
        title: "Run local Python analysis",
        objective: "Use Python to process the dataset and output JSON"
      }
    },
    successCriteria: [],
    artifacts: []
  });

  assert.equal(recoveryCalled, 1);
  assert.equal(response.status, "success");
  assert.equal(response.summary, "Recovered coding draft");
  assert.equal(executedFilename, "recovered-task");
  assert.match(executedCode, /print\('ok'\)/);
  assert.equal(response.structuredData?.llmFallbackUsed, undefined);
});

test("coding agent falls back to deterministic pdf export when json recovery fails", async () => {
  let executedFilename = "";
  let executedCode = "";
  const toolRuntime = {
    execute: async (request: {
      action: string;
      input: Record<string, unknown>;
    }) => {
      if (request.action === "render_pdf") {
        return {
          status: "failed" as const,
          summary: "render_pdf failed",
          error: {
            code: ErrorCode.ToolUnavailable,
            message: "render_pdf failed",
            retryable: true
          }
        };
      }
      executedFilename = String(request.input.filename ?? "");
      executedCode = String(request.input.code ?? "");
      return {
        status: "success" as const,
        summary: "Executed python script",
        artifacts: ["/tmp/pdf-export.py", "/tmp/brief.pdf", "/tmp/pdf-export.json"],
        output: {
          stdout: "{\"generated\":[\"brief.pdf\",\"pdf-export.json\"]}",
          stderr: "",
          generatedFiles: ["/tmp/brief.pdf", "/tmp/pdf-export.json"],
          scriptPath: "/tmp/pdf-export.py"
        }
      };
    }
  } as unknown as ToolRuntime;
  const llmClient = {
    isConfigured: () => true,
    generateJson: async () => {
      throw new Error("Unterminated string in JSON at position 4775");
    },
    generateText: async () => {
      throw new Error("Unexpected token in recovery output");
    }
  } as const;

  const agent = new CodingAgent(toolRuntime, new ModelRouter(), llmClient as never, "live");
  const response = await agent.execute({
    taskId: "task_coding_pdf_fallback",
    stepId: "s3",
    goal: "TASK: 做一个关于伊朗战争的最新简报带时间轴,输出pdf",
    context: {
      currentStep: {
        id: "s3",
        title: "排版并导出PDF",
        objective: "将简报文稿格式化为适合阅读的版式并输出为PDF文件"
      }
    },
    successCriteria: [],
    artifacts: ["/tmp/report.md"]
  });

  assert.equal(response.status, "success");
  assert.equal(executedFilename, "pdf-export");
  assert.match(executedCode, /reportlab/);
  assert.match(executedCode, /\/tmp\/report\.md/);
  assert.equal(response.summary, "LLM JSON 无效，已切换到本地 PDF fallback");
  assert.equal(response.structuredData?.llmFallbackUsed, true);
  assert.equal(response.structuredData?.llmFallbackCategory, "json_invalid");
  assert.match(String(response.structuredData?.llmFallbackReason), /Unexpected token in recovery output/);
  assert.deepEqual(response.structuredData?.expectedArtifacts, ["brief.pdf", "pdf-export.json"]);
});

test("coding agent prefers uploaded file analysis draft when task context includes uploads", async () => {
  let executedFilename = "";
  let executedCode = "";
  let receivedInputFiles: string[] = [];
  const toolRuntime = {
    execute: async (request: {
      input: Record<string, unknown>;
      inputFiles?: string[];
    }) => {
      executedFilename = String(request.input.filename ?? "");
      executedCode = String(request.input.code ?? "");
      receivedInputFiles = Array.isArray(request.inputFiles) ? request.inputFiles : [];
      return {
        status: "success" as const,
        summary: "Executed python script",
        artifacts: ["/tmp/uploaded-file-analysis.py", "/tmp/coding-output.json", "/tmp/coding-output.md"],
        output: {
          stdout: "{\"generated\":[\"coding-output.json\",\"coding-output.md\"],\"fileCount\":1}",
          stderr: "",
          generatedFiles: ["/tmp/coding-output.json", "/tmp/coding-output.md"],
          scriptPath: "/tmp/uploaded-file-analysis.py",
          inputFiles: ["/tmp/inputs/numbers.csv"]
        }
      };
    }
  } as unknown as ToolRuntime;

  const agent = new CodingAgent(toolRuntime, new ModelRouter(), undefined, "mock");
  const response = await agent.execute({
    taskId: "task_coding_uploaded_files",
    stepId: "s1",
    goal: "TASK: 用 Python 分析上传的 CSV，并输出 JSON 和 markdown 摘要",
    context: {
      currentStep: {
        id: "s1",
        title: "Run local Python analysis",
        objective: "Use Python to analyze uploaded data files"
      },
      uploadedArtifactUris: ["/tmp/uploads/numbers.csv"]
    },
    successCriteria: [],
    artifacts: []
  });

  assert.equal(response.status, "success");
  assert.equal(executedFilename, "uploaded-file-analysis.py");
  assert.match(executedCode, /openpyxl|csv/);
  assert.match(executedCode, /Uploaded File Analysis/);
  assert.deepEqual(receivedInputFiles, ["/tmp/uploads/numbers.csv"]);
  assert.deepEqual(response.structuredData?.inputFiles, ["/tmp/inputs/numbers.csv"]);
});

test("coding agent does not treat non-export steps as pdf export just because the task goal mentions pdf", async () => {
  let renderPdfCalled = false;
  let pythonCalled = false;
  const toolRuntime = {
    execute: async (request: {
      action: string;
      input: Record<string, unknown>;
      inputFiles?: string[];
    }) => {
      if (request.action === "render_pdf") {
        renderPdfCalled = true;
        return {
          status: "success" as const,
          summary: "Rendered PDF",
          artifacts: ["/tmp/brief.pdf"]
        };
      }

      pythonCalled = true;
      return {
        status: "success" as const,
        summary: "Executed python script",
        artifacts: ["/tmp/number_analysis.json", "/tmp/number_summary.md"],
        output: {
          stdout: "{\"status\":\"ok\"}",
          stderr: "",
          generatedFiles: ["/tmp/number_analysis.json", "/tmp/number_summary.md"],
          scriptPath: "/tmp/step1.py",
          inputFiles: ["/tmp/inputs/numbers.csv"]
        }
      };
    }
  } as unknown as ToolRuntime;

  const agent = new CodingAgent(toolRuntime, new ModelRouter(), undefined, "mock");
  const response = await agent.execute({
    taskId: "task_non_pdf_step",
    stepId: "S1",
    goal: "TASK: 使用上传的 CSV 文件，先用 Python 做汇总，再输出 markdown 摘要和 pdf。",
    context: {
      currentStep: {
        id: "S1",
        title: "读取 CSV 并用 Python 生成汇总结果",
        objective: "使用 Python 读取上传的 CSV 文件，提取生成摘要所需的关键信息和统计结果。"
      },
      uploadedArtifactUris: ["/tmp/uploads/numbers.csv"]
    },
    successCriteria: ["CSV 文件被成功读取。", "输出包含基础数据概览。"],
    artifacts: []
  });

  assert.equal(renderPdfCalled, false);
  assert.equal(pythonCalled, true);
  assert.equal(response.status, "success");
});

test("coding agent does not treat analysis steps as pdf export when the step objective echoes the full goal", async () => {
  let renderPdfCalled = false;
  let pythonCalled = false;
  const toolRuntime = {
    execute: async (request: {
      action: string;
      input: Record<string, unknown>;
      inputFiles?: string[];
    }) => {
      if (request.action === "render_pdf") {
        renderPdfCalled = true;
        return {
          status: "success" as const,
          summary: "Rendered PDF",
          artifacts: ["/tmp/brief.pdf"]
        };
      }

      pythonCalled = true;
      return {
        status: "success" as const,
        summary: "Executed python script",
        artifacts: ["/tmp/coding-output.json", "/tmp/coding-output.md"],
        output: {
          stdout: "{\"status\":\"ok\"}",
          stderr: "",
          generatedFiles: ["/tmp/coding-output.json", "/tmp/coding-output.md"],
          scriptPath: "/tmp/step1.py",
          inputFiles: ["/tmp/inputs/sample-sales.csv"]
        }
      };
    }
  } as unknown as ToolRuntime;

  const agent = new CodingAgent(toolRuntime, new ModelRouter(), undefined, "mock");
  const response = await agent.execute({
    taskId: "task_non_pdf_goal_echo",
    stepId: "s1",
    goal: "读取上传的 CSV，输出关键发现、markdown 摘要并导出 PDF",
    context: {
      currentStep: {
        id: "s1",
        title: "Run local Python analysis",
        objective: "Use Python in the local sandbox to produce structured results for: 读取上传的 CSV，输出关键发现、markdown 摘要并导出 PDF"
      },
      uploadedArtifactUris: ["/tmp/uploads/sample-sales.csv"]
    },
    successCriteria: [
      "A Python artifact exists",
      "The sandbox produced at least one useful output file"
    ],
    artifacts: []
  });

  assert.equal(renderPdfCalled, false);
  assert.equal(pythonCalled, true);
  assert.equal(response.status, "success");
});

test("coding agent uses local python replacement flow for direct local pdf text replacement goals", async () => {
  const toolCalls: Array<{ toolName: ToolName; action: string; input: Record<string, unknown> }> = [];
  const toolRuntime = {
    execute: async (request: {
      toolName: ToolName;
      action: string;
      input: Record<string, unknown>;
    }) => {
      toolCalls.push(request);
      return {
        status: "success" as const,
        summary: "Executed local pdf replacement script",
        artifacts: ["/tmp/modified-output.pdf", "/tmp/replacement-result.json"],
        output: {
          stdout: "{\"status\":\"ok\"}",
          stderr: "",
          generatedFiles: ["/tmp/modified-output.pdf", "/tmp/replacement-result.json"],
          scriptPath: "/tmp/pdf-text-replace.py",
          inputFiles: []
        }
      };
    }
  } as unknown as ToolRuntime;

  const agent = new CodingAgent(toolRuntime, new ModelRouter(), undefined, "mock");
  const response = await agent.execute({
    taskId: "task_local_pdf_replace",
    stepId: "s1",
    goal: 'TASK: 把 PDF 文件 /Users/ericesan/.openclaw/media/inbound/sample.pdf 中所有的 "ESAN TRADING FZE" 改成 "aerox space fze"，并输出新文件路径。',
    context: {
      currentStep: {
        id: "s1",
        title: "Modify local PDF text",
        objective:
          "Use local Python to replace the requested text inside the referenced PDF and write a modified PDF plus a manifest with the output path."
      }
    },
    successCriteria: ["A modified PDF artifact exists"],
    artifacts: []
  });

  assert.equal(response.status, "success");
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0]?.toolName, ToolName.Python);
  assert.equal(toolCalls[0]?.action, "run_script");
  assert.match(String(toolCalls[0]?.input.filename ?? ""), /pdf-text-replace/i);
});

test("coding agent exposes generated file previews for downstream verification", async () => {
  const os = await import("node:os");
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-coding-preview-"));
  const jsonPath = path.join(tmpRoot, "number_analysis.json");
  const mdPath = path.join(tmpRoot, "number_summary.md");
  await fs.writeFile(jsonPath, JSON.stringify({ sum: 95, sorted: [12, 18, 25, 40] }, null, 2), "utf8");
  await fs.writeFile(mdPath, "## Key Findings\n- Sum: 95\n- Mean: 23.75\n", "utf8");

  const toolRuntime = {
    execute: async () => ({
      status: "success" as const,
      summary: "Executed python script",
      artifacts: [jsonPath, mdPath],
      output: {
        stdout: "{\"status\":\"ok\"}",
        stderr: "",
        generatedFiles: [jsonPath, mdPath],
        scriptPath: path.join(tmpRoot, "step1.py"),
        inputFiles: []
      }
    })
  } as unknown as ToolRuntime;

  const agent = new CodingAgent(toolRuntime, new ModelRouter(), undefined, "mock");
  const response = await agent.execute({
    taskId: "task_coding_preview",
    stepId: "step1",
    goal: "TASK: 用 Python 分析 12, 18, 25, 40 并输出 JSON 和 markdown 摘要。",
    context: {
      currentStep: {
        title: "用 Python 计算数字分析结果",
        objective: "编写并运行 Python 逻辑，对 12、18、25、40 进行基础数值分析，并生成结构化结果。"
      }
    },
    successCriteria: [],
    artifacts: []
  });

  assert.equal(response.status, "success");
  assert.match(String(response.structuredData?.reportPreview ?? ""), /95/);
  assert.equal(Array.isArray(response.structuredData?.keySections), true);
  const generatedFilePreviews = Array.isArray(response.structuredData?.generatedFilePreviews)
    ? response.structuredData.generatedFilePreviews
    : [];
  assert.equal(
    generatedFilePreviews.some((preview) =>
      typeof preview === "object" &&
      preview !== null &&
      "preview" in preview &&
      typeof preview.preview === "string" &&
      preview.preview.includes("Key Findings")
    ),
    true
  );
  assert.equal(Array.isArray(response.structuredData?.generatedFilePreviews), true);
});

test("context builder exposes research candidate urls to downstream browser steps", () => {
  const store = new InMemoryMemoryStore();
  const builder = new ContextBuilder(store);
  const profile: UserProfile = {
    userId: "user_context",
    language: "zh-CN",
    outputStyle: "concise",
    riskPolicy: "balanced",
    preferences: {},
    updatedAt: new Date().toISOString()
  };

  const context = builder.buildStepContext(
    {
      id: "task_context",
      userId: "user_context",
      goal: "调研竞品官网",
      status: TaskStatus.Running,
      currentPlanVersion: 1,
      plan: {
        goal: "调研竞品官网",
        assumptions: [],
        steps: [],
        taskSuccessCriteria: []
      },
      steps: [
        {
          id: "s1",
          title: "research",
          agent: AgentKind.Research,
          objective: "collect sources",
          dependsOn: [],
          successCriteria: [],
          status: StepStatus.Completed,
          retryCount: 0,
          inputArtifacts: [],
          structuredData: {
            topResultUrl: "https://top.example",
            candidateSourceUrls: ["https://top.example", "https://alt.example"]
          },
          outputArtifacts: [],
          summary: "research done"
        },
        {
          id: "s2",
          title: "browser",
          agent: AgentKind.Browser,
          objective: "browse site",
          dependsOn: ["s1"],
          successCriteria: [],
          status: StepStatus.Pending,
          retryCount: 0,
          inputArtifacts: [],
          structuredData: {},
          outputArtifacts: []
        }
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    {
      id: "s2",
      title: "browser",
      agent: AgentKind.Browser,
      objective: "browse site",
      dependsOn: ["s1"],
      successCriteria: [],
      status: StepStatus.Pending,
      retryCount: 0,
      inputArtifacts: [],
      structuredData: {},
      outputArtifacts: []
    },
    profile,
    []
  );

  assert.deepEqual(context["browserCandidateUrls"], [
    "https://top.example",
    "https://alt.example"
  ]);
  assert.equal(context["topResultUrl"], "https://top.example");
});
