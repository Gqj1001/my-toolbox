/**
 * 反馈工具的学段 / 科目 / 分类框架
 *
 * 说明：
 *  - 分类的**权威来源是数据库** feedback_categories 表（后台可增删改），
 *    这里的 CATEGORY_FALLBACK 只用于数据库读取失败时兜底，保证页面不空白。
 *  - 学段与科目是代码常量（改动频率极低，且有大量逻辑依赖：是否有教材、
 *    显示顺序等），因此不建表。
 */

/** 学段 */
export const STAGES = ["senior", "junior"] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  senior: "高中",
  junior: "初中",
};

/** 科目（九大科目 + 通用兜底） */
export type SubjectDef = {
  code: string;
  name: string;
  /** 该科目可用的学段；未列出即不支持 */
  stages: Stage[];
  /** 是否有教材/章节维度（有则前端显示教材下拉，管理页显示教材级联） */
  hasTextbook: boolean;
  sort_order: number;
};

export const SUBJECTS: SubjectDef[] = [
  { code: "chinese", name: "语文", stages: ["senior", "junior"], hasTextbook: true, sort_order: 10 },
  { code: "math", name: "数学", stages: ["senior", "junior"], hasTextbook: true, sort_order: 20 },
  { code: "english", name: "英语", stages: ["senior", "junior"], hasTextbook: true, sort_order: 30 },
  { code: "physics", name: "物理", stages: ["senior", "junior"], hasTextbook: true, sort_order: 40 },
  { code: "chemistry", name: "化学", stages: ["senior", "junior"], hasTextbook: true, sort_order: 50 },
  { code: "biology", name: "生物", stages: ["senior", "junior"], hasTextbook: true, sort_order: 60 },
  { code: "politics", name: "政治", stages: ["senior"], hasTextbook: true, sort_order: 70 },
  { code: "history", name: "历史", stages: ["senior", "junior"], hasTextbook: true, sort_order: 80 },
  { code: "geography", name: "地理", stages: ["senior", "junior"], hasTextbook: true, sort_order: 90 },
  { code: "general", name: "通用", stages: ["senior", "junior"], hasTextbook: false, sort_order: 100 },
];

const SUBJECT_BY_CODE = new Map(SUBJECTS.map((s) => [s.code, s]));

export function getSubjectDef(code: string): SubjectDef | undefined {
  return SUBJECT_BY_CODE.get(code);
}

export function subjectLabel(code: string): string {
  return SUBJECT_BY_CODE.get(code)?.name ?? code;
}

export function stageLabel(code: string | null | undefined): string {
  if (!code) return "";
  return STAGE_LABELS[code as Stage] ?? code;
}

/** 该科目在该学段下是否有教材维度（用于决定是否显示教材下拉） */
export function subjectHasTextbook(code: string): boolean {
  return SUBJECT_BY_CODE.get(code)?.hasTextbook ?? false;
}

/** 按学段筛选可用科目 */
export function getSubjectsForStage(stage: Stage): SubjectDef[] {
  return SUBJECTS.filter((s) => s.stages.includes(stage));
}

export function isValidStage(value: unknown): value is Stage {
  return typeof value === "string" && (STAGES as readonly string[]).includes(value);
}

/**
 * 需要按教材/章节区分的分类（只有这两个是各科各不同的）
 * 其余 6 个通用分类所有科目共用，教材/章节留空。
 */
export const CHAPTER_CATEGORIES = ["课堂内容", "下节课内容"] as const;

export function isChapterCategory(name: string): boolean {
  return (CHAPTER_CATEGORIES as readonly string[]).includes(name);
}

/** 通用分类的兜底定义（数据库读取失败时使用） */
export const CATEGORY_FALLBACK: Array<{ name: string; sort_order: number }> = [
  { name: "课堂内容", sort_order: 10 },
  { name: "课堂表现（正面）", sort_order: 20 },
  { name: "课堂表现（需改进）", sort_order: 30 },
  { name: "知识掌握评价", sort_order: 40 },
  { name: "改进建议", sort_order: 50 },
  { name: "分层建议", sort_order: 60 },
  { name: "作业布置", sort_order: 70 },
  { name: "下节课内容", sort_order: 80 },
];

/** 关键词查询的维度过滤条件 */
export type KeywordScope = {
  stage?: string | null;
  subject?: string | null;
  /** 教材 id；传 null 表示只要「不分教材」的词 */
  textbookId?: number | null;
  /** 章节 id；传 null 表示只要「不分章节」的词 */
  chapterId?: number | null;
  /** 只看某个分类 */
  category?: string | null;
};

/** 把 URL 查询参数解析成 scope（非法值忽略，避免注入/报错） */
export function parseScope(params: {
  stage?: string | null;
  subject?: string | null;
  textbook?: string | null;
  chapter?: string | null;
  category?: string | null;
}): KeywordScope {
  const toId = (v: string | null | undefined): number | null => {
    if (v === undefined || v === null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return {
    stage: isValidStage(params.stage) ? params.stage : null,
    subject: params.subject && SUBJECT_BY_CODE.has(params.subject) ? params.subject : null,
    textbookId: toId(params.textbook),
    chapterId: toId(params.chapter),
    category: params.category ? String(params.category) : null,
  };
}
