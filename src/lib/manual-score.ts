/**
 * 手动补录成绩 · 一条记录的**校验与规整**（纯函数：不碰数据库、不认 React）
 *
 * 干什么：学员档案页里，老师手填「学校期中考试 105/150」这种消息 ——
 * 这不是任何工具生成的，而是**老师自己的事实**。校验通过后它就是一条正常的
 * `feedback_history` 记录（`tool='manual'`），于是：
 *   · 出现在档案详情页的记录列表里；
 *   · **自动进入学情分析的「成绩趋势」**（那份统计本来就扫全部带分数的记录，不挑工具）；
 *   · 生成 AI 学情报告时也会被算进去。
 *
 * 为什么单独成文件（而不是把校验写在路由里）：
 *   · 路由里再写一遍 = 两处口径（本项目反复踩过的"第二个来源"坑）；
 *   · 纯函数**好写好测**：`tests/manual-score.test.mjs` 不用起服务就能钉住每一条规则。
 *
 * ⚠️ 三条硬口径（改之前先想清楚）：
 *   1. **满分是必填**。没有满分就算不出得分率（`student-report.ts` 会把这种记录
 *      排除在趋势之外并在 notes 里如实说明），老师填了却"没进趋势"一定被当成 bug。
 *   2. **正文 `text` 不是空串**。库里其它记录都有正文，列表靠它显示；这里写一句
 *      「手动补录 · 由老师在档案页填写」并附上备注，让"这条从哪来"一眼可见。
 *   3. **数值范围**：0 ≤ 得分 ≤ 满分 ≤ 1000。得分超过满分一定是填错了（宁可报错）。
 */

export type ManualScoreInput = {
  student_name?: unknown;
  title?: unknown;
  date?: unknown;
  score?: unknown;
  full_score?: unknown;
  type_name?: unknown;
  subject?: unknown;
  note?: unknown;
};

export type ManualScoreRow = {
  student_name: string;
  text: string;
  date: string;
  type_name: string | null;
  subject: string | null;
  tool: "manual";
  title: string;
  score: number;
  full_score: number;
};

export type ManualScoreResult =
  | { ok: true; row: ManualScoreRow }
  | { ok: false; error: string };

/** 正文里的固定前缀（列表里一眼看出这条不是工具生成的） */
export const MANUAL_TEXT_PREFIX = "手动补录 · 由老师在档案页填写";

