import { NextResponse, type NextRequest } from "next/server";
import { requireVip } from "@/lib/membership";
import {
  readContent,
  reasoningLength,
  thinkingDisabled,
  truncatedByReasoning,
} from "@/lib/deepseek-thinking";

/**
 * 试卷分析：AI 改写「教学辅导建议与安排」段（会员专属）
 *
 * 安全要点（与 feedback/ai 保持一致）：
 *  1. AI Key 只从 process.env.AI_KEY 读取（服务端），绝不返回给前端
 *  2. 调用前用 requireVip() 做服务端校验：未登录 401 / 封禁 403 / 非会员 403
 *  3. 不把上游错误原文透传（可能包含 key 或账户信息）
 *
 * 前端发过来的是**已经算好的结构化诊断数据**（分数、题型得分率、模块失分明细、
 * 逐题失分类型与知识点），我们只做转发 + 提示词，不让模型接触原始试卷、也不让它猜数据。
 */

const DEFAULT_BASE = "https://api.deepseek.com/v1";
const DEFAULT_MODEL = "deepseek-chat";

/**
 * 与老 server.js 的 ADVICE_PROMPT 保持一致（硬编码在服务端，不下发）
 *
 * ⚠️ 2026-10 补充：原文末尾只写「不要标题、不要 markdown 符号」，容易被模型理解为
 *    「不要任何分段/标记」而把正文挤成一大段。这里**显式去掉这个歧义**：
 *    「不要标题」指的是**不要加格式化标题/井号**，**不是**不要分段。
 *    （本接口的输入是 JSON 诊断数据，本来就没有【】这类标记，所以风险低于 feedback，
 *      但把话说清楚没有坏处。）
 */
const ADVICE_PROMPT =
  "你是一位有十几年经验的高中数学教师，正在给学生家长写《试卷分析表》里的「教学辅导建议与安排」。\n" +
  "用户会给你一份已经算好的结构化诊断数据（学生得分、题型得分率、各模块失分明细、逐题失分类型与知识点）。\n" +
  "请严格依据这些数据来写，不要编造数据，不要改动任何分数与题号。\n" +
  "文风要求：先给阶段性定性，再讲优势，然后按题型与模块点出短板与归因，" +
  "最后给分阶段的、可执行的教学安排与预期分数。\n" +
  '要具体到"哪道题、哪个模块、什么原因、下一步怎么做"，多用"首先/其次/第三/第四"这样的层次词，' +
  "篇幅 800–1400 字。\n" +
  "【分段要求】保留原有的段落结构（阶段性定性 / 优势 / 短板与归因 / 教学安排各自成段），" +
  "每段内部自由扩写，不要把多段合并成一大段。\n" +
  "【输出要求】直接输出正文；不要加标题（例如「一、总体评价」这类格式化小标题），" +
  "不要 markdown 符号（#、*、- 等）。" +
  "注意：「不要标题」只是不要加格式化小标题，**不是**不要分段。";

const MAX_PAYLOAD = 40_000;
/** 输出上限。2026-10 由 2800 提到 6000：DeepSeek 思考模式默认开启，会先吐一大段
 *  `reasoning_content` 并**与正文共享** max_tokens，2800 会被思考吃光导致正文为空
 *  （线上实测 reasoningLen=3414）。现已同时关闭思考模式（见 `thinkingDisabled`），
 *  6000 全部留给正文。max_tokens 是上限、按实际用量计费，调大不增加成本。 */
const MAX_TOKENS = 6000;
const TIMEOUT_MS = 60_000;

