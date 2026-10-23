/**
 * 「补录历史材料」的校验与提示词 —— **唯一来源**（纯函数 + 常量，不碰网络）
 *
 * 背景（用户 2026-10 拍板，方案见 `docs/manual-backfill-plan.md`）：
 *   工具上线**之前**的反馈 / 试卷分析 / 辅导方案散在老师手里（Word、PDF、照片、纸）。
 *   本功能把它们交给 AI **整理成统一格式**后入档，于是学情分析能用到"全部历史"。
 *
 * ⚠️ **"统一格式"不是新发明的格式，而是现有三个工具已经在写的正文格式**：
 *   只要往这些标记上靠，`src/lib/student-report.ts` 的抽取规则**一行都不用改**。
 *   抽取规则（代码是唯一权威，改这里之前先去看那边）：
 *     · paper    → 「核心薄弱板块集中在以下 N 处：A；B；C。」+ 表格里的 `得分/满分`
 *     · math-plan→ `【课时安排】…共 N 课时` + `【学情诊断】…`
 *     · feedback → `【主要失分点】` / `【知识掌握】`
 *
 * ⚠️ 红线：**AI 只能写材料里出现过的内容**。宁可留空、宁可写 `[看不清]`，也不许推测。
 *    （本条与本项目视觉管线同口径；`tests/backfill.test.mjs` 有断言钉住提示词里写着它。）
 */

/** 三种材料 → 它们入档后归属哪个工具（**复用已有 tool 值 ⇒ 零迁移、学情分析零改动**） */
export const BACKFILL_KINDS = {
  paper: { tool: "paper", label: "试卷分析" },
  plan: { tool: "math-plan", label: "辅导方案" },
  feedback: { tool: "feedback", label: "课后反馈" },
} as const;

export type BackfillKind = keyof typeof BACKFILL_KINDS;

export function isBackfillKind(v: unknown): v is BackfillKind {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(BACKFILL_KINDS, v);
}

/** 教材文字上限：一份几十页的老方案转成文字也很少超过这个数（挡住误传大文件） */
export const MAX_MATERIAL_CHARS = 30_000;

export type BackfillInput = { kind?: unknown; text?: unknown };

export type BackfillCheck =
  | { ok: true; kind: BackfillKind; tool: string; text: string }
  | { ok: false; error: string };

/** 校验请求（路由与测试共用这一份） */
export function checkBackfillInput(input: BackfillInput): BackfillCheck {
  if (!isBackfillKind(input.kind)) {
    return { ok: false, error: "材料类型不合法（只能是 paper / plan / feedback）。" };
  }
  const effectiveKind = input.kind as BackfillKind;
  const text = String(input.text ?? "").trim();
  if (!text) return { ok: false, error: "材料内容是空的。" };
  if (text.length > MAX_MATERIAL_CHARS) {
    return {
      ok: false,
      error: `材料太长（${text.length} 字，上限 ${MAX_MATERIAL_CHARS} 字）。请拆成几份分别补录。`,
    };
  }
  return { ok: true, kind: effectiveKind, tool: BACKFILL_KINDS[effectiveKind].tool, text };
}

/* ==========================================================================
   提示词（三段，格式对照现有生成器写死）
   ========================================================================== */

/** 三段提示词**共有**的红线（放在最前面，避免每段重复写） */
const COMMON_RULES = [
  "你在帮一位高中数学老师把**旧材料**整理进学生档案。这些材料是工具上线之前做的，格式五花八门。",
  "",
  "【最重要的三条规矩】",
  "1. **只允许写材料里出现过的事实**。不许推测、不许补全、不许编造数字或人名。",
  "   材料里没有的字段就**留空**（宁缺勿编）。看不清的地方写 [看不清]。",
  "2. **不许改变材料的意思**。可以调整排版、统一标点与小标题，但不许删掉信息、不许加评价。",
  "3. 输出严格的 JSON（不要代码块围栏），结构见最后。",
  "4. **日期能抽就抽**：材料正文里如果写了具体日期（如「8月25日数学课反馈」「2026年8月25日」「2026-08-25」），",
  "   把它填进 `facts.examDate`；只写了月日就**原样写「8月25日」**（不要自己补年份）；",
  "   完全没写日期就留空，**绝不猜**。课后反馈尤其常见这种情况，请优先从开头/标题里找。",
].join("\n");

