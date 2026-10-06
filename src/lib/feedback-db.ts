import "server-only";

import { createClient } from "@/lib/supabase/server";
import {
  CATEGORY_FALLBACK,
  isChapterCategory,
  type KeywordScope,
} from "@/lib/feedback-taxonomy";

/** 关键词库一行 */
export type KeywordRow = {
  id: number;
  subject: string;
  category: string;
  keyword: string;
  sort_order: number;
  stage: string | null;
  textbook_id: number | null;
  chapter_id: number | null;
  chapter_name: string | null;
};

export type PhraseRow = {
  id: number;
  phrase: string;
  sort_order: number;
};

export type CategoryRow = {
  id: number;
  name: string;
  sort_order: number;
  stage: string | null;
  subject: string | null;
  active: boolean;
};

export type TextbookRow = {
  id: number;
  stage: string;
  subject: string;
  /** 版本名，如「人教A版」「统编版」 */
  version: string;
  /** 册次名，如「必修第一册」「必修一」；'-' 表示该版本无册次之分 */
  name: string;
  sort_order: number;
};

export type ChapterRow = {
  id: number;
  textbook_id: number;
  name: string;
  sort_order: number;
};

export type StudentRow = {
  id: number;
  name: string;
  subject: string | null;
  salutation: string | null;
  teacher: string | null;
  type: string | null;
  notes: string | null;
  updated_at: string;
};

export type HistoryRow = {
  id: number;
  student_name: string;
  text: string;
  date: string | null;
  type_name: string | null;
  subject: string | null;
  created_at: string;
};

/**
 * 关键词库装配成前端原本使用的结构：
 *   { math: { categories: [{ name: '课堂内容', keywords: [...] }] } }
 * 这样改造 HTML 时只需替换 loadData/saveData，渲染代码无需改动。
 */
export type KeywordTree = Record<
  string,
  { categories: Array<{ name: string; keywords: string[] }> }
>;

const KEYWORD_COLUMNS =
  "id, subject, category, keyword, sort_order, stage, textbook_id, chapter_id, chapter_name";

/**
 * 关键词库的进程内 TTL 缓存（30 秒）。
 *
 * 为什么只缓存「不带 category 的按维度查询」：那是工具页每次打开都要跑的那条，
 * 且结果**全用户共享**（RLS 是 using(true)，不区分用户），最适合缓存。
 * 带 category 的查询（管理后台用）不走缓存，避免后台改动看不到。
 *
 * ⚠️ 不用 `unstable_cache`：它在 Next 16.3.8 下会让函数返回空数组（tools 表已实测踩过）。
 * 缓存键用「被 scope 实际影响的过滤条件」拼出来，避免不同 scope 互相污染。
 */
const KEYWORD_TTL_MS = 30_000;
const keywordCache = new Map<string, { rows: KeywordRow[]; at: number }>();
const keywordInflight = new Map<string, Promise<KeywordRow[]>>();

/** 清掉关键词缓存（改过关键词表之后调用；本进程立即生效）
 *
 *  名字用 invalidate* 而不是 revalidate*，是为了跟 Next 的 revalidatePath /
 *  revalidateTag 区分开 —— 那两者都**清不掉**这个进程内缓存（实测过）。
 *  调用点：admin/feedback-keywords/actions.ts 与 admin/feedback-candidates/actions.ts
 *  各自的 revalidate()（所有写操作都会经过它）。 */
export function invalidateKeywords() {
  keywordCache.clear();
  keywordInflight.clear();
}

/** 把 scope 规范化成缓存键（只含真正参与过滤的维度） */
function keywordCacheKey(scope: KeywordScope): string {
  const has = (k: keyof KeywordScope) => Object.prototype.hasOwnProperty.call(scope, k);
  return JSON.stringify([
    scope.stage ?? null,
    scope.subject ?? null,
    scope.category ?? null,
    has("textbookId") ? (scope.textbookId ?? "null") : "any",
    has("chapterId") ? (scope.chapterId ?? "null") : "any",
  ]);
}

/**
 * 读取关键词。
 *
 * scope 语义（都是「不传 = 不过滤」）：
 *   stage / subject  —— 精确匹配
 *   textbookId       —— 传数字 = 该教材（含该教材下全部章节）；传 null = 只要不分教材的
 *   chapterId        —— 传数字 = 该章节；传 null = 只要不分章节的
 *   category         —— 只取某个分类
 *
 * 已归档（archived_at 不为空）的行永远不返回。
 */
