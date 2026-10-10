/**
 * 学情分析 · 报告装配（**纯函数**：不碰数据库、不调 AI、不认 React）
 *
 * 输入 = 学员档案那一行 + 这个学生的**全部记录**（`feedback_history` 的原始行）。
 * 输出 = 结构化报告：概览 / 成绩趋势 / 课时 / 薄弱与失分 + 一份给 AI 的纯文本摘要。
 *
 * 为什么单独成文件：
 *   · 纯函数**好写好测**（`tests/student-report.test.mjs` 不用起服务、不用真浏览器）；
 *   · 同一份报告要给**两处**用 —— 档案详情页（免费，直接渲染）与
 *     `/api/students/analysis`（会员，拿它当 AI 的输入）。
 *     各算一遍就是「同一件事两个来源」，正是本项目反复踩过的坑。
 *
 * ⚠️ **抽取的底线：抽不到就说抽不到，绝不猜。**
 *    三个工具的正文格式是我们自己定的（`【课堂表现】`、`【课时安排】共 N 课时`、
 *    paper 的「核心薄弱板块集中在以下 N 处：…」），但**老数据、老师手改过的正文**
 *    都可能没有这些标记。那时宁可少显示一块、并在 `notes` 里如实说一句，
 *    也**绝不能**编一条"薄弱模块"出来 —— 老师会拿它去跟家长说。
 *
 * ⚠️ 这里的日期一律是 **ISO**（`YYYY-MM-DD`）。给老师看的「10月7日」由页面用
 *    `feedback-db.ts` 的 `formatDisplayDate()` 转（那个函数是显示口径的唯一来源，
 *    本文件**故意不重复实现**）。
 */

import type { HistoryRow, StudentRow } from "@/lib/feedback-db";

/** 归属工具 → 给老师看的名字。**标签的唯一来源**（页面与接口都从这里取）。 */
export const TOOL_LABELS: Record<string, string> = {
  "math-plan": "辅导方案",
  paper: "试卷分析",
  feedback: "课后反馈",
  analysis: "学情报告",
};

/** 学情报告本身的归属工具名（写进 `feedback_history.tool`）
 *  ⚠️ 必须与两条**同时**保持一致，否则接口 400 或写库撞约束（23514）：
 *     · 迁移 `0017_history_tool_allow_analysis.sql` 里的 CHECK
 *     · `src/app/api/students/route.ts` 的 `ALLOWED_TOOLS` */
export const ANALYSIS_TOOL = "analysis";

/** 参与统计的工具（**不含 `analysis`**）—— 报告不能拿自己当输入，否则会越滚越离谱 */
const SOURCE_TOOLS = ["math-plan", "paper", "feedback"] as const;

export type ReportInput = {
  name: string;
  student: Pick<StudentRow, "grade" | "campus" | "teacher" | "subject" | "class_name" | "attitude" | "extra"> | null;
  rows: HistoryRow[];
};

export type ScorePoint = {
  date: string;        // ISO
  title: string;
  tool: string;
  score: number;
  fullScore: number;
  /** 得分率 %，保留 1 位小数 */
  percent: number;
};

export type StudentReport = {
  name: string;
  identity: {
    grade: string; campus: string; teacher: string; subject: string;
    className: string; attitude: string;
    /** 工具专属字段（extra）展平成「k=v」给人看；空则空串 */
    extra: string;
  };
  overview: {
    /** 参与统计的记录条数（不含学情报告自身） */
    total: number;
    byTool: { tool: string; label: string; count: number; lastDate: string }[];
    firstDate: string;
    lastDate: string;
    /** 首末相隔天数；只有一条记录或日期缺失时为 null */
    spanDays: number | null;
    excludedReports: number;
  };
  scores: ScorePoint[];
  trend: {
    count: number;
    firstPercent: number;
    lastPercent: number;
    /** 末次 - 首次（百分点） */
    delta: number;
    avgPercent: number;
    best: ScorePoint;
    worst: ScorePoint;
  } | null;
  hours: {
    total: number;
    entries: { date: string; title: string; hours: number }[];
    /** 有辅导方案、但正文里读不到课时的份数（如实报，不猜） */
    plansWithoutHours: number;
  };
  weaknesses: { tool: string; label: string; date: string; title: string; text: string }[];
  /** 「抽不到 / 没算进去」的如实说明（要显示给老师看，不能只存在注释里） */
  notes: string[];
  /** 交给 AI 的结构化摘要（也顺手当"报告依据"给人看） */
  digest: string;
};

