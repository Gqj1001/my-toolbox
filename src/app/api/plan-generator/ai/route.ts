import { NextResponse, type NextRequest } from "next/server";
import { requireVip } from "@/lib/membership";
import {
  readContent,
  reasoningLength,
  thinkingDisabled,
  truncatedByReasoning,
} from "@/lib/deepseek-thinking";
import { buildGoalsMessages } from "./prompts";

/**
 * 辅导方案生成器（全学科）：**AI 生成教学目标初稿**（会员专属）
 *
 * 与 `math-plan/ai-sections`、`paper-analysis/ai-advice` 同一套安全约定：
 *  1. AI Key 只从 `process.env.AI_KEY` 读（服务端），绝不返回前端；
 *  2. 调用前 `requireVip()`：未登录 401 / 封禁 403 / 非会员 403；
 *  3. **不把上游错误原文透传**（可能含 key 或账户信息）；
 *  4. 思考模式关掉（否则 reasoning_content 会把 max_tokens 吃光，正文为空）；
 *  5. **行数契约**：返回行数必须等于请求条数，否则拒绝 —— 防止错位
 *     （把 A 模块的目标贴到 B 模块上，老师很难发现）。
 *
 * ⚠️ 与数学版的**关键区别**：这里**只生成「教学目标」**，不生成「内容」。
 *    原因：新工具的「内容」是科目包里的**教材真实小节号**（照人教社目录），
 *    让模型写内容必然编造章节。用户的要求也是"AI 生成初稿 + 老师就地编辑"，
 *    老师能改，但**编造的事实**不该由 AI 自己发明。
 *
 * 入参：
 *   { subject, subjectName, stage, grade, bandName, score, targetScore, totalHours,
 *     rows: [{ name, term, lv, stageName, chapters?, content?, hasExperiment? }] }
 * 返回：
 *   { ok: true, goals: string[] }        —— 与入参 rows **一一对应**
 */

const DEFAULT_BASE = "https://api.deepseek.com/v1";
/** 与其它 5 个路由一致：`deepseek-chat` 官方已于 2026-07-24 停用 */
const DEFAULT_MODEL = "deepseek-flash";

const MAX_PAYLOAD = 60_000;
/** 一次最多多少条模块（一个科目包最多几十个模块；多的分批发） */
const MAX_ROWS = 120;
/**
 * 输出上限。一个模块的目标 40–90 字，60 条 ≈ 5400 字 ≈ 5400 tokens（中文约 1 字 1 token），
 * 所以留 8000 给正文。max_tokens 是上限、按实际用量计费，调大不增加成本。
 */
const MAX_TOKENS = 8000;
const TIMEOUT_MS = 120_000;