export async function POST(request: NextRequest) {
  // ---------- 1. 服务端鉴权：必须是有效会员 ----------
  const guard = await requireVip();

  if (!guard.ok) {
    if (guard.reason === "unauthenticated") {
      return NextResponse.json({ ok: false, error: "请先登录。" }, { status: 401 });
    }
    if (guard.reason === "banned") {
      return NextResponse.json(
        { ok: false, error: "账号已被封禁，无法使用 AI 建议。" },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { ok: false, error: "AI 建议为会员专属功能，请先开通会员。" },
      { status: 403 },
    );
  }

  // ---------- 2. 服务端配置 ----------
  const apiKey = process.env.AI_KEY;
  if (!apiKey) {
    console.error("[paper-analysis/ai-advice] 缺少环境变量 AI_KEY");
    return NextResponse.json(
      { ok: false, error: "服务端未配置 AI Key，请联系管理员。" },
      { status: 503 },
    );
  }
  const baseUrl = (process.env.AI_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, "");
  const model = process.env.AI_MODEL ?? DEFAULT_MODEL;

  // ---------- 3. 入参校验 ----------
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON。" }, { status: 400 });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ ok: false, error: "诊断数据格式不正确。" }, { status: 400 });
  }
  const payload = JSON.stringify(body);
  if (payload.length < 10) {
    return NextResponse.json({ ok: false, error: "诊断数据为空。" }, { status: 400 });
  }
  if (payload.length > MAX_PAYLOAD) {
    return NextResponse.json(
      { ok: false, error: "诊断数据过大，请减少错题数量后重试。" },
      { status: 413 },
    );
  }

  // ---------- 4. 调用上游 ----------
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const callUpstream = () =>
    fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: ADVICE_PROMPT },
          { role: "user", content: payload },
        ],
        temperature: 0.7,
        // 6000：见下方 thinking 说明 —— 从前 2800 会被思考过程吃光。
        // max_tokens 是上限、按实际用量计费，调大没有额外成本。
        max_tokens: 6000,
        // 关闭 DeepSeek 思考模式（默认 enabled）。官方：
        // https://api-docs.deepseek.com/guides/thinking_mode/
        // 非 DeepSeek 模型时展开为空对象，不会带上这个专有字段。
        ...thinkingDisabled(model),
      }),
      signal: controller.signal,
    });

  try {
    let res = await callUpstream();

    if (!res.ok) {
      // 只在服务端记录，不把上游原文透传给前端
      console.error("[paper-analysis/ai-advice] 上游返回", res.status, (await res.text()).slice(0, 300));
      return NextResponse.json(
        { ok: false, error: "AI 服务暂时不可用，请稍后重试。" },
        { status: 502 },
      );
    }

    let data = (await res.json()) as {
      choices?: Array<{
        finish_reason?: string;
        message?: { content?: string; reasoning_content?: string };
      }>;
      usage?: Record<string, unknown>;
    };

    // ---------- 兜底重试：思考过程吃光预算 ----------
    // 同 feedback/ai：finish_reason="length" 且 content 空 且 reasoning 非空时，
    // 关掉 thinking 再试一次。刻意不从 reasoning_content 抠答案（那是思考草稿，
    // 含试错，当正文用属于「静默贴错内容」）。
    let retried = false;
    if (truncatedByReasoning(data)) {
      retried = true;
      console.warn(
        "[paper-analysis/ai-advice] 思考过程吃光 max_tokens，关掉 thinking 重试一次 | 诊断:",
        JSON.stringify({
          model,
          reasoningLen: reasoningLength(data),
          inputChars: payload.length,
          usage: data.usage ?? null,
        }),
      );
      res = await callUpstream();
      if (res.ok) {
        data = (await res.json()) as typeof data;
      } else {
        console.error(
          "[paper-analysis/ai-advice] 重试仍失败，上游返回",
          res.status,
          (await res.text()).slice(0, 300),
        );
      }
    }

    const text = readContent(data);
    if (!text) {
      // ⚠️ 与 feedback/ai 同样的诊断缺口：这条分支以前不打日志，
      //    「AI 返回内容为空」在线上无法定位。只记录结构信息，不记录正文与 Key。
      console.error(
        "[paper-analysis/ai-advice] 上游 200 但内容为空 | 诊断:",
        JSON.stringify({
          model,
          retried,
          finish_reason: data.choices?.[0]?.finish_reason ?? null,
          choiceCount: Array.isArray(data.choices) ? data.choices.length : null,
          hasMessage: !!data.choices?.[0]?.message,
          hasReasoningContent: !!data.choices?.[0]?.message?.reasoning_content,
          reasoningLen: reasoningLength(data),
          usage: data.usage ?? null,
          inputChars: payload.length,
        }),
      );
      return NextResponse.json({ ok: false, error: "AI 返回内容为空，请重试。" }, { status: 502 });
    }

    // 成功路径同样留一行低噪声日志，便于与「为空」那几次做对比
    console.log(
      "[paper-analysis/ai-advice] 成功 | 诊断:",
      JSON.stringify({
        model,
        retried,
        finish_reason: data.choices?.[0]?.finish_reason ?? null,
        outChars: text.length,
        reasoningLen: reasoningLength(data),
        completion_tokens: (data.usage as { completion_tokens?: number } | undefined)?.completion_tokens ?? null,
        inputChars: payload.length,
      }),
    );

    return NextResponse.json({ ok: true, text });
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    console.error("[paper-analysis/ai-advice] 调用失败:", aborted ? "超时" : (e as Error)?.message);
    return NextResponse.json(
      { ok: false, error: aborted ? "AI 响应超时，请重试。" : "AI 服务暂时不可用，请稍后重试。" },
      { status: 502 },
    );
  } finally {
    clearTimeout(timer);
  }
}