/* ==========================================================================
   正文抽取（三个工具的正文格式都是我们自己定的，但**抽不到不猜**）
   ========================================================================== */

/** 正文里 `【小标题】正文…` 的段落；同名标题出现多次就**都保留**（合并会丢信息） */
export function extractSections(text: string): { label: string; body: string }[] {
  const s = String(text ?? "");
  const marks: { label: string; start: number; bodyStart: number }[] = [];
  const re = /【([^】\n]{1,20})】/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    marks.push({ label: m[1].trim(), start: m.index, bodyStart: m.index + m[0].length });
  }
  return marks.map((mk, i) => ({
    label: mk.label,
    body: s.slice(mk.bodyStart, i + 1 < marks.length ? marks[i + 1].start : s.length).trim(),
  }));
}

/** 从辅导方案正文的【课时安排】里读「共 N 课时」；**读不到就 null**（不猜、不默认 0） */
export function parsePlanHours(text: string): number | null {
  const sec = extractSections(text).find((x) => x.label.includes("课时安排"));
  if (!sec) return null;
  const m = sec.body.match(/(\d{1,4})\s*课时/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** paper 报告里那句固定句式：「核心薄弱板块集中在以下 N 处：A；B；C。」取不到就空数组 */
export function extractPaperWeakness(text: string): string[] {
  const m = String(text ?? "").match(/核心薄弱板块集中在以下\s*\d+\s*处：([^。\n]*)/);
  if (!m) return [];
  return m[1].split(/[；;]/).map((x) => x.trim()).filter(Boolean);
}

/** feedback 正文里与「失分/掌握」有关的段落名（按这个顺序抽） */
const FEEDBACK_WEAK_LABELS = ["主要失分点", "知识掌握"];

/* ==========================================================================
   装配
   ========================================================================== */

const round1 = (n: number) => Math.round(n * 10) / 10;

/** ISO 日期（取前 10 位）；拿不到返回空串 */
const isoOf = (v: string | null | undefined) => String(v ?? "").slice(0, 10);

/** 一条记录的排序键：优先**考试/记录日期**，没有就用创建时间；两者都没有排最后 */
function sortKey(r: HistoryRow): string {
  return isoOf(r.date) || isoOf(r.created_at) || "";
}

/** 按日期升序；同日按创建时间升序（保证两次运行顺序一致，测试才钉得住） */
function sortedAsc(rows: HistoryRow[]): HistoryRow[] {
  return rows.slice().sort((a, b) => {
    const ka = sortKey(a), kb = sortKey(b);
    if (ka !== kb) return ka < kb ? -1 : 1;
    return String(a.created_at ?? "") < String(b.created_at ?? "") ? -1 : 1;
  });
}

function daysBetween(a: string, b: string): number | null {
  const ta = Date.parse(`${a}T00:00:00Z`), tb = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.round(Math.abs(tb - ta) / 86_400_000);
}

/** 记录标题：优先 title，其次「试卷分析」这类标签 + 日期（**绝不编造考试名**） */
function titleOf(r: HistoryRow): string {
  const t = String(r.title ?? "").trim();
  if (t) return t;
  const tool = String(r.tool ?? "feedback");
  const d = isoOf(r.date);
  return `${TOOL_LABELS[tool] ?? tool}${d ? `（${d}）` : ""}`;
}

/** 把 extra（工具专属字段）展平成一行给人看；不是对象就当空 */
function extraText(extra: unknown): string {
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) return "";
  return Object.entries(extra as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" · ");
}

/**
 * 装配一份学情报告。
 *
 * ⚠️ `rows` 里属于 `analysis`（学情报告自己）的行会被**排除**并计数 ——
 *    否则「用报告生成报告」，越滚越离谱。
 */
export function buildStudentReport({ name, student, rows }: ReportInput): StudentReport {
  const all = Array.isArray(rows) ? rows : [];
  const reports = all.filter((r) => String(r.tool ?? "feedback") === ANALYSIS_TOOL);
  const source = sortedAsc(all.filter((r) => String(r.tool ?? "feedback") !== ANALYSIS_TOOL));

  // ---------------- 概览 ----------------
  const byTool = SOURCE_TOOLS.map((tool) => {
    const list = source.filter((r) => String(r.tool ?? "feedback") === tool);
    const last = list.length ? sortKey(list[list.length - 1]) : "";
    return { tool, label: TOOL_LABELS[tool], count: list.length, lastDate: last };
  }).filter((x) => x.count > 0);

  const firstDate = source.length ? sortKey(source[0]) : "";
  const lastDate = source.length ? sortKey(source[source.length - 1]) : "";

  // ---------------- 成绩趋势 ----------------
  const scores: ScorePoint[] = [];
  let scoresWithoutFull = 0;
  for (const r of source) {
    const score = typeof r.score === "number" ? r.score : null;
    const full = typeof r.full_score === "number" ? r.full_score : null;
    if (score === null) continue;
    if (full === null || full <= 0) { scoresWithoutFull++; continue; }
    scores.push({
      date: sortKey(r),
      title: titleOf(r),
      tool: String(r.tool ?? "feedback"),
      score,
      fullScore: full,
      percent: round1((score / full) * 100),
    });
  }

  let trend: StudentReport["trend"] = null;
  if (scores.length) {
    const percents = scores.map((s) => s.percent);
    const best = scores.reduce((a, b) => (b.percent > a.percent ? b : a));
    const worst = scores.reduce((a, b) => (b.percent < a.percent ? b : a));
    trend = {
      count: scores.length,
      firstPercent: scores[0].percent,
      lastPercent: scores[scores.length - 1].percent,
      delta: round1(scores[scores.length - 1].percent - scores[0].percent),
      avgPercent: round1(percents.reduce((a, b) => a + b, 0) / percents.length),
      best,
      worst,
    };
  }

  // ---------------- 课时（来自辅导方案正文） ----------------
  const planRows = source.filter((r) => String(r.tool ?? "feedback") === "math-plan");
  const hourEntries: { date: string; title: string; hours: number }[] = [];
  let plansWithoutHours = 0;
  for (const r of planRows) {
    const h = parsePlanHours(r.text);
    if (h === null) plansWithoutHours++;
    else hourEntries.push({ date: sortKey(r), title: titleOf(r), hours: h });
  }
  const hours = {
    total: hourEntries.reduce((a, b) => a + b.hours, 0),
    entries: hourEntries,
    plansWithoutHours,
  };

  // ---------------- 薄弱与失分（抽取，抽不到就在 notes 里说清） ----------------
  const weaknesses: StudentReport["weaknesses"] = [];
  let paperWithoutWeak = 0, feedbackWithoutWeak = 0;

  for (const r of source) {
    const tool = String(r.tool ?? "feedback");
    const base = { tool, date: sortKey(r), title: titleOf(r) };

    if (tool === "paper") {
      const items = extractPaperWeakness(r.text);
      if (!items.length) { paperWithoutWeak++; continue; }
      weaknesses.push({ ...base, label: "核心薄弱板块", text: items.join("；") });
      continue;
    }
    if (tool === "feedback") {
      const secs = extractSections(r.text).filter((s) => FEEDBACK_WEAK_LABELS.some((l) => s.label.includes(l)));
      if (!secs.length) { feedbackWithoutWeak++; continue; }
      for (const s of secs) weaknesses.push({ ...base, label: s.label, text: s.body });
      continue;
    }
    if (tool === "math-plan") {
      const sec = extractSections(r.text).find((s) => s.label.includes("学情诊断"));
      if (!sec || !sec.body) continue;   // 方案里没有学情诊断就不再单独计数（课时那边已经报过）
      weaknesses.push({ ...base, label: "学情诊断", text: sec.body });
    }
  }

  // ---------------- 「抽不到」的如实说明 ----------------
  const notes: string[] = [];
  if (!source.length) notes.push("这位学生还没有任何记录（辅导方案 / 试卷分析 / 课后反馈）。");
  if (plansWithoutHours > 0) {
    notes.push(`有 ${plansWithoutHours} 份辅导方案的正文里读不到「共 N 课时」，这几份**没有**计入累计课时。`);
  }
  if (paperWithoutWeak > 0) {
    notes.push(`有 ${paperWithoutWeak} 条试卷分析里没有出现「核心薄弱板块集中在以下 N 处」这句话，所以没有从它们里抽薄弱模块。`);
  }
  if (feedbackWithoutWeak > 0) {
    notes.push(`有 ${feedbackWithoutWeak} 条课后反馈里没有【主要失分点】/【知识掌握】段落，所以没有从它们里抽失分信息。`);
  }
  if (scoresWithoutFull > 0) {
    notes.push(`有 ${scoresWithoutFull} 条记录只有分数、没有满分，无法算得分率，未计入趋势。`);
  }
  if (trend && trend.count < 2) {
    notes.push("只有 1 次带分数的考试，看不出趋势（至少两次才能比较）。");
  }
  if (reports.length > 0) {
    notes.push(`统计时**排除**了 ${reports.length} 份历史学情报告（不能拿报告生成报告）。`);
  }

  // ---------------- 给 AI 的摘要 ----------------
  const lines: string[] = [];
  const id = {
    grade: String(student?.grade ?? ""), campus: String(student?.campus ?? ""),
    teacher: String(student?.teacher ?? ""), subject: String(student?.subject ?? ""),
    className: String(student?.class_name ?? ""), attitude: String(student?.attitude ?? ""),
    extra: extraText(student?.extra),
  };
  lines.push(`学生：${name}`);
  lines.push(
    `基本信息：${[
      id.grade && `年级 ${id.grade}`,
      id.subject && `科目 ${id.subject}`,
      id.campus && `校区 ${id.campus}`,
      id.teacher && `任课教师 ${id.teacher}`,
      id.className && `班级 ${id.className}`,
    ].filter(Boolean).join("；") || "（档案里还没填）"}`,
  );
  if (id.attitude) lines.push(`老师对该生的旧印象：${id.attitude}`);
  if (id.extra) lines.push(`工具专属信息：${id.extra}`);
  lines.push("");
  lines.push(`记录概览：共 ${source.length} 条（${byTool.map((b) => `${b.label} ${b.count} 条`).join("，") || "无"}）` +
    (firstDate && lastDate ? `；时间跨度 ${firstDate} ～ ${lastDate}` : ""));
  if (scores.length) {
    lines.push("");
    lines.push("考试成绩（按时间升序）：");
    for (const s of scores) {
      lines.push(`- ${s.date || "日期未知"} ${s.title}：${s.score}/${s.fullScore}（得分率 ${s.percent}%）`);
    }
    if (trend) {
      lines.push(`趋势：首次 ${trend.firstPercent}% → 末次 ${trend.lastPercent}%（${trend.delta >= 0 ? "+" : ""}${trend.delta} 个百分点），` +
        `平均 ${trend.avgPercent}%，最高 ${trend.best.percent}%（${trend.best.title}），最低 ${trend.worst.percent}%（${trend.worst.title}）`);
    }
  } else {
    lines.push("");
    lines.push("考试成绩：没有带分数与满分的记录，**无法给出分数趋势**。");
  }
  if (hourEntries.length || plansWithoutHours) {
    lines.push("");
    lines.push(`课时安排：累计 ${hours.total} 课时（来自 ${hourEntries.length} 份辅导方案）` +
      (plansWithoutHours ? `；另有 ${plansWithoutHours} 份方案读不到课时数` : ""));
    for (const e of hourEntries) lines.push(`- ${e.date || "日期未知"} ${e.title}：${e.hours} 课时`);
  }
  if (weaknesses.length) {
    lines.push("");
    lines.push("薄弱与失分（**摘自各工具正文原文**）：");
    for (const w of weaknesses) {
      lines.push(`- [${TOOL_LABELS[w.tool] ?? w.tool}·${w.label}] ${w.date || "日期未知"} ${w.title}：${w.text.slice(0, 200)}`);
    }
  } else {
    lines.push("");
    lines.push("薄弱与失分：现有记录的正文里没有抽到相关信息（**不要凭空推测**）。");
  }
  if (notes.length) {
    lines.push("");
    lines.push("数据说明（真实存在的缺口，不要在报告里假装没有）：");
    for (const n of notes) lines.push(`- ${n}`);
  }

  let digest = lines.join("\n");
  // 上限：AI 那边还有自己的上限，这里先截，避免把超长正文整段带走
  if (digest.length > 6000) digest = digest.slice(0, 6000) + "\n…（摘要过长已截断）";

  return {
    name,
    identity: id,
    overview: {
      total: source.length,
      byTool,
      firstDate,
      lastDate,
      spanDays: firstDate && lastDate ? daysBetween(firstDate, lastDate) : null,
      excludedReports: reports.length,
    },
    scores,
    trend,
    hours,
    weaknesses,
    notes,
    digest,
  };
}
