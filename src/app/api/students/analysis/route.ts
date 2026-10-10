import { NextResponse, type NextRequest } from "next/server";
import { requireVip } from "@/lib/membership";
import {
  getHistoryFresh,
  getStudentsFresh,
  importHistory,
  type HistoryPatch,
} from "@/lib/feedback-db";
import {
  readContent,
  reasoningLength,
  thinkingDisabled,
  truncatedByReasoning,
} from "@/lib/deepseek-thinking";
import { ANALYSIS_TOOL, buildStudentReport } from "@/lib/student-report";

/**
 * 学情分析：把档案里三个工具的记录交给 AI，写一份**整体学情报告**（会员专属）
 *
 * 与另外三个 AI 路由同一套安全约定：
 *  1. AI Key 只从 `process.env.AI_KEY` 读（服务端），绝不返回前端；
 *  2. `requireVip()` 服务端校验：未登录 401 / 封禁 403 / 非会员 403；
 *  3. 上游错误原文**不透传**（可能带 key 或账户信息）。
 *
 * ⚠️ **喂给 AI 的不是学生原始素材，而是服务端算好的结构化摘要**
 *    （`buildStudentReport().digest`）：概览 / 成绩趋势 / 课时 / 摘自正文的薄弱与失分。
 *    这样做有三个好处：① 报告与页面上免费看到的那份**同源**（不会两处算法打架）；
 *    ② 模型不负责计算，只负责组织语言；③ 提示词可以明确要求「材料里没有的不许编」。
 *
 * ⚠️ 生成成功后会**落库**成一条 `tool='analysis'` 的历史记录 ——
 *    所以本路由需要数据库那条 CHECK 已经放开（迁移 `0017_history_tool_allow_analysis.sql`）。
 *    没放开时返回 **409 + 点名的迁移文件名**（不是一句"操作失败"）。
 */
export const dynamic = "force-dynamic";

const DEFAULT_BASE = "https://api.deepseek.com/v1";
const DEFAULT_MODEL = "deepseek-chat";
const MAX_TOKENS = 6000;
const TIMEOUT_MS = 120_000;

const SYSTEM_PROMPT =
  "你是一位有十几年经验的高中数学教研组长兼班主任，正在根据学生的档案记录写一份《整体学情分析》，" +
  "给这位学生的任课老师看（老师可能据此跟家长沟通）。\n" +
  "用户会给你一份**结构化摘要**：学生基本信息、记录概览、逐次考试成绩与得分率、课时安排、" +
  "以及从各工具正文里**原文摘录**的薄弱与失分信息；摘要末尾还有一段「数据说明」，" +
  "列出材料里真实存在的缺口。\n" +
  "硬性要求（必须遵守）：\n" +
  "1. **只依据用户给的材料**。材料里没有的分数、考试名、知识点、课时、学校等一律不许编造，也不要推测。\n" +
  "2. 材料不足时**明确写出来**（例如「目前只有一次带分数的考试，趋势还看不出来」），" +
  "不要用漂亮话把缺口盖过去。\n" +
  "3. 数字必须与材料完全一致（得分率、课时数、分数、次数），不得改写、不得四舍五入成别的值。\n" +
  "4. 输出四个部分，**必须**用这四个小标题（方括号原样输出，各占一行）：\n" +
  "【整体学情】【优势】【薄弱与原因】【下一步建议】\n" +
  "5. 全文 600–1200 字，中文，语气专业、具体、可执行；不要输出 markdown 符号（#、*、-），" +
  "需要列举时用「① ② ③」或「1. 2. 3.」；不要解释你在做什么，直接输出报告正文。\n" +
  "6. 「下一步建议」要落到**可验收的动作**（先补哪个模块、用什么方式练、达到什么标准），" +
  "不要写「多加练习」这类空话。";