/** 把模型返回的文本切成非空行（去掉编号、markdown 记号与包裹引号） */
function toLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) =>
      line
        .trim()
        .replace(/^```[a-z]*$/i, "")
        .replace(/^[*\-–—•]\s*/, "")
        // ⚠️ 只去掉"行首的编号"（`1.` / `1、` / `1)`）；**不能**去掉数字+
        //    因为目标里会出现「v－t图像」这种内容，误伤会改坏正文。
        .replace(/^\d+[.、)]\s*/, "")
        .replace(/^第\s*\d+\s*[条行][：:]\s*/, "")
        .replace(/^["“”']|["“”']$/g, "")
        .trim(),
    )
    .filter((line) => line.length > 0);
}

type RowIn = {
  name?: unknown;
  term?: unknown;
  lv?: unknown;
  stageName?: unknown;
  chapters?: unknown;
  content?: unknown;
  hasExperiment?: unknown;
};

export async function POST(request: NextRequest) {
  // ---------- 1. 服务端鉴权：必须是有效会员 ----------
  const guard = await requireVip();

  if (!guard.ok) {
    if (guard.reason === "unauthenticated") {
      return NextResponse.json({ ok: false, error: "请先登录。" }, { status: 401 });
    }
    if (guard.reason === "banned") {
      return NextResponse.json(
        { ok: false, error: "账号已被封禁，无法使用 AI 生成。" },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { ok: false, error: "AI 生成初稿为会员专属功能，请先开通会员。" },
      { status: 403 },
    );
  }

  // ---------- 2. 服务端配置 ----------
  const apiKey = process.env.AI_KEY;
  if (!apiKey) {
    console.error("[plan-generator/ai] 缺少环境变量 AI_KEY");
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

  const b = body as Record<string, unknown>;
  const rawRows = b.rows;
  if (!Array.isArray(rawRows) || rawRows.length === 0) {
    return NextResponse.json({ ok: false, error: "待生成的内容为空。" }, { status: 400 });
  }
  if (rawRows.length > MAX_ROWS) {
    return NextResponse.json(
      { ok: false, error: `一次最多生成 ${MAX_ROWS} 条，请分批。` },
      { status: 413 },
    );
  }

  const rows = (rawRows as RowIn[]).map((r) => {
    const lvRaw = r?.lv;
    const lv = typeof lvRaw === "number" || typeof lvRaw === "string" ? lvRaw : undefined;
    return {
      name: String(r?.name ?? "").trim(),
      term: String(r?.term ?? "").trim(),
      lv,
      stageName: String(r?.stageName ?? "").trim(),
      chapters: Array.isArray(r?.chapters) ? (r.chapters as unknown[]).map((x) => String(x)) : [],
      content: String(r?.content ?? "").trim(),
      hasExperiment: !!r?.hasExperiment,
    };
  });
  const emptyName = rows.findIndex((r) => !r.name);
  if (emptyName >= 0) {
    return NextResponse.json(
      { ok: false, error: `第 ${emptyName + 1} 条没有模块名，无法生成。` },
      { status: 400 },
    );
  }

  const subjectName = String(b.subjectName ?? "物理").trim() || "物理";
  const stage = String(b.stage ?? "senior").trim();
  if (stage !== "senior" && stage !== "junior") {
    return NextResponse.json(
      { ok: false, error: '学段（stage）只能是 "senior" 或 "junior"。' },
      { status: 400 },
    );
  }

  const built = buildGoalsMessages({
    subjectName,
    stage,
    grade: b.grade == null ? "" : String(b.grade),
    bandName: b.bandName == null ? "" : String(b.bandName),
    score: b.score as string | number | undefined,
    targetScore: b.targetScore as string | number | undefined,
    totalHours: b.totalHours as string | number | undefined,
    rows,
  });

  const payloadForLog = JSON.stringify(rows).length;
  const messages = built.messages;
  if (JSON.stringify(messages).length > MAX_PAYLOAD) {
    return NextResponse.json({ ok: false, error: "待生成内容过大，请分批。" }, { status: 413 });
  }

  const expectLines = rows.length;

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
        messages,
        temperature: 0.6,
        max_tokens: MAX_TOKENS,
        // 关掉 DeepSeek 思考模式（默认 enabled）。非 DeepSeek 模型时展开为空对象。
        ...thinkingDisabled(model),
      }),
      signal: controller.signal,
    });

  type UpstreamData = {
    choices?: Array<{
      finish_reason?: string;
      message?: { content?: string; reasoning_content?: string };
    }>;
    usage?: Record<string, unknown>;
  };

  try {
    let res = await callUpstream();

    if (!res.ok) {
      // 只在服务端记录，不把上游原文透传给前端
      console.error("[plan-generator/ai] 上游返回", res.status, (await res.text()).slice(0, 300));
      return NextResponse.json(
        { ok: false, error: "AI 服务暂时不可用，请稍后重试。" },
        { status: 502 },
      );
    }

    let data = (await res.json()) as UpstreamData;

    // ---------- 兜底重试：思考过程吃光预算 ----------
    let retried = false;
    if (truncatedByReasoning(data)) {
      retried = true;
      console.warn(
        "[plan-generator/ai] 思考过程吃光 max_tokens，关掉 thinking 重试一次 | 诊断:",
        JSON.stringify({
          model,
          reasoningLen: reasoningLength(data),
          inputChars: payloadForLog,
          rows: expectLines,
          usage: data.usage ?? null,
        }),
      );
      res = await callUpstream();
      if (res.ok) {
        data = (await res.json()) as UpstreamData;
      } else {
        console.error(
          "[plan-generator/ai] 重试仍失败，上游返回",
          res.status,
          (await res.text()).slice(0, 300),
        );
      }
    }

    const text = readContent(data);
    if (!text) {
      console.error(
        "[plan-generator/ai] 上游 200 但内容为空 | 诊断:",
        JSON.stringify({
          model,
          retried,
          finish_reason: data.choices?.[0]?.finish_reason ?? null,
          hasReasoningContent: !!data.choices?.[0]?.message?.reasoning_content,
          reasoningLen: reasoningLength(data),
          usage: data.usage ?? null,
          inputChars: payloadForLog,
          rows: expectLines,
        }),
      );
      return NextResponse.json({ ok: false, error: "AI 返回内容为空，请重试。" }, { status: 502 });
    }

    const lines = toLines(text);
    if (!lines.length) {
      return NextResponse.json({ ok: false, error: "AI 返回内容为空，请重试。" }, { status: 502 });
    }
    // 行数对不上就拒绝，避免前端把错位的目标贴到错误的模块上
    if (lines.length !== expectLines) {
      console.error(
        `[plan-generator/ai] 行数不匹配：期望 ${expectLines} 实际 ${lines.length}`,
      );
      return NextResponse.json(
        { ok: false, error: `AI 返回的条数与模块数不一致（应为 ${expectLines} 条，实际 ${lines.length} 条），请重试。` },
        { status: 502 },
      );
    }

    return NextResponse.json({ ok: true, goals: lines, retried });
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    console.error("[plan-generator/ai] 调用失败:", aborted ? "超时" : (e as Error)?.message);
    return NextResponse.json(
      { ok: false, error: aborted ? "AI 响应超时，请重试。" : "AI 服务暂时不可用，请稍后重试。" },
      { status: 502 },
    );
  } finally {
    clearTimeout(timer);
  }
}
