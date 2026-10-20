import { NextResponse, type NextRequest } from "next/server";
import { requireVip } from "@/lib/membership";
import { readContent, thinkingDisabled, truncatedByReasoning } from "@/lib/deepseek-thinking";

/**
 * 全学科试卷分析 v2 · AI 辅助（会员专属）
 * ==========================================================================
 * 只做两件事（用户 2026-10 拍板）：
 *   · section="stem"        → 给错题写「题干摘要」（附件2 的「题目」列）
 *   · section="attribution" → 用本次统计 + 档案历史写附件1「三段归因」初稿
 *
 * 硬口径（与其它 AI 路由一致）：
 *   · AI Key 只在服务端读，绝不返回前端；
 *   · 未登录 401 / 封禁 403 / 非会员 403；
 *   · 不把上游错误原文透传；
 *   · 关掉 DeepSeek 思考模式；返回行数/JSON 结构不对就 502，让老师重试，
 *     **绝不错位贴到别的题上**。
 */

const DEFAULT_BASE = "https://api.deepseek.com/v1";
const DEFAULT_MODEL = "deepseek-flash";
const MAX_PAYLOAD = 40_000;
const MAX_QUESTIONS = 60;
const TIMEOUT_MS = 120_000;
const MAX_TOKENS = 6000;

const STEM_PROMPT =
  "你是一位有十几年经验的{subject}{stage}教师。用户会给你一组错题的「题号 / 题型 / 考点」，\n" +
  "请为每一道题写一句「题干摘要」，让没看过卷子的老师一眼知道这题考什么。\n" +
  "严格要求：\n" +
  "1. 输出的行数必须与输入题数**完全一致、顺序不变**；\n" +
  "2. 只输出摘要正文：不要题号、不要编号、不要引号、不要 markdown、不要解释；\n" +
  "3. 每行 8–20 个汉字，写成「考什么 + 怎么考」的一句话；\n" +
  "4. 只依据给的题型与考点概括，**不要编造**具体数字、选项、材料或原文；\n" +
  "5. 如果考点不足以概括，就写「考查{题型}：{第一个考点}」，不要硬编。";

const ATTR_PROMPT =
  "你是一位有十几年经验的{subject}{stage}教师，正在写公司《试卷分析表》附件1 的「成绩变化原因分析」。\n" +
  "用户会给你：本次考试的统计（得分率、错题、薄弱模块）和学生档案里的近期历史（可能为空）。\n" +
  "请只输出一个 JSON 对象，恰好三个键：\n" +
  '  "学生角度"：从知识掌握、方法习惯、审题计算等角度写；\n' +
  '  "教师角度"：从教学安排、训练量、讲评方式等角度写；\n' +
  '  "其它原因"：从考试状态、时间分配、外部因素等角度写（没有就写“暂无明显外部因素”）。\n' +
  "每段 80–150 字；必须依据给的数据与历史，**不要编造分数、题号、排名**；\n" +
  "措辞面向家长、客观温和，不给孩子贴标签，不下“能力差/态度有问题”这类定论。\n" +
  "只输出 JSON，不要 markdown 代码块，不要任何解释。";

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