/** 日期收成 `YYYY-MM-DD`；`2026-10-07T10:00:00Z` 也算合法 */
function toIsoDate(v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (!y || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  // 真日历校验（照 `parseDisplayDate` 的口径：2026-02-30 这种要被拒）
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${m[1]}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** 数字字段：允许字符串（表单永远是字符串） */
function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

export const EXAM_TYPES = ["校考", "月考", "期中", "期末", "模考", "其他"] as const;

export type ManualScoreRequest = Omit<ManualScoreInput, "student_name"> & {
  op: "manual";
  student_name: string;
};

/** 数据库那条 `feedback_history.tool` CHECK 约束的**唯一来源**（迁移文件）。
 *
 *  ⚠️ 必须**跟着最后一条改约束的迁移更新**（现在是 0019）。写死旧文件名的后果：
 *     撞约束的老师照着提示跑一条**解决不了问题**的迁移，然后回来还是一样报错。
 *     `tests/manual-score.test.mjs` 与 `tests/student-report.test.mjs` 各有一条契约断言钉住它，
 *     而且 `src/app/api/students/**` 两个路由都从这里取（不许各处自己写一个字符串）。 */
export const TOOL_CONSTRAINT_MIGRATION = "supabase/migrations/0019_history_tool_allow_manual.sql";

/**
 * "这次写入是因为 `feedback_history.tool` 的 CHECK 约束被拒了吗"。
 *
 * ⚠️ **判定只看约束名**（2026-10 实测踩到，第十四批）：
 *    - PostgREST 有时把约束名放在 `details` 里（`message` 只有一句
 *      `new row for relation "feedback_history" violates check constraint …`），
 *      所以 `code | message | details | hint` **要拼起来一起判**；只看 `message` 会让
 *      本该校验 409 + 点名迁移的路径返回 500 +「保存失败」（新套件当场抓到）。
 *    - ⚠️ **不许按 SQLSTATE `23514` 判**（第一版就是这么写的，是个真隐患）：
 *      `23514` 是"违反任意 CHECK 约束"，本项目里 `feedback_students_extra_is_object`
 *      （`extra` 必须是 JSON 对象）**也是 23514**。按 code 判会把"extra 传错了"
 *      误报成「请去 Supabase 跑 0019 迁移」—— 让人跑去跑一条**无关**的迁移，
 *      比只说一句"保存失败"更糟。2026-10 第十四批由变异自证发现并收紧。
 */
export function isToolConstraintError(e: unknown): boolean {
  if (!e) return false;
  const parts =
    typeof e === "string"
      ? [e]
      : [
          (e as { code?: unknown }).code,
          (e as { message?: unknown }).message,
          (e as { details?: unknown }).details,
          (e as { hint?: unknown }).hint,
        ];
  const all = parts.map((p) => String(p ?? "")).join(" | ");
  return /feedback_history_tool_check|check_violation/i.test(all);
}

/** 提交/删除用的接口与请求体。
 *
 *  ⚠️ 抽到这里是为了**只有一个来源**：页面组件与测试都从这里取，
 *     以后接口改名/换字段不会出现"测试还在打老地址"这种假绿。 */
export function manualScoreHooks() {  return {
    /** 新增一条：POST /api/students { op:"manual", student_name, …表单字段 } */
    create: (studentName: string, form: Omit<ManualScoreInput, "student_name"> = {}) => {
      const body: ManualScoreRequest = { op: "manual", student_name: studentName, ...form };
      return { url: "/api/students", method: "POST" as const, body };
    },
    /** 删除一条：DELETE /api/students?id=<historyId> */
    remove: (id: number) => ({
      url: `/api/students?id=${encodeURIComponent(String(id))}`,
      method: "DELETE" as const,
    }),
  };
}

export function normalizeManualScore(input: ManualScoreInput): ManualScoreResult {
  const student_name = String(input.student_name ?? "").trim();
  if (!student_name) return { ok: false, error: "缺少学生姓名。" };
  if (student_name.length > 100) return { ok: false, error: "学生姓名过长（最多 100 字）。" };

  const title = String(input.title ?? "").trim();
  if (!title) return { ok: false, error: "请填写考试名称（例如「学校期中考试」）。" };
  if (title.length > 100) return { ok: false, error: "考试名称过长（最多 100 字）。" };

  const date = toIsoDate(input.date);
  if (!date) return { ok: false, error: "请填写合法的考试日期（格式：2026-10-07）。" };

  const score = toNumber(input.score);
  if (score === null) return { ok: false, error: "请填写得分（数字）。" };
  const full_score = toNumber(input.full_score);
  if (full_score === null) return { ok: false, error: "请填写满分（数字）—— 没有满分就算不出得分率。" };

  if (score < 0 || full_score <= 0) return { ok: false, error: "分数必须是正数。" };
  if (score > full_score) return { ok: false, error: `得分（${score}）不能大于满分（${full_score}）。` };
  if (full_score > 1000) return { ok: false, error: "满分超过 1000，请检查是不是填错了。" };

  const type_name = String(input.type_name ?? "").trim();
  if (type_name && type_name.length > 40) return { ok: false, error: "考试类型过长。" };
  const subject = String(input.subject ?? "").trim();
  if (subject && subject.length > 20) return { ok: false, error: "科目过长。" };
  const note = String(input.note ?? "").trim();
  if (note.length > 500) return { ok: false, error: "备注过长（最多 500 字）。" };

  // 满分的整数性不做要求（有些卷子是 100.5 这种），只把**多余的 0** 去掉（150.0 → 150）
  const clean = (n: number) => (Number.isInteger(n) ? n : Number(n.toFixed(2)));
  const text = [
    MANUAL_TEXT_PREFIX,
    `考试名称：${title}`,
    `得分：${clean(score)}${type_name ? `（${type_name}）` : ""} / 满分：${clean(full_score)}`,
    note ? `备注：${note}` : "",
  ].filter(Boolean).join("\n");

  return {
    ok: true,
    row: {
      student_name,
      text,
      date,
      type_name: type_name || null,
      subject: subject || "数学",
      tool: "manual",
      title,
      score: clean(score),
      full_score: clean(full_score),
    },
  };
}