const JSON_CONTRACT = [
  "",
  "【输出 JSON（严格按这个结构，不要加解释文字）】",
  "{",
  '  "text": "整理好的正文（见下面的格式要求；用 \\n 换行）",',
  '  "facts": { "examDate": "", "examName": "", "score": "", "fullScore": "", "hours": "" },',
  '  "uncertain": ["材料里看不清/有歧义的地方，逐条写清"],',
  '  "missing": ["材料里**没有**的关键信息，逐条写清（例如 得分、满分）"]',
  "}",
  "⚠️ `facts` 里没有的字段写空串；`score`/`fullScore` 只填数字（不要带“分”），确实没有满分就留空。",
].join("\n");

/** 试卷分析：往 `【错题分析】` 表格 + 「核心薄弱板块集中在以下 N 处：…」上靠 */
export const PAPER_PROMPT = [
  COMMON_RULES,
  "",
  "【本次任务：把旧「试卷分析」整理成我们系统的报告格式】",
  "按下面这个骨架输出（有哪段写哪段，没有的整段省略；**不要编造**）：",
  "",
  "【学员基本信息】",
  "学生姓名：xxx　　年级：xxx　　（材料里没有的项省略）",
  "【试卷分析】",
  "考试时间：xxx　　考试名称：xxx　　考试科目：xxx",
  "试卷总分：xxx　　试卷得分：xxx　　（只填材料里写了的）",
  "【错题分析】",
  "题号 | 题型 | 分值 | 得分 | 难度 | 考察知识点 | 失分情况及原因分析",
  "（逐行照抄材料的错题表；材料里没有的列留空，**不要自己填**）",
  "【教学辅导建议/安排】",
  "（材料里有建议/措施就照抄过来，没有就省略这一段）",
  "核心薄弱板块集中在以下 N 处：A；B；C。",
  "（⭐ **这一句必须有**：N 是处数，A/B/C 是**材料里真实出现过的**薄弱知识点/模块。",
  "  如果材料没有明确写薄弱板块，就**从错题表的知识点列里归纳**（这属于整理，不算编造）；",
  "  归纳不出来就写 `核心薄弱板块集中在以下 0 处：材料里没有可归纳的薄弱点。`）",
  "分析人：xxx",
  JSON_CONTRACT,
].join("\n");

/** 辅导方案：往 `【学情诊断】` 与 `【课时安排】共 N 课时` 上靠 */
export const PLAN_PROMPT = [
  COMMON_RULES,
  "",
  "【本次任务：把旧「辅导方案/课时计划」整理成我们系统的格式】",
  "按下面这个骨架输出（有哪段写哪段，没有的整段省略）：",
  "",
  "【学员基本信息】",
  "学生姓名：xxx　　年级：xxx　　（材料里没有的项省略）",
  "【学情诊断】",
  "（照抄材料里对学生情况的描述；没有就省略）",
  "【提分目标】xxx → xxx 分",
  "（材料里写了目标分数就照抄；没写就省略）",
  "【课时安排】共 xxx 课时",
  "（⭐ **这个标记必须有**：材料写了总课时就填数字；**没写就写 `【课时安排】材料未写明课时`**，",
  "  不要猜一个数字。这一行决定「课时累计」统计能不能算上）",
  "【阶段安排】",
  "（材料里逐阶段/逐模块的计划，按「模块 | 内容 | 课时 | 目标」逐行整理；没有就省略）",
  JSON_CONTRACT,
].join("\n");