export async function getKeywords(scope: KeywordScope = {}): Promise<KeywordRow[]> {
  // 只有「工具页会用到、且结果与用户无关」的那类查询才走缓存（见 KEYWORD_TTL_MS 注释）。
  const cacheable = !scope.category;
  const key = cacheable ? keywordCacheKey(scope) : "";

  if (cacheable) {
    const hit = keywordCache.get(key);
    if (hit && Date.now() - hit.at < KEYWORD_TTL_MS) return hit.rows;
    const flying = keywordInflight.get(key);
    if (flying) return flying;
  }

  const run = loadKeywords(scope).then((rows) => {
    if (cacheable) keywordCache.set(key, { rows, at: Date.now() });
    return rows;
  }).finally(() => {
    if (cacheable) keywordInflight.delete(key);
  });

  if (cacheable) keywordInflight.set(key, run);
  return run;
}

/** 实际查库（不含缓存） */
async function loadKeywords(scope: KeywordScope = {}): Promise<KeywordRow[]> {
  const supabase = await createClient();
  let q = supabase
    .from("feedback_keywords")
    .select(KEYWORD_COLUMNS)
    .is("archived_at", null);

  if (scope.stage) q = q.eq("stage", scope.stage);
  if (scope.subject) q = q.eq("subject", scope.subject);
  if (scope.category) q = q.eq("category", scope.category);

  // 显式指定（键存在）时才按该维度过滤：null = 只要「无归属」的，数字 = 精确匹配
  if (Object.prototype.hasOwnProperty.call(scope, "textbookId")) {
    q = scope.textbookId == null ? q.is("textbook_id", null) : q.eq("textbook_id", scope.textbookId);
  }
  if (Object.prototype.hasOwnProperty.call(scope, "chapterId")) {
    q = scope.chapterId == null ? q.is("chapter_id", null) : q.eq("chapter_id", scope.chapterId);
  }

  const { data, error } = await q
    .order("subject", { ascending: true })
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });

  if (error) {
    console.error("[feedback] 读取关键词失败:", error.code, error.message);
    return [];
  }
  return (data ?? []) as KeywordRow[];
}

/** 读取通用分类（数据库为权威来源，含 stage/subject 为空的全局分类） */
export async function getCategories(stage?: string | null): Promise<CategoryRow[]> {
  const supabase = await createClient();
  const q = supabase
    .from("feedback_categories")
    .select("id, name, sort_order, stage, subject, active")
    .eq("active", true);

  const { data, error } = await q
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });

  if (error) {
    console.error("[feedback] 读取分类失败:", error.code, error.message);
    // 兜底：数据库读不到时用静态定义，避免页面空白
    return CATEGORY_FALLBACK.map((c, i) => ({
      id: -(i + 1),
      name: c.name,
      sort_order: c.sort_order,
      stage: null,
      subject: null,
      active: true,
    }));
  }

  // 只保留「全学段通用」或「匹配当前学段」的分类
  return ((data ?? []) as CategoryRow[]).filter(
    (c) => c.stage === null || !stage || c.stage === stage,
  );
}

/** 读取教材（可按学段/科目过滤） */
export async function getTextbooks(
  opts: { stage?: string | null; subject?: string | null } = {},
): Promise<TextbookRow[]> {
  const supabase = await createClient();
  let q = supabase.from("feedback_textbooks").select("id, stage, subject, version, name, sort_order");
  if (opts.stage) q = q.eq("stage", opts.stage);
  if (opts.subject) q = q.eq("subject", opts.subject);

  const { data, error } = await q
    .order("version", { ascending: true })
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });
  if (error) {
    console.error("[feedback] 读取教材失败:", error.code, error.message);
    return [];
  }
  return (data ?? []) as TextbookRow[];
}

/** 读取某个教材下的章节 */
export async function getChapters(textbookId: number): Promise<ChapterRow[]> {
  if (!Number.isFinite(textbookId)) return [];
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("feedback_chapters")
    .select("id, textbook_id, name, sort_order")
    .eq("textbook_id", textbookId)
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });

  if (error) {
    console.error("[feedback] 读取章节失败:", error.code, error.message);
    return [];
  }
  return (data ?? []) as ChapterRow[];
}

/**
 * 一次读取多本教材的章节（用 in 过滤，**一条查询**）。
 *
 * 为什么需要它：从前接口对每本教材各查一次章节（N+1）——
 * senior+math 会发 29 次、senior 全科目会发 129 次，每次约 124ms。
 * 调用方拿回结果后按 textbook_id 自行分组即可。
 */