export async function POST(request: NextRequest) {
  // ---------- 1. 鉴权：会员专属 ----------
  const guard = await requireVip();
  if (!guard.ok) {
    if (guard.reason === "unauthenticated") {
      return NextResponse.json({ ok: false, error: "请先登录。" }, { status: 401 });
    }
    if (guard.reason === "banned") {
      return NextResponse.json({ ok: false, error: "账号已被封禁。" }, { status: 403 });
    }
    return NextResponse.json(
      { ok: false, error: "学情分析（AI 报告）为会员专属功能，请先开通会员。" },
      { status: 403 },
    );
  }

  // ---------- 2. 服务端配置 ----------
  const apiKey = process.env.AI_KEY;
  if (!apiKey) {
    console.error("[students/analysis] 缺少环境变量 AI_KEY");
    return NextResponse.json({ ok: false, error: "服务端未配置 AI Key，请联系管理员。" }, { status: 503 });
  }
  const baseUrl = (process.env.AI_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, "");
  const model = process.env.AI_MODEL ?? DEFAULT_MODEL;

  // ---------- 3. 入参 ----------
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON。" }, { status: 400 });
  }
  const name = String(body.name ?? "").trim();
  if (!name) return NextResponse.json({ ok: false, error: "缺少学生姓名。" }, { status: 400 });
  if (name.length > 100) return NextResponse.json({ ok: false, error: "学生姓名过长。" }, { status: 400 });

  // ---------- 4. 取这个学生的档案与记录（**直读**，不用缓存）----------
  // ⚠️ 与档案页一致：写入发生在别的请求里，用缓存版会出现「刚存的记录这里看不到」。
  let report;
  try {
    const [studentRows, historyRows] = await Promise.all([getStudentsFresh(), getHistoryFresh()]);
    const student = studentRows.find((r) => r.name === name) ?? null;
    const rows = historyRows.filter((r) => r.student_name === name);
    report = buildStudentReport({ name, student, rows });
  } catch (e) {
    console.error("[students/analysis] 读取档案失败:", (e as Error)?.message);
    return NextResponse.json({ ok: false, error: "读取档案失败，请稍后重试。" }, { status: 502 });
  }

  if (!report.overview.total) {
    return NextResponse.json(
      {
        ok: false,
        error: "这位学生还没有任何记录（辅导方案 / 试卷分析 / 课后反馈），先有记录再生成学情报告。",
      },
      { status: 400 },
    );
  }

  // ---------- 5. 调上游 ----------
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const callUpstream = () =>
    fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: report.digest },
        ],
        temperature: 0.4,
        max_tokens: MAX_TOKENS,
        // 关闭 DeepSeek 思考模式（默认 enabled）；非 DeepSeek 模型展开为空对象
        ...thinkingDisabled(model),
      }),
      signal: controller.signal,
    });

  let text = "";
  try {
    let res = await callUpstream();
    if (!res.ok) {
      console.error("[students/analysis] 上游返回", res.status, (await res.text()).slice(0, 300));
      return NextResponse.json({ ok: false, error: "AI 服务暂时不可用，请稍后重试。" }, { status: 502 });
    }
    let data = (await res.json()) as {
      choices?: Array<{ finish_reason?: string; message?: { content?: string; reasoning_content?: string } }>;
      usage?: Record<string, unknown>;
    };

    // 兜底重试：思考过程吃光 max_tokens（与另外三个 AI 路由同源）
    if (truncatedByReasoning(data)) {
      console.warn(
        "[students/analysis] 思考过程吃光 max_tokens，关掉 thinking 重试一次 | 诊断:",
        JSON.stringify({
          model,
          reasoningLen: reasoningLength(data),
          inputChars: report.digest.length,
          usage: data.usage ?? null,
        }),
      );
      res = await callUpstream();
      if (res.ok) data = (await res.json()) as typeof data;
      else console.error("[students/analysis] 重试仍失败，上游返回", res.status, (await res.text()).slice(0, 300));
    }

    text = readContent(data);
    if (!text) {
      console.error(
        "[students/analysis] 上游 200 但内容为空 | 诊断:",
        JSON.stringify({
          model,
          finish_reason: data.choices?.[0]?.finish_reason ?? null,
          reasoningLen: reasoningLength(data),
          usage: data.usage ?? null,
        }),
      );
      return NextResponse.json({ ok: false, error: "AI 返回内容为空，请重试。" }, { status: 502 });
    }
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    console.error("[students/analysis] 调用失败:", aborted ? "超时" : (e as Error)?.message);
    return NextResponse.json(
      { ok: false, error: aborted ? "AI 响应超时，请重试。" : "AI 服务暂时不可用，请稍后重试。" },
      { status: 502 },
    );
  } finally {
    clearTimeout(timer);
  }

  // ---------- 6. 落库成一条记录（tool='analysis'）----------
  // ⚠️ 走的是**和批量导入同一个函数**（`importHistory`）：判重、失效、错误处理只有一份实现。
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const dateIso = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  // 标题带「时:分」：每次生成都留一条（用户明确要落库），但也不会同一分钟重复刷出多条
  const title = `学情报告 · ${now.getMonth() + 1}月${now.getDate()}日 ${pad(now.getHours())}:${pad(now.getMinutes())}`;

  let saved = false;
  let skipped = 0;
  try {
    const item: HistoryPatch = {
      student_name: name,
      text,
      date: dateIso,
      type_name: null,
      subject: report.identity.subject || null,
      tool: ANALYSIS_TOOL,
      title,
      score: null,
      full_score: null,
    };
    const result = await importHistory([item]);
    saved = result.inserted > 0;
    skipped = result.skipped;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[students/analysis] 报告落库失败:", msg);
    // 约束没放开时给出**能照着做**的提示（不然只有一句"保存失败"，没法定位）
    if (/feedback_history_tool_check|check_violation|23514/.test(msg)) {
      return NextResponse.json(
        {
          ok: false,
          // ⚠️ 报告已经生成了，只是没能存下来 —— 必须把它一起返回，否则用户白花一次 AI 调用
          report: text,
          error:
            "报告已生成，但没能存进档案：数据库还不接受这个归属工具。" +
            "请先在 Supabase SQL Editor 执行迁移 supabase/migrations/0017_history_tool_allow_analysis.sql" +
            "（放宽 tool 的 CHECK 约束），再重试。",
          code: "tool_constraint",
        },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { ok: false, report: text, error: "报告已生成，但保存到档案时失败，请稍后重试。" },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    report: text,
    saved,
    skipped,
    title,
    date: dateIso,
    /** 页面上免费看到的那份统计的「依据」，一起给出去便于核对（不含任何 key） */
    digestChars: report.digest.length,
  });
}
