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
/** ⚠️ 2026-10 第四批（待办 B）：默认值从已停用的 `deepseek-chat` 改成 `deepseek-flash`
 *  （线上有 `AI_MODEL` 覆盖，行为不变；只是把兜底的名字修对）。 */
const DEFAULT_MODEL = "deepseek-flash";

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
/** 「错因润色」一次最多几段（与前端 `wrongItems.slice(0, 60)` 对齐；超了拒绝而不是截断） */
const MAX_PARAGRAPHS = 60;

/**
 * ★ 2026-10 第五批：「错因润色」的提示词。
 *
 * 背景（用户 2026-10 提的）：报告里 **【错题分析】那张表的最后一列**（失分情况及原因分析）
 * 是程序按规则生成的**原始**文本，会冒出「能力严重缺失」「知识体系尚未建立」这种**重话**，
 * 直接给家长看很扎人。用户要求：**不只是改通顺，还要把口吻改对** —— 面向家长、措辞温和、**不下定论**。
 *
 * 与 ADVICE_PROMPT 的区别：这一段**不做扩写**，只做「同义改写 + 降调」，
 * 所以 max_tokens 更小、temperature 更低，并且**硬性要求逐段一一对应**（段数是契约）。
 */
const ATTRIBUTION_PROMPT =
  "你是一位有十几年经验的高中数学教师，正在润色《试卷分析表》里「错题分析」表中" +
  "「失分情况及原因分析」这一列的文字。这份表会交给**学生家长**看。\n" +
  "用户会给你若干段「程序按规则生成的原始表述」，请**逐段**改写。\n" +
  "【必须保留】每一段里的全部**事实**：知识点名称、题型、错误类型、失分表现、具体做法要求；" +
  "一个都不能删、不能改、不能新增。不要写分数与题号（原文里没有的就不要加）。\n" +
  "【要改的是口吻】面向家长、客观、专业、**措辞温和**：\n" +
  "1. **不下定论**：不要用「能力严重缺失 / 能力差 / 知识体系尚未建立 / 态度有问题 / 不用心」" +
  "这类给孩子贴标签的说法；改成描述**当前状态 + 可改进**的表述，例如" +
  "「这一块目前还不够稳定」「目前主要卡在……，属于可以通过练习补上的部分」。\n" +
  "2. **不做性格与智力评价**，只谈知识、方法与习惯层面的**具体表现**。\n" +
  "3. 不要用「孩子」这类口语称呼，直接说「该题」「这一部分」或不加主语。\n" +
  "4. 不夸大也不淡化：原文说的是「不熟练」，就不要改写成「完全不会」。\n" +
  "5. 每段控制在 **40–90 字**，一句话说清「错在哪 + 下一步怎么改」。\n" +
  "【输出格式】\n" +
  "· 输入的每一段对应输出的**一行**，**行数必须与输入完全一致、顺序不变**；\n" +
  "· 只输出这些行本身：不要编号、不要题号、不要小标题、不要 markdown 符号（#、*、-）、" +
  "不要引号包裹，也不要解释你在做什么。";

/** 建议段的输出上限。2026-10 由 2800 提到 6000：DeepSeek 思考模式默认开启，会先吐一大段
 *  `reasoning_content` 并**与正文共享** max_tokens，2800 会被思考吃光导致正文为空
 *  （线上实测 reasoningLen=3414）。现已同时关闭思考模式（见 `thinkingDisabled`），
 *  6000 全部留给正文。max_tokens 是上限、按实际用量计费，调大不增加成本。 */
const MAX_TOKENS = 6000;
/** 错因润色是「同义改写」，输出更短，单独给一个小一点的预算（省钱、也更快） */
const ATTR_MAX_TOKENS = 4000;
const TIMEOUT_MS = 60_000;

