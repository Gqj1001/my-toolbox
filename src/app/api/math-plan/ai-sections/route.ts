import { NextResponse, type NextRequest } from "next/server";
import { requireVip } from "@/lib/membership";
import { GOAL_EXAMPLES, METHOD_STYLE_BLOCK } from "./samples";

/**
 * 辅导方案生成器：AI 分区润色（会员专属）
 *
 * 与 paper-analysis/ai-advice 同一套安全约定：
 *  1. AI Key 只从 process.env.AI_KEY 读取（服务端），绝不返回给前端
 *  2. 调用前用 requireVip() 做服务端校验：未登录 401 / 封禁 403 / 非会员 403
 *  3. 不把上游错误原文透传（可能包含 key 或账户信息）
 *
 * 只做「润色」：入参是前端已经算好的文案与结构化信息（三轮安排、逐次课表），
 * 提示词明确要求保留全部事实与数字、不得编造。模型不负责计算，也不接触学生原始素材。
 *
 * few-shot（样本见 ./samples.ts）：
 *   · method —— 把 4 份真实老师写的「教学方法」放进 system prompt 作**风格参考**
 *   · goals  —— 用 messages 数组做 few-shot（程序口径课表 → 老师写的目标）
 *   两者都只为让措辞「更像老师自己写的」；事实、数字、条数一律仍以本次入参为准。
 *
 * 入参：
 *   { section: "method", context: { grade, band, score, target, totalHours, rounds, paragraphs: string[] } }
 *   { section: "goals",  context: { grade, band, score, target, lessons: {stage, content, goal}[] } }
 * 返回：
 *   { ok: true, lines: string[] }   —— method 按段落，goals 按行（与入参 lessons 一一对应）
 */

const DEFAULT_BASE = "https://api.deepseek.com/v1";
const DEFAULT_MODEL = "deepseek-chat";

/** 共同约束：保留事实与数字、不编造、只改文风 */
const COMMON_RULE =
  "硬性约束（必须遵守）：\n" +
  "1. 必须保留原文中的全部事实、数字、分数、课时、题量、比例、时间等，一个都不能改、不能删、不能新增。\n" +
  "2. 不得编造原文没有的信息（不要新增学生姓名、学校、分数、教材、考区等）。\n" +
  "3. 只优化措辞与语句衔接，让表达更自然、更专业、更适合给家长看；不要改变原意。\n" +
  "4. 不要输出 markdown 符号、不要编号标题、不要解释你在做什么，直接输出正文。";

const PROMPTS: Record<string, string> = {
  method:
    "你是一位有十几年经验的高中数学教研组长，正在润色一份《辅导方案》里的「教学方法」段落。\n" +
    "用户会给你该段的若干段落纯文本，请逐段润色。\n" +
    COMMON_RULE +
    "\n5. 输出格式：每段一行，段落数量必须与输入完全一致，顺序不变。\n" +
    "6. 每段请以「（N）」开头保留原有的分条编号（若原文是「（1）方案与总量。」这种写法，保留该分条名）。",
  goals:
    "你是一位有十几年经验的高中数学教研组长，正在润色一份《辅导方案》里「逐次课表」的「教学目标」列。\n" +
    "用户会给你每一次课的三项信息：阶段（模块名）、内容、原教学目标。请只润色「教学目标」这一列的文字。\n" +
    COMMON_RULE +
    "\n5. 教学目标必须保持可验收性：原文里的正确率、得分率、用时、分数阈值等量化指标必须原样保留。\n" +
    "6. 输出格式：每行一条，行数必须与输入的课次数完全一致，顺序不变；只输出教学目标本身，不要带上模块名或内容。\n" +
    "7. 前面会给出若干组「示例」，**仅用于示范措辞风格**（怎么把干巴巴的目标写得具体、可验收）。" +
    "输出条数必须严格等于**本次最后一条 user 消息里 lessons 的条数**，" +
    "绝不要照抄示例的条数，也不要照抄示例里的模块名、分数、正确率等具体信息。\n" +
    "8. 示例中的 user/assistant 往返只是格式示范，不要把它当成本次要处理的内容。",
};

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/** method 的 system prompt：润色规则 + 真实老师范例。预先拼成常量，保证前缀逐字节稳定、能命中上游缓存。 */
const METHOD_SYSTEM = PROMPTS.method + METHOD_STYLE_BLOCK;

/**
 * 组装发给上游的 messages。
 *   · method —— 单轮：system（规则 + 风格范例） + user（待润色段落）
 *   · goals  —— few-shot：system + 若干组「程序口径课表 → 老师写的目标」示例 + 本次 user
 * 单独导出是为了让测试能直接断言结构，不必真的连上游。
 */
