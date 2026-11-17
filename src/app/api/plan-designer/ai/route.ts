import { NextResponse, type NextRequest } from "next/server";
import { requireVip } from "@/lib/membership";
import {
  readContent,
  reasoningLength,
  thinkingDisabled,
  truncatedByReasoning,
} from "@/lib/deepseek-thinking";

export const dynamic = "force-dynamic";

const DEFAULT_BASE = "https://api.deepseek.com/v1";
const DEFAULT_MODEL = "deepseek-flash";
const MAX_TOKENS = 4000;
const TIMEOUT_MS = 90_000;

function extractJson(text: string): unknown {
  const raw = String(text ?? "").replace(/```(?:json)?/gi, "").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch { /* fall through */ }
  }
  const as = raw.indexOf("[");
  const ae = raw.lastIndexOf("]");
  if (as >= 0 && ae > as) {
    try { return JSON.parse(raw.slice(as, ae + 1)); } catch { /* fall through */ }
  }
  return null;
}

export async function POST(request: NextRequest) {
  const guard = await requireVip();
  if (!guard.ok) {
    if (guard.reason === "unauthenticated") return NextResponse.json({ ok: false, error: "请先登录。" }, { status: 401 });
    if (guard.reason === "banned") return NextResponse.json({ ok: false, error: "账号已被封禁。" }, { status: 403 });
    return NextResponse.json({ ok: false, error: "AI 润色是会员功能，请先开通会员。" }, { status: 403 });
  }
  const apiKey = process.env.AI_KEY;
  if (!apiKey) return NextResponse.json({ ok: false, error: "服务端未配置 AI Key，请联系管理员。" }, { status: 503 });
  const baseUrl = (process.env.AI_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, "");
  const model = process.env.AI_MODEL ?? DEFAULT_MODEL;

  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON。" }, { status: 400 });
  }
  const action = String(body.action ?? "");
  if (action !== "analysis" && action !== "goals") {
    return NextResponse.json({ ok: false, error: "action 只能是 analysis 或 goals。" }, { status: 400 });
  }
  const form = (body.form ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(body.rows) ? (body.rows as Array<Record<string, unknown>>) : [];
  if (action === "goals" && !rows.length) {
    return NextResponse.json({ ok: false, error: "没有可润色的模块目标。" }, { status: 400 });
  }
  if (rows.length > 30) return NextResponse.json({ ok: false, error: "一次最多 30 个模块。" }, { status: 413 });

  const shared = [
    "你是锐满分教育的数学教研老师，正在为家长会写个性化辅导计划。",
    "只依据用户提供的学生信息、失分模块、课程库内容写，不得编造分数、学校、考试、课时。",
    "语言要专业、温和、可执行，避免“严重不足/一塌糊涂”等下定论的表达。",
    "不要输出 Markdown 记号、不要输出英文变量名。",
  ].join("\n");

  const system = action === "analysis"
    ? `${shared}\n请只输出一个 JSON 对象（不要解释）：{"knowledge":"...","ability":"...","method":"...","habit":"...","attitude":"..."}。每个 60–120 字，分别对应知识储备、学科能力、学习方法、行为习惯、内在态度；家庭环境/学校环境不要输出。`
    : `${shared}\n请只输出一个 JSON 字符串数组，长度必须等于输入 rows 的数量，顺序一一对应；每项 40–100 字，写“可达成的目标（含分数展示）”，不要改模块名/课时。`;

  const user = action === "analysis"
    ? JSON.stringify({
        name: form.name, grade: form.grade, level: form.level,
        current: form.current, target: form.target, totalHours: form.totalHours,
        weakModules: form.weakModules, keywords: form.keywords, accuracy: form.accuracy,
      })
    : JSON.stringify({
        name: form.name, level: form.level, current: form.current, target: form.target,
        accuracy: form.accuracy,
        rows: rows.map((r) => ({ module: r.module, points: r.points, examScore: r.examScore, hours: r.hours })),
      });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const call = () => fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      temperature: 0.25,
      max_tokens: MAX_TOKENS,
      ...thinkingDisabled(model),
    }),
    signal: controller.signal,
  });
  try {
    let res = await call();
    if (!res.ok) return NextResponse.json({ ok: false, error: "AI 服务暂时不可用，请稍后重试。" }, { status: 502 });
    let data = (await res.json()) as { choices?: Array<{ finish_reason?: string; message?: { content?: string; reasoning_content?: string } }> };
    if (truncatedByReasoning(data)) {
      console.warn("[plan-designer/ai] 思考吃光输出，重试", reasoningLength(data));
      res = await call();
      if (!res.ok) return NextResponse.json({ ok: false, error: "AI 服务暂时不可用，请稍后重试。" }, { status: 502 });
      data = (await res.json()) as typeof data;
    }
    const text = readContent(data);
    const parsed = extractJson(text);
    if (action === "analysis") {
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return NextResponse.json({ ok: false, error: "AI 返回格式不对，请重试。" }, { status: 502 });
      }
      const src = parsed as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const key of ["knowledge", "ability", "method", "habit", "attitude"]) {
        const v = String(src[key] ?? "").trim();
        if (v) out[key] = v;
      }
      if (Object.keys(out).length < 3) return NextResponse.json({ ok: false, error: "AI 返回内容不完整，请重试。" }, { status: 502 });
      return NextResponse.json({ ok: true, analysis: out });
    }
    if (!Array.isArray(parsed) || parsed.length !== rows.length) {
      return NextResponse.json({ ok: false, error: "AI 返回条数与模块数不一致，请重试。" }, { status: 502 });
    }
    return NextResponse.json({ ok: true, goals: parsed.map((x) => String(x ?? "").trim()) });
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    return NextResponse.json({ ok: false, error: aborted ? "AI 超时，请重试。" : "AI 调用失败，请稍后重试。" }, { status: aborted ? 504 : 502 });
  } finally {
    clearTimeout(timer);
  }
}
