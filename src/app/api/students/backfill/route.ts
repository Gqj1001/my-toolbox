import { NextResponse, type NextRequest } from "next/server";
import { requireVip } from "@/lib/membership";
import { readContent, reasoningLength, thinkingDisabled, truncatedByReasoning } from "@/lib/deepseek-thinking";
import {
  checkBackfillInput,
  extractJsonObject,
  normalizeBackfill,
  promptFor,
  BACKFILL_KINDS,
} from "@/lib/backfill";

/**
 * 「补录历史材料」：把老师手里的**旧材料文字**整理成我们系统的统一格式（会员专属）
 *
 * 用户 2026-10 拍板（方案见 `docs/manual-backfill-plan.md`，四个决策全选 A）：
 *   工具上线**之前**的反馈 / 试卷分析 / 辅导方案散在老师手里（Word、PDF、纸），
 *   让 AI 整理成**与现有工具相同的正文格式**后入档 ⇒ 学情分析**一行都不用改**就能算进去。
 *
 * ⚠️ 本路由**不写库**：它只把材料整理好返回给前端，**由老师预览核对后**再调
 *    `POST /api/students { op:"import" }` 落库。理由：AI 识别的老材料**必须先过人眼**，
 *    否则错的内容会静默进档案（老师的学情报告是拿去跟家长说的）。
 *
 * ⚠️ 归属工具（tool）复用**已有值**：paper / math-plan / feedback ⇒ **零迁移**。
 *    与"手动补录成绩"（`tool='manual'`）是两件事：那是**只有数字**的一条记录，这是**带正文**的。
 *
 * 与另外四个 AI 路由同一套安全约定：
 *  1. AI Key 只从 `process.env.AI_KEY` 读（服务端），绝不返回前端；
 *  2. `requireVip()` 服务端校验：未登录 401 / 封禁 403 / 非会员 403；
 *  3. 上游错误原文**不透传**（可能带 key 或账户信息）。
 */

export const dynamic = "force-dynamic";

const DEFAULT_BASE = "https://api.deepseek.com/v1";
/** 与另外几个路由一致：默认 `deepseek-flash`（`deepseek-chat` 官方 2026-07-24 已停用） */
const DEFAULT_MODEL = "deepseek-flash";
/** 一份几十页的老方案整理成统一格式，输出比输入短；6000 够用（max_tokens 是上限，按实际计费） */
const MAX_TOKENS = 6000;
const TIMEOUT_MS = 60_000;

export async function POST(request: NextRequest) {
  // ---------- 1. 鉴权（未登录 401 / 封禁 403 / 非会员 403） ----------
  const guard = await requireVip();
  if (!guard.ok) {
    if (guard.reason === "unauthenticated") {
      return NextResponse.json({ ok: false, error: "请先登录。" }, { status: 401 });
    }
    if (guard.reason === "banned") {
      return NextResponse.json({ ok: false, error: "账号已被封禁，无法使用材料补录。" }, { status: 403 });
    }
    return NextResponse.json(
      { ok: false, error: "材料补录是会员专属功能，请先开通会员。" },
      { status: 403 },
    );
  }

  // ---------- 2. 配置闸（没有 Key 时明确说"没配"，不要报成上游故障） ----------
  const apiKey = process.env.AI_KEY;
  if (!apiKey) {
    console.error("[students/backfill] 缺少环境变量 AI_KEY");
    return NextResponse.json({ ok: false, error: "服务端未配置 AI Key，请联系管理员。" }, { status: 503 });
  }
  const baseUrl = (process.env.AI_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, "");
  const model = process.env.AI_MODEL ?? DEFAULT_MODEL;

  // ---------- 3. 入参校验（纯函数，测试直接打它） ----------
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON。" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ ok: false, error: "请求体格式不正确。" }, { status: 400 });
  }
  const checked = checkBackfillInput(body as { kind?: unknown; text?: unknown });
  if (!checked.ok) return NextResponse.json({ ok: false, error: checked.error }, { status: 400 });

  // ---------- 4. 调模型（照 ai-advice 的调用口径：关思考、不透传上游错误） ----------
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const callUpstream = () =>
    fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: promptFor(checked.kind) },
          { role: "user", content: checked.text },
        ],
        // 这是"整理/排版"而不是"创作"：温度低一些，别让它发挥
        temperature: 0.2,
        max_tokens: MAX_TOKENS,
        // 关闭 DeepSeek 思考模式（非 DeepSeek 模型时展开为空对象，不会带专有字段）
        ...thinkingDisabled(model),
      }),
      signal: controller.signal,
    });

  try {
    let res = await callUpstream();
    if (!res.ok) {
      console.error("[students/backfill] 上游返回", res.status, (await res.text()).slice(0, 300));
      return NextResponse.json({ ok: false, error: "AI 服务暂时不可用，请稍后重试。" }, { status: 502 });
    }
    let data = (await res.json()) as {
      choices?: Array<{ finish_reason?: string; message?: { content?: string; reasoning_content?: string } }>;
      usage?: Record<string, unknown>;
    };
    // 思考过程吃光 max_tokens 时正文为空 → 已经在关思考，这里再兜一次（与其它路由同款）
    if (truncatedByReasoning(data)) {
      console.warn("[students/backfill] 首次返回被思考吃光，关掉 thinking 再试一次，reasoningLen=", reasoningLength(data));
      res = await callUpstream();
      if (!res.ok) {
        console.error("[students/backfill] 上游返回（重试后）", res.status, (await res.text()).slice(0, 300));
        return NextResponse.json({ ok: false, error: "AI 服务暂时不可用，请稍后重试。" }, { status: 502 });
      }
      data = (await res.json()) as typeof data;
    }

    const raw = readContent(data);
    if (!raw.trim()) {
      console.error("[students/backfill] 上游返回空正文, usage=", JSON.stringify(data.usage ?? {}));
      return NextResponse.json({ ok: false, error: "AI 没有返回可用内容，请稍后重试。" }, { status: 502 });
    }

    // ---------- 5. 解析成统一结构（解析不出来就把原文给老师，不白花这次调用） ----------
    const parsed = extractJsonObject(raw);
    const result = parsed ? normalizeBackfill(parsed, checked.text) : null;
    if (!result) {
      console.warn("[students/backfill] 模型没按 JSON 返回，已把原文交给前端手工整理");
      return NextResponse.json({
        ok: true,
        kind: checked.kind,
        tool: BACKFILL_KINDS[checked.kind].tool,
        text: raw.trim().slice(0, 20_000),
        facts: { examDate: "", examName: "", score: "", fullScore: "", hours: "" },
        uncertain: [],
        missing: [],
        suspiciousLength: false,
        rawFallback: true,   // ⚠️ 前端要据此提示"AI 没按格式返回，请重点核对"
      });
    }

    return NextResponse.json({
      ok: true,
      kind: checked.kind,
      tool: BACKFILL_KINDS[checked.kind].tool,
      ...result,
      rawFallback: false,
    });
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    console.error("[students/backfill] 调用失败:", aborted ? "超时" : String(e));
    return NextResponse.json(
      { ok: false, error: aborted ? "整理超时（材料可能太长），请重试或拆成几份。" : "整理失败，请稍后重试。" },
      { status: aborted ? 504 : 502 },
    );
  } finally {
    clearTimeout(timer);
  }
}