export function buildMessages(section: "method" | "goals", payload: string): ChatMessage[] {
  if (section === "method") {
    return [
      { role: "system", content: METHOD_SYSTEM },
      { role: "user", content: payload },
    ];
  }
  return [
    { role: "system", content: PROMPTS.goals },
    ...GOAL_EXAMPLES.flatMap((ex): ChatMessage[] => [
      { role: "user", content: JSON.stringify(ex.context) },
      { role: "assistant", content: ex.goals.join("\n") },
    ]),
    { role: "user", content: payload },
  ];
}

const MAX_PAYLOAD = 60_000;
const MAX_TOKENS = 3000;
const MAX_LINES = 200;
const TIMEOUT_MS = 90_000;

/** 把模型返回的文本切成非空行（去掉可能的编号、markdown 记号与包裹引号） */
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
        { ok: false, error: "账号已被封禁，无法使用 AI 润色。" },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { ok: false, error: "AI 润色为会员专属功能，请先开通会员。" },
      { status: 403 },
    );
  }

  // ---------- 2. 服务端配置 ----------
  const apiKey = process.env.AI_KEY;
  if (!apiKey) {
    console.error("[math-plan/ai-sections] 缺少环境变量 AI_KEY");
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
    return NextResponse.json({ ok: false, error: "请求格式不正确。" }, { status: 400 });
  }

  const { section, context } = body as { section?: unknown; context?: unknown };
  if (section !== "method" && section !== "goals") {
    return NextResponse.json(
      { ok: false, error: 'section 只能是 "method" 或 "goals"。' },
      { status: 400 },
    );
  }

  const payload = JSON.stringify(context ?? {});
  if (payload.length < 10) {
    return NextResponse.json({ ok: false, error: "待润色内容为空。" }, { status: 400 });
  }
  if (payload.length > MAX_PAYLOAD) {
    return NextResponse.json({ ok: false, error: "待润色内容过大。" }, { status: 413 });
  }

  // 期望返回的行数（用于校验模型是否偷懒/多写）；拿不到就不校验
  let expectLines = 0;
  if (section === "method") {
    const ps = (context as { paragraphs?: unknown })?.paragraphs;
    if (Array.isArray(ps)) {
      if (!ps.length) {
        return NextResponse.json({ ok: false, error: "待润色段落为空。" }, { status: 400 });
      }
      expectLines = ps.length;
    }
  } else {
    const ls = (context as { lessons?: unknown })?.lessons;
    if (Array.isArray(ls)) {
      if (!ls.length) {
        return NextResponse.json({ ok: false, error: "待润色课表为空。" }, { status: 400 });
      }
      expectLines = ls.length;
    }
  }
  if (expectLines > MAX_LINES) {
    return NextResponse.json({ ok: false, error: "待润色条目过多。" }, { status: 413 });
  }

  // ---------- 4. 调用上游 ----------
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: buildMessages(section, payload),
        temperature: 0.6,
        max_tokens: MAX_TOKENS,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      // 只在服务端记录，不把上游原文透传给前端
      console.error("[math-plan/ai-sections] 上游返回", res.status, (await res.text()).slice(0, 300));
      return NextResponse.json(
        { ok: false, error: "AI 服务暂时不可用，请稍后重试。" },
        { status: 502 },
      );
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content?.trim() ?? "";
    if (!text) {
      return NextResponse.json({ ok: false, error: "AI 返回内容为空，请重试。" }, { status: 502 });
    }

    const lines = toLines(text);
    if (!lines.length) {
      return NextResponse.json({ ok: false, error: "AI 返回内容为空，请重试。" }, { status: 502 });
    }
    // 行数对不上就拒绝，避免前端把错位的文案贴到错误的段落/课上
    if (expectLines && lines.length !== expectLines) {
      console.error(
        `[math-plan/ai-sections] 行数不匹配 section=${section} 期望 ${expectLines} 实际 ${lines.length}`,
      );
      return NextResponse.json(
        { ok: false, error: "AI 返回的条目数与原文不一致，请重试。" },
        { status: 502 },
      );
    }

    return NextResponse.json({ ok: true, section, lines });
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    console.error("[math-plan/ai-sections] 调用失败:", aborted ? "超时" : (e as Error)?.message);
    return NextResponse.json(
      { ok: false, error: aborted ? "AI 响应超时，请重试。" : "AI 服务暂时不可用，请稍后重试。" },
      { status: 502 },
    );
  } finally {
    clearTimeout(timer);
  }
}
