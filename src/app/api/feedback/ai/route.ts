import { NextResponse, type NextRequest } from "next/server";
import { requireVip } from "@/lib/membership";
import {
  readContent,
  reasoningLength,
  thinkingDisabled,
  truncatedByReasoning,
} from "@/lib/deepseek-thinking";

/**
 * AI 润色代理（课后反馈工作台专用）
 *
 * 安全要点：
 *  1. AI Key 只从 process.env.AI_KEY 读取（服务端），绝不返回给前端
 *  2. 调用前用 requireVip() 做服务端校验：未登录 401 / 非会员 403
 *  3. 不把上游错误原文透传（可能包含 key 或账户信息）
 */

const DEFAULT_BASE = "https://api.deepseek.com/v1";
const DEFAULT_MODEL = "deepseek-chat";
/**
 * 提示词的**服务端默认值 / 兜底**。
 *
 * ⚠️ 这段文本在**两处**必须逐字一致：
 *    · 这里（服务端：前端没传 prompt 时用它）
 *    · public/tools/feedback.html 的 DEFAULT_PROMPT（前端默认值）
 *    前端通常会把自己那份传过来（`body.prompt`），所以**真正生效的往往是前端那份**；
 *    改一处必须同时改另一处。
 *
 * 措辞要点（2026-10 修「分段被合并 + 几乎没润色」时定的）：
 *   · 必须显式要求「保留分段标记、每个标记独立成段」——旧版只写了「句子更连贯自然」，
 *     模型会把【课堂内容】这类标记当成碎句**合并成一大段**；
 *   · 不要再写「一个都不能改或删」——那会把模型的手绑死，它的安全策略就变成**只换几个字**，
 *     与「扩充 30%~50%」直接冲突。改成「保留核心事实 + 可用更温和专业的说法」。
 */
const DEFAULT_PROMPT = `你是资深高中数学教师，正在给家长写课后反馈。
请把下面的反馈润色扩写：

【结构要求】
- 保留原有的分段标记（如【课堂内容】【课堂表现】【作业】等），每个标记独立成段，不要把多段合并
- 标记本身不能改、不能删、不能合并

【内容要求】
- 每段内部自由扩写、增加细节、调整措辞
- 保留核心事实（分数、知识点、作业内容），但可以用更温和专业的说法
- 语气面向家长、有温度
- 字数扩充 30%~50%

【输出要求】
- 直接输出润色后的正文
- 不要加解释、不要 markdown 符号`;