/** 把模型返回的文本切成非空行（去掉可能的编号、markdown 记号与包裹引号）。
 *  错因润色要的是「**一行一段**」，所以这里必须把模型爱加的 "1." "·" 之类剥掉，
 *  否则段数对得上、内容却带着编号。口径与 `math-plan/ai-sections` 的同名函数一致。 */
function toLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) =>
      line
        .trim()
        .replace(/^```[a-z]*$/i, "")
        .replace(/^[*\-–—•]\s*/, "")
        .replace(/^\d+[.、)]\s*/, "")
        .replace(/^["“”']|["“”']$/g, "")
        .trim(),
    )
    .filter((line) => line.length > 0);
}

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

  // ★ 2026-10 第五批：这个接口现在服务**两件事**，用 `section` 区分：
  //   · 不传 / "advice"      → 老行为（把整个 body 当结构化诊断数据，重写「建议段」）——**一字未改**
  //   · "attribution"        → 新行为（逐段润色【错题分析】表的「原因」列，见 ATTRIBUTION_PROMPT）
  //   ⚠️ 刻意**不新开路由**：VIP 校验、thinking 护栏、错误口径、日志只有一份实现。
  const isAttribution = (body as { section?: unknown }).section === "attribution";

  /** 本次要发给模型的 user 内容 */
  let payload: string;
  /** 错因润色的「段数契约」：返回必须正好这么多行 */
  let attrParagraphs: string[] = [];

  if (isAttribution) {
    const raw = (body as { paragraphs?: unknown }).paragraphs;
    if (!Array.isArray(raw) || raw.some((p) => typeof p !== "string")) {
      return NextResponse.json({ ok: false, error: "错因段落格式不正确（应为字符串数组）。" }, { status: 400 });
    }
    attrParagraphs = raw.map((p) => String(p).trim()).filter((p) => p.length > 0);
    if (!attrParagraphs.length) {
      return NextResponse.json({ ok: false, error: "没有需要润色的错因段落。" }, { status: 400 });
    }
    if (attrParagraphs.length > MAX_PARAGRAPHS) {
      return NextResponse.json(
        { ok: false, error: `一次最多润色 ${MAX_PARAGRAPHS} 段错因，请减少错题数量后重试。` },
        { status: 413 },
      );
    }
    // 只把「段」和少量上下文发过去：不带分数、不带题号（提示词也要求不要写）
    const ctx = (body as { context?: unknown }).context;
    payload = JSON.stringify({
      context: ctx && typeof ctx === "object" && !Array.isArray(ctx) ? ctx : {},
      paragraphs: attrParagraphs,
    });
  } else {
    payload = JSON.stringify(body);
  }

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
          { role: "system", content: isAttribution ? ATTRIBUTION_PROMPT : ADVICE_PROMPT },
          { role: "user", content: payload },
        ],
        // 错因润色是「同义改写 + 降调」，要的是稳定而不是发挥：温度更低、输出更短
        temperature: isAttribution ? 0.3 : 0.7,
        // 6000：见下方 thinking 说明 —— 从前 2800 会被思考过程吃光。
        // max_tokens 是上限、按实际用量计费，调大没有额外成本。
        max_tokens: isAttribution ? ATTR_MAX_TOKENS : MAX_TOKENS,
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

    // ★ 错因润色：**段数必须与输入一致**才接受（否则前端会把这段文案贴到错误的题上）。
    //   ⚠️ 与 math-plan 的 goals 润色同一条理由：宁可让老师重试一次，也不能错位。
    if (isAttribution) {
      const lines = toLines(text);
      if (lines.length !== attrParagraphs.length) {
        console.error(
          `[paper-analysis/ai-advice] 错因段数不匹配：期望 ${attrParagraphs.length} 实际 ${lines.length}`,
        );
        return NextResponse.json(
          { ok: false, error: "AI 返回的段落数与原文不一致，请重试。" },
          { status: 502 },
        );
      }
      return NextResponse.json({ ok: true, section: "attribution", lines });
    }

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
