import { NextResponse, type NextRequest } from "next/server";
import { requireVip } from "@/lib/membership";
import { isFeatureEnabled } from "@/lib/feature-flags";
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
import { isToolConstraintError, TOOL_CONSTRAINT_MIGRATION } from "@/lib/manual-score";

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
/** ⚠️ 2026-10 第四批（待办 B）：默认值从已停用的 `deepseek-chat` 改成 `deepseek-flash`
 *  （线上有 `AI_MODEL` 覆盖，行为不变；只是把兜底的名字修对）。 */
const DEFAULT_MODEL = "deepseek-flash";
const MAX_TOKENS = 6000;
const TIMEOUT_MS = 120_000;

const SYSTEM_PROMPT =
  "你是一位有十几年经验的高中数学教研组长兼班主任，正在为**机构学情分析会议**写一份《整体学情分析》，" +
  "给这位学生的任课老师看（老师会拿着它去开会、跟家长沟通）。\n" +
  "用户会给你一份**结构化摘要**：学生基本信息、记录概览、逐次考试成绩与得分率、课时安排、" +
  "档案里填写/辅导方案里的目标分数与总课时数、" +
  "学习进度（最近反馈的课堂内容/下节课内容，以及它对应辅导方案课表的第几条）、" +
  "分数目标对比（初始分/本次分/目标分/差距/提升速度），" +
  "以及从各工具正文里**原文摘录**的薄弱与失分信息；摘要末尾还有一段「数据说明」，" +
  "列出材料里真实存在的缺口。\n" +
  "硬性要求（必须遵守）：\n" +
  "1. **只依据用户给的材料**。材料里没有的分数、考试名、知识点、课时、学校、目标分等一律不许编造，也不要推测。\n" +
  "2. 材料不足时**明确写出来**（例如「目前只有一次带分数的考试，趋势还看不出来」「方案里没有写目标分，无法做目标对比」），" +
  "不要用漂亮话把缺口盖过去。\n" +
  "3. 数字必须与材料完全一致（得分率、课时数、分数、次数、差距、提升速度），不得改写、不得四舍五入成别的值。\n" +
  "4. 输出**六个部分**，必须用这六个小标题（方括号原样输出，各占一行）：\n" +
  "【整体学情】【学习进度】【分数目标对比】【优势】【薄弱与原因】【针对性提升方案】\n" +
  "5. 全文 800–1600 字，中文，语气专业、具体、可执行。**允许并鼓励使用 Markdown 表格**" +
  "（形如 `| 项目 | 数值 |`，第二行 `| --- | --- |`）来展示分数趋势、学习进度、目标对比等结构化数据；" +
  "表格前后各空一行，单元格只放短句或数字。除表格外不要用 #、*、- 做标题/列表；" +
  "需要列举时用「① ② ③」或「1. 2. 3.」；不要解释你在做什么，直接输出报告正文。\n" +
  "5b. 表格里的数字也必须与摘要完全一致；没有数据的行宁可省略或写「暂无」，不许编。\n" +
  "6. ⭐ **要像老教师一样思考和推理，不要罗列数据**：每写一个判断，都要说清依据" +
  "（哪一次考试、哪一条课后反馈、辅导方案里的哪一条/哪一模块）；把「之前怎样 → 现在怎样 → 为什么 → 下一步怎么办」" +
  "串成有因果关系的分析。没有依据的话不要写。\n" +
  "7. **【学习进度】**：按时间轴说清「目前学到了哪里、复习到了哪个模块」——" +
  "以最近一次课后反馈的【课堂内容】为主，结合【下节课内容】；再对照辅导方案的【逐次课表】/【阶段安排】，" +
  "说明已经进行到第几条/共几条、是否按计划推进；如果反馈和方案对不上，要明确指出「方案可能已调整，请老师核对」，" +
  "不要硬说成“按计划”。没有反馈/方案时，如实说无法判断。\n" +
  "8. **【分数目标对比】**：把「初始分 / 本次月考分 / 目标分」放在一起比较，写清还差多少分、" +
  "从初始到现在提升了多少、大约每月提升多少；目标分可能来自辅导方案，也可能来自档案里填写的" +
  "「目标分数」，以摘要里的来源为准；如果两处都没有目标分、或没有带满分的考试记录，" +
  "就明确说「无法对比」，不要自己设一个目标分。\n" +
  "9. **【针对性提升方案】**：分点写（1. 2. 3.），每一点都要包含" +
  "「练什么（对应前面哪一个薄弱点）→ 怎么练（具体动作/材料/频率）→ 达到什么标准（可验收）→ 什么时候检查」，" +
  "并贴合老师下一步的教学计划；如果摘要里有「档案填写总课时」和已消耗估算，要把它作为课时投入/进度的依据；" +
  "不要写「多加练习」这类空话。\n" +
  "10. 【优势】与【薄弱与原因】也要有推理：优势要指出是哪次考试/哪类题稳定拿分；" +
  "薄弱要指出是知识漏洞、方法缺失还是审题计算习惯，并给出材料里的证据。\n" +
  "11. 严禁输出英文字段名/变量名（如 targetScore、fullScore、totalHours、score、student 等）；" +
  "一律用中文描述，例如写「目标分为120分」「满分为150分」「总课时40课时」。\n" +
  "12. 严禁使用 Markdown 粗体符号（不要输出 ** 或 __）；需要强调时直接写中文短句。" +
  "只允许使用第 5 条说明的 Markdown 表格。";

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

  if (!(await isFeatureEnabled("ai_analysis"))) {
    return NextResponse.json({ ok: false, error: "AI 学情报告已被管理员暂时关闭，请稍后再试。" }, { status: 503 });
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
    // ⚠️ 判定与迁移文件名都从 `manual-score.ts` 取（唯一来源）：以前这里写死 0017 且只判 message，
    //    于是 0019 之后提示会指错文件（2026-10 第十四批收拢）。
    if (isToolConstraintError(e)) {
      return NextResponse.json(
        {
          ok: false,
          // ⚠️ 报告已经生成了，只是没能存下来 —— 必须把它一起返回，否则用户白花一次 AI 调用
          report: text,
          error:
            "报告已生成，但没能存进档案：数据库还不接受这个归属工具。" +
            `请先在 Supabase SQL Editor 执行迁移 ${TOOL_CONSTRAINT_MIGRATION}` +
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
