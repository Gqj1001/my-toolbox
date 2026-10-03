import { NextResponse, type NextRequest } from "next/server";
import { requireVip } from "@/lib/membership";

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
const DEFAULT_PROMPT =
  "你是资深高中数学教师，正在给家长写课后反馈。请把下面的反馈润色扩写：" +
  "保留原有的全部事实与关键信息（学生姓名、分数、知识点、作业要求一个都不能改或删），" +
  "语气温和专业、面向家长，句子更连贯自然，字数扩充 30%~50%。" +
  "直接输出润色后的正文，不要加任何解释、标题或 markdown 符号。";

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

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
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
        max_tokens: 2000,
      }),
      signal: controller.signal,
    });

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

    const data = await res.json().catch(() => null);
    const out: string | undefined = data?.choices?.[0]?.message?.content;

    if (!out || !out.trim()) {
      return NextResponse.json({ ok: false, error: "AI 返回内容为空。" }, { status: 502 });
    }

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
