/**
 * 教师**个人资料**（姓名 / 学科 / 校区）—— 唯一来源与兜底规则
 *
 * 用户 2026-10 的原始需求（逐字）：
 *   「我们能否在注册页面后加入填写信息模块，信息填写就需要填写姓名、科目、校区等你认为必要的，
 *     然后未来我们首页这个部分就显示这几个主要信息，然后导出来的档案文件什么的就可以从这里
 *     提取信息了，然后别忘了再加入一个修改信息的功能即可」
 *
 * 干什么：把"**老师是谁**"这件事从代码里搬出来。
 *   以前"郭庆杰"被写死在 13 处（其中 4 处是 `|| '郭庆杰'` 兜底，会**直接印进导出的 Word**）。
 *   现在统一从这里取；没填资料时**走兜底**（不是导出空白）。
 *
 * ⚠️ 三条口径（别自己改）：
 *   1. `subject` 存的是**学科 code**（math/chinese…），与三个工具的 `SUBJECTS` 同一套；
 *      给老师看的显示名要过 `subjectName()`。
 *   2. `campus` 是**机构校区**（老师所在校区）—— 与学生的"学校"（`feedback_students.campus`）**不是一回事**。
 *   3. 读不到（表没建 / DB 抖动）⇒ `null` ⇒ 调用方走兜底。**绝不抛错、绝不拦页面**。
 */

/** 学科清单（与 `public/tools/feedback.html` 的 SUBJECTS 同口径；`general` = 通用/其它） */
export const PROFILE_SUBJECTS: { code: string; name: string }[] = [
  { code: "chinese", name: "语文" },
  { code: "math", name: "数学" },
  { code: "english", name: "英语" },
  { code: "physics", name: "物理" },
  { code: "chemistry", name: "化学" },
  { code: "biology", name: "生物" },
  { code: "politics", name: "政治" },
  { code: "history", name: "历史" },
  { code: "geography", name: "地理" },
  { code: "general", name: "其它" },
];

/** code → 显示名（认不出来就原样返回；空 → 空串） */
export function subjectName(code: string | null | undefined): string {
  const c = String(code ?? "").trim();
  if (!c) return "";
  return PROFILE_SUBJECTS.find((s) => s.code === c)?.name ?? c;
}

/** 一个账号的资料（都在 `user_profiles` 里，缺的字段是空串） */
export type UserProfile = {
  teacherName: string;
  /** 学科 code（如 math） */
  subject: string;
  /** 机构校区 */
  campus: string;
  /** 老师手填过的落款（可空 ⇒ 用 `defaultSignature()` 拼） */
  sigTeacher: string;
};

/** 落款默认值：`学科 + 姓名 + 老师`（例：`数学郭老师`）—— 用户截图里就是这个格式 */
export function defaultSignature(name: string, subjectCode: string): string {
  const n = String(name ?? "").trim();
  if (!n) return "";
  return `${subjectName(subjectCode)}${n}老师`;
}

/** 最终落款：手填的优先，否则默认拼；都没有 → 空串（调用方再兜底） */
export function resolveSignature(
  p: Pick<UserProfile, "teacherName" | "subject" | "sigTeacher"> | null,
): string {
  if (!p) return "";
  const manual = String(p.sigTeacher ?? "").trim();
  if (manual) return manual;
  return defaultSignature(p.teacherName, p.subject);
}

export const PROFILE_MIGRATION = "supabase/migrations/0021_user_profiles.sql";

/** 表还没建时的提示（照功能开关表的先例：**点名迁移文件**，别让人猜） */
export const PROFILE_MIGRATION_HINT =
  `资料表还没建：请在 Supabase SQL Editor 执行 ${PROFILE_MIGRATION}（重复执行也安全）。` +
  `在它跑之前，页面照常可用（落款与导出走默认值）。`;

/** 输入校验（纯函数，服务端与测试共用一份） */
export type ProfileInput = {
  teacher_name?: unknown;
  subject?: unknown;
  campus?: unknown;
  sig_teacher?: unknown;
};

export type ProfileCheck =
  | { ok: true; value: UserProfile }
  | { ok: false; error: string };

export const MAX_PROFILE_TEXT = 40;

/** 校验并规整一份资料（姓名必填；学科必须是清单里的 code） */
export function checkProfileInput(input: ProfileInput): ProfileCheck {
  const name = String(input.teacher_name ?? "").trim();
  if (!name) return { ok: false, error: "请填写你的姓名（会用在落款和导出的文件上）。" };
  if (name.length > MAX_PROFILE_TEXT) return { ok: false, error: `姓名太长（${MAX_PROFILE_TEXT} 字以内）。` };

  const subject = String(input.subject ?? "").trim();
  if (!subject) return { ok: false, error: "请选择你的学科。" };
  if (!PROFILE_SUBJECTS.some((s) => s.code === subject)) {
    return { ok: false, error: "学科不在可选范围内。" };
  }

  const campus = String(input.campus ?? "").trim();
  const sig = String(input.sig_teacher ?? "").trim();
  if (campus.length > MAX_PROFILE_TEXT) return { ok: false, error: `校区太长（${MAX_PROFILE_TEXT} 字以内）。` };
  if (sig.length > MAX_PROFILE_TEXT) return { ok: false, error: `落款太长（${MAX_PROFILE_TEXT} 字以内）。` };

  return { ok: true, value: { teacherName: name, subject, campus, sigTeacher: sig } };
}