function extractJson(text: string): Record<string, unknown> | null {
  const s = String(text || "").replace(/```[a-z]*/gi, "").trim();
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    const obj = JSON.parse(s.slice(a, b + 1));
    return obj && typeof obj === "object" && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  const guard = await requireVip();
  if (!guard.ok) {
    if (guard.reason === "unauthenticated") {
      return NextResponse.json({ ok: false, error: "请先登录。" }, { status: 401 });
    }
    if (guard.reason === "banned") {
      return NextResponse.json({ ok: false, error: "账号已被封禁，无法使用 AI 功能。" }, { status: 403 });
    }
    return NextResponse.json({ ok: false, error: "AI 辅助为会员专属功能，请先开通会员。" }, { status: 403 });
  }

  const apiKey = process.env.AI_KEY;
  if (!apiKey) {
    console.error("[paper-analysis-v2/ai] 缺少环境变量 AI_KEY");
    return NextResponse.json({ ok: false, error: "服务端未配置 AI Key，请联系管理员。" }, { status: 503 });
  }
  const baseUrl = (process.env.AI_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, "");
  const model = process.env.AI_MODEL ?? DEFAULT_MODEL;

  let body: Record<string, unknown>;
  try {
    const raw = await request.json();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("bad");
    body = raw as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON。" }, { status: 400 });
  }

  const section = String(body.section ?? "");
  const subject = String(body.subject ?? "").slice(0, 20);
  const stage = String(body.stage ?? "").slice(0, 10);
  if (section !== "stem" && section !== "attribution") {
    return NextResponse.json({ ok: false, error: "section 只能是 stem 或 attribution。" }, { status: 400 });
  }
  if (!subject) {
    return NextResponse.json({ ok: false, error: "缺少学科。" }, { status: 400 });
  }

  let payload: string;
  let stemsQuestions: Array<{ no: string; type: string; knowledge: string[] }> = [];
  if (section === "stem") {
    const raw = body.questions;
    if (!Array.isArray(raw) || !raw.length) {
      return NextResponse.json({ ok: false, error: "没有需要生成摘要的错题。" }, { status: 400 });
    }
    if (raw.length > MAX_QUESTIONS) {
      return NextResponse.json({ ok: false, error: `一次最多 ${MAX_QUESTIONS} 道题，请分批。` }, { status: 413 });
    }
    stemsQuestions = raw.map((q) => {
      const x = (q && typeof q === "object" ? q : {}) as Record<string, unknown>;
      return {
        no: String(x.no ?? ""),
        type: String(x.type ?? ""),
        knowledge: Array.isArray(x.knowledge) ? x.knowledge.map((k) => String(k)).slice(0, 4) : [],
      };
    });
    if (stemsQuestions.some((q) => !q.no)) {
      return NextResponse.json({ ok: false, error: "每道题都必须带题号。" }, { status: 400 });
    }
    payload = JSON.stringify({ subject, stage, questions: stemsQuestions });
  } else {
    const summary = body.summary;
    const history = body.history;
    if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
      return NextResponse.json({ ok: false, error: "缺少本次考试的统计摘要。" }, { status: 400 });
    }
    payload = JSON.stringify({
      subject,
      stage,
      summary,
      history: Array.isArray(history) ? history.slice(0, 8) : [],
    });
  }
  if (payload.length > MAX_PAYLOAD) {
    return NextResponse.json({ ok: false, error: "数据过大，请减少错题/历史条数后重试。" }, { status: 413 });
  }

  const prompt = (section === "stem" ? STEM_PROMPT : ATTR_PROMPT)
    .replace(/\{subject\}/g, subject)
    .replace(/\{stage\}/g, stage || "");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const callUpstream = () =>
    fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: payload },
        ],
        temperature: section === "stem" ? 0.3 : 0.5,
        max_tokens: MAX_TOKENS,
        ...thinkingDisabled(model),
      }),
      signal: controller.signal,
    });

  try {
    let res = await callUpstream();
    if (!res.ok) {
      console.error("[paper-analysis-v2/ai] 上游返回", res.status, (await res.text()).slice(0, 300));
      return NextResponse.json({ ok: false, error: "AI 服务暂时不可用，请稍后重试。" }, { status: 502 });
    }
    let data = (await res.json()) as {
      choices?: Array<{ finish_reason?: string; message?: { content?: string; reasoning_content?: string } }>;
    };
    if (truncatedByReasoning(data)) {
      res = await callUpstream();
      if (!res.ok) {
        console.error("[paper-analysis-v2/ai] 重试仍失败", res.status);
        return NextResponse.json({ ok: false, error: "AI 服务暂时不可用，请稍后重试。" }, { status: 502 });
      }
      data = (await res.json()) as typeof data;
    }
    const text = readContent(data);
    if (!text) {
      console.error("[paper-analysis-v2/ai] 上游 200 但内容为空");
      return NextResponse.json({ ok: false, error: "AI 返回内容为空，请重试。" }, { status: 502 });
    }

    if (section === "stem") {
      const lines = toLines(text);
      if (lines.length !== stemsQuestions.length) {
        console.error(`[paper-analysis-v2/ai] 题干摘要行数不匹配：期望 ${stemsQuestions.length} 实际 ${lines.length}`);
        return NextResponse.json(
          { ok: false, error: "AI 返回的摘要条数与题目不一致，请重试。" },
          { status: 502 },
        );
      }
      return NextResponse.json({
        ok: true,
        section,
        stems: stemsQuestions.map((q, i) => ({ no: q.no, text: lines[i] })),
      });
    }

    const obj = extractJson(text);
    const keys = ["学生角度", "教师角度", "其它原因"];
    if (!obj || keys.some((k) => typeof obj[k] !== "string" || !String(obj[k]).trim())) {
      console.error("[paper-analysis-v2/ai] 归因 JSON 结构不对");
      return NextResponse.json({ ok: false, error: "AI 返回的归因格式不正确，请重试。" }, { status: 502 });
    }
    return NextResponse.json({
      ok: true,
      section,
      attribution: {
        学生角度: String(obj["学生角度"]).trim().slice(0, 500),
        教师角度: String(obj["教师角度"]).trim().slice(0, 500),
        其它原因: String(obj["其它原因"]).trim().slice(0, 500),
      },
    });
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    console.error("[paper-analysis-v2/ai] 调用失败:", aborted ? "超时" : (e as Error)?.message);
    return NextResponse.json(
      { ok: false, error: aborted ? "AI 响应超时，请重试。" : "AI 服务暂时不可用，请稍后重试。" },
      { status: 502 },
    );
  } finally {
    clearTimeout(timer);
  }
}