const MAX_TEXT = 20_000;
const MAX_PROMPT = 4_000;
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
    // 不暴露任何配置细节给前端，只在服务端日志里提示
    console.error("[feedback/ai] 缺少环境变量 AI_KEY");
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

  const raw = (body ?? {}) as { text?: unknown; prompt?: unknown };
  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  const prompt =
    typeof raw.prompt === "string" && raw.prompt.trim() ? raw.prompt.trim() : DEFAULT_PROMPT;

  if (!text) {
    return NextResponse.json({ ok: false, error: "缺少待润色的文本。" }, { status: 400 });
  }
  if (text.length > MAX_TEXT) {
    return NextResponse.json(
      { ok: false, error: `文本过长（${text.length} 字），请控制在 ${MAX_TEXT} 字以内。` },
      { status: 413 },
    );
  }
  if (prompt.length > MAX_PROMPT) {
    return NextResponse.json({ ok: false, error: "提示词过长。" }, { status: 413 });
  }

  // ---------- 4. 调用上游 ----------
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  // 调用上游。每次都带 DeepSeek 的「关闭思考模式」参数
  // （非 DeepSeek 模型时 `thinkingDisabled` 展开成空对象，不会带上专有字段）。
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
          { role: "system", content: prompt },
          { role: "user", content: text },
        ],
        temperature: 0.7,
        // 6000：思考模式关闭后这 6000 全部留给正文；从前 2000 会被思考过程吃光
        // （实测线上失败样本 reasoningLen=3414 / inputChars=275）。max_tokens 是**上限**、
        // 按实际用量计费，不是预扣，所以调大没有额外成本。
        max_tokens: 6000,
        // 关闭 DeepSeek 思考模式（默认是 enabled）。官方文档：
        // https://api-docs.deepseek.com/guides/thinking_mode/
        // 非 DeepSeek 模型时展开为空对象，不会带上这个专有字段。
        ...thinkingDisabled(model),
      }),
      signal: controller.signal,
    });

  try {
    let res = await callUpstream();

    if (!res.ok) {
      // 上游错误原文可能含 key / 账户信息，不透传
      const upstream = await res.text().catch(() => "");
      console.error("[feedback/ai] 上游返回", res.status, upstream.slice(0, 200));
      const hint =
        res.status === 401 || res.status === 403
          ? "AI Key 无效或权限不足，请联系管理员检查 AI_KEY。"
          : res.status === 429
            ? "AI 服务限流，请稍后重试。"
            : `AI 服务返回 ${res.status}，请稍后重试。`;
      return NextResponse.json({ ok: false, error: hint }, { status: 502 });
    }

    let data = await res.json().catch(() => null);

    // ---------- 兜底重试：思考过程吃光预算 ----------
    // 条件：finish_reason="length" 且 content 空 且 reasoning_content 非空。
    // 说明本次的预算全被思考占掉了 —— 关掉思考**再试一次**。
    // ⚠️ 刻意**不**从 reasoning_content 里抠答案：那是思考草稿（含试错与自我怀疑），
    //    把草稿当正文贴给家长属于「静默贴错内容」，比报错更糟。
    let retried = false;
    if (truncatedByReasoning(data)) {
      retried = true;
      console.warn(
        "[feedback/ai] 思考过程吃光 max_tokens，关掉 thinking 重试一次 | 诊断:",
        JSON.stringify({
          model,
          reasoningLen: reasoningLength(data),
          inputChars: text.length,
          usage: (data as { usage?: unknown })?.usage ?? null,
        }),
      );
      res = await callUpstream();
      if (res.ok) {
        data = await res.json().catch(() => null);
      } else {
        console.error("[feedback/ai] 重试仍失败，上游返回", res.status, (await res.text().catch(() => "")).slice(0, 200));
      }
    }

    const out = readContent(data);

    if (!out) {
      // ⚠️ 这条分支以前**不打任何日志**，导致「AI 返回内容为空」这个偶发问题
      //    在线上完全查不出原因（上游响应读完就丢）。
      //    这里只记录**结构信息**，用于判断到底是什么形态：
      //      · contentLen=0 + reasoningLen>0  且 finish_reason=length → 思考吃光预算
      //      · finish_reason="content_filter" → 被内容策略拦截
      //      · choices 整体缺失              → 上游返回了非预期结构
      //    **绝不记录正文内容、不记录 AI Key。**
      console.error(
        "[feedback/ai] 上游 200 但内容为空 | 诊断:",
        JSON.stringify({
          model,
          retried,
          finish_reason: data?.choices?.[0]?.finish_reason ?? null,
          choiceCount: Array.isArray(data?.choices) ? data.choices.length : null,
          hasMessage: !!data?.choices?.[0]?.message,
          hasReasoningContent: !!data?.choices?.[0]?.message?.reasoning_content,
          reasoningLen: reasoningLength(data),
          usage: (data as { usage?: unknown })?.usage ?? null,
          inputChars: text.length,
        }),
      );
      return NextResponse.json({ ok: false, error: "AI 返回内容为空。" }, { status: 502 });
    }

    // 成功路径也留一行低噪声日志：以后对比「成功 vs 为空」时，
    // reasoningLen 与 completion_tokens 的差异往往就是答案所在。
    console.log(
      "[feedback/ai] 成功 | 诊断:",
      JSON.stringify({
        model,
        retried,
        finish_reason: data?.choices?.[0]?.finish_reason ?? null,
        outChars: out.trim().length,
        reasoningLen: reasoningLength(data),
        completion_tokens: data?.usage?.completion_tokens ?? null,
        reasoning_tokens: data?.usage?.completion_tokens_details?.reasoning_tokens ?? null,
        inputChars: text.length,
      }),
    );

    // 只回正文，绝不回传 key / 模型配置
    return NextResponse.json({ ok: true, text: out.trim() });
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    console.error("[feedback/ai] 调用失败:", aborted ? "超时" : err);
    return NextResponse.json(
      { ok: false, error: aborted ? "AI 响应超时，请稍后重试。" : "AI 调用失败，请稍后重试。" },
      { status: 504 },
    );
  } finally {
    clearTimeout(timer);
  }
}