export async function getChaptersByTextbookIds(textbookIds: number[]): Promise<ChapterRow[]> {
  const ids = textbookIds.filter((n) => Number.isFinite(n));
  if (!ids.length) return [];
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("feedback_chapters")
    .select("id, textbook_id, name, sort_order")
    .in("textbook_id", ids)
    .order("textbook_id", { ascending: true })
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });

  if (error) {
    console.error("[feedback] 批量读取章节失败:", error.code, error.message);
    return [];
  }
  return (data ?? []) as ChapterRow[];
}

export async function getPhrases(): Promise<PhraseRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("feedback_phrases")
    .select("id, phrase, sort_order")
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });

  if (error) {
    console.error("[feedback] 读取短语失败:", error.code, error.message);
    return [];
  }
  return (data ?? []) as PhraseRow[];
}

/** 学生档案：结果受 RLS 限制，只会返回属于当前用户的行 */
export async function getStudents(): Promise<StudentRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("feedback_students")
    .select("id, name, subject, salutation, teacher, type, notes, updated_at")
    .order("name", { ascending: true });

  if (error) {
    console.error("[feedback] 读取学生档案失败:", error.code, error.message);
    return [];
  }
  return (data ?? []) as StudentRow[];
}

/** 反馈历史：同样受 RLS 限制 */
export async function getHistory(): Promise<HistoryRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("feedback_history")
    .select("id, student_name, text, date, type_name, subject, created_at")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[feedback] 读取历史失败:", error.code, error.message);
    return [];
  }
  return (data ?? []) as HistoryRow[];
}

/** 把扁平的关键词行装配成前端需要的嵌套结构（按科目） */
export function buildKeywordTree(rows: KeywordRow[]): KeywordTree {
  const tree: KeywordTree = {};
  for (const row of rows) {
    tree[row.subject] ??= { categories: [] };
    let cat = tree[row.subject].categories.find((c) => c.name === row.category);
    if (!cat) {
      cat = { name: row.category, keywords: [] };
      tree[row.subject].categories.push(cat);
    }
    cat.keywords.push(row.keyword);
  }
  return tree;
}

/**
 * 按分类分组：{ 分类名: [关键词...] }
 *
 * 这是工具页新的取数方式——按「学段 + 科目 + 教材/章节」维度只取所需的关键词，
 * 而不是一次拉全库（全库已 658 条且会继续增长）。
 */
export function groupByCategory(rows: KeywordRow[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const r of rows) {
    out[r.category] ??= [];
    out[r.category].push(r.keyword);
  }
  return out;
}

/**
 * 组装某个「学段 + 科目」下的分类关键词。
 *
 * 规则（对应数据模型）：
 *   - 「课堂内容 / 下节课内容」：只含**不分章节**的词（通用内容词）；
 *     某个具体章节的词由 chapterKeywords 单独给出。
 *   - 其余分类：该科目下的全部词（教材/章节均为空）。
 */
export function assembleCategoryKeywords(
  categoryNames: string[],
  genericRows: KeywordRow[],
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const grouped = groupByCategory(genericRows);
  for (const name of categoryNames) {
    out[name] = grouped[name] ?? [];
  }
  return out;
}

/** 学生档案数组 → 前端使用的 { 姓名: {...} } 结构 */
export function studentsByName(rows: StudentRow[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    out[r.name] = {
      subject: r.subject ?? "",
      salutation: r.salutation ?? "家长",
      teacher: r.teacher ?? "",
      type: r.type ?? "",
      notes: r.notes ?? "",
      updated: (r.updated_at ?? "").slice(0, 10),
      id: r.id,
    };
  }
  return out;
}

/**
 * 把数据库里的 ISO 日期转回前端显示格式（10月3日），
 * 与原有 localStorage 数据格式保持一致，避免改动渲染代码。
 */
export function formatDisplayDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(iso);
  return `${Number(m[2])}月${Number(m[3])}日`;
}

/** 历史数组 → 前端使用的 { 姓名: [{...}] } 结构 */
export function historyByStudent(rows: HistoryRow[]): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const r of rows) {
    out[r.student_name] ??= [];
    out[r.student_name].push({
      text: r.text,
      date: formatDisplayDate(r.date),
      typeName: r.type_name ?? "",
      subject: r.subject ?? "",
      saved: r.created_at,
      id: r.id,
    });
  }
  return out;
}

export { isChapterCategory };