/** 课后反馈：往 `【课堂表现】/【知识掌握】/【主要失分点】/【改进建议】` 上靠 */
export const FEEDBACK_PROMPT = [
  COMMON_RULES,
  "",
  "【本次任务：把旧「课后反馈/课堂记录」整理成我们系统的格式】",
  "如果开头/标题写了日期（如「8月25日数学课反馈」），**务必填进 facts.examDate**，让老师少填一步。",
  "用 `【小标题】` 分段，小标题**只能**从下面这几个里选（有哪段写哪段）：",
  "【课堂表现】【知识掌握】【主要失分点】【课堂内容】【改进建议】【课后作业】",
  "",
  "【课堂表现】",
  "（照抄材料里对这节课表现的描述）",
  "【主要失分点】",
  "（⭐ 材料里写了失分点/薄弱处就照抄到这里；**没写就省略这一段**，不要编）",
  JSON_CONTRACT,
].join("\n");

export const BACKFILL_PROMPTS: Record<BackfillKind, string> = {
  paper: PAPER_PROMPT,
  plan: PLAN_PROMPT,
  feedback: FEEDBACK_PROMPT,
};

/** 取某个材料类型的提示词 */
export function promptFor(kind: BackfillKind): string {
  return BACKFILL_PROMPTS[kind] ?? "";
}

/* ==========================================================================
   输出侧的纯函数（好写好测；路由只负责调模型与拼响应）
   ========================================================================== */

export type BackfillFacts = {
  examDate: string;
  examName: string;
  score: string;
  fullScore: string;
  hours: string;
};

export type BackfillResult = {
  text: string;
  facts: BackfillFacts;
  uncertain: string[];
  missing: string[];
  /** 长度自检：输出比输入长太多时提示"可能被扩写了"（不拦，只提醒） */
  suspiciousLength: boolean;
};

const EMPTY_FACTS: BackfillFacts = { examDate: "", examName: "", score: "", fullScore: "", hours: "" };

/** 只留短字符串、去掉空项（模型偶尔会塞 null 或超长文本） */
function strList(v: unknown, max = 20): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => String(x ?? "").trim())
    .filter(Boolean)
    .map((s) => s.slice(0, 200))
    .slice(0, max);
}

/** 把模型返回的 JSON 对象规整成结果（**纯函数**，测试直接打它） */
export function normalizeBackfill(parsed: unknown, inputText: string): BackfillResult | null {
  const o = (parsed ?? {}) as Record<string, unknown>;
  const text = String(o.text ?? "").trim();
  if (!text) return null;
  const f = (o.facts ?? {}) as Record<string, unknown>;
  const facts: BackfillFacts = {
    examDate: String(f.examDate ?? "").trim().slice(0, 40),
    examName: String(f.examName ?? "").trim().slice(0, 60),
    score: String(f.score ?? "").trim().slice(0, 20),
    fullScore: String(f.fullScore ?? "").trim().slice(0, 20),
    hours: String(f.hours ?? "").trim().slice(0, 20),
  };
  // ⚠️ 长度自检：整理只会**变短或差不多**（去空白、统一标点）。
  //    输出比输入长 1.5 倍以上 ⇒ 很可能是模型"扩写"了 ⇒ 提醒老师重点核对（不拦）。
  //    ⚠️ 第一版这里有个 `Math.max(200, inputText.length)` 的**字数下限**，
  //    结果短材料（<200 字）永远算不出可疑 —— 那正是"写死数字"的老毛病（本项目坑 1）。
  //    现在纯按**比例**判：只要输出 > 输入 × 1.5 就提醒，与材料绝对长度无关。
  const suspiciousLength = text.length > inputText.length * 1.5;
  return {
    text,
    facts: facts ?? EMPTY_FACTS,
    uncertain: strList(o.uncertain),
    missing: strList(o.missing),
    suspiciousLength,
  };
}

/** 从正文里抠 JSON 对象（模型有时会把 JSON 包在解释文字或代码块里） */
export function extractJsonObject(raw: string): Record<string, unknown> | null {
  const s = String(raw ?? "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(s.slice(start, end + 1));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
