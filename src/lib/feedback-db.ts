import "server-only";

import { createClient } from "@/lib/supabase/server";
import { cached, clearCache, createTtlCache, warmInBackground } from "@/lib/ttl-cache";
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
 * 缓存有效期（毫秒）。
 *
 * 静态表一律 **10 分钟**：它们**只有后台会改**，而两个 admin actions 的 `revalidate()`
 * 里都会调 `invalidateStaticTables()` / `invalidateKeywords()`，所以「改完即生效」
 * 不靠 TTL —— TTL 只是**兜底**（防止有人绕过代码路径，比如在 Supabase SQL Editor 里直接改）。
 * 既然只是兜底，就给长一点：短 TTL 会让「用户隔一会儿再用」白白冷一次。
 *
 * 按用户表保持 **25 秒**：用户自己的数据，他改完必须立刻看到（代码里已经主动失效），
 * TTL 只用来兜「另一个标签页/另一台设备改的」，短一点更稳。
 */
const STATIC_TTL_MS = 600_000;
const USER_TTL_MS = 25_000;

/** 按用户缓存最多留几个用户，防止长期运行内存无限涨 */
const USER_CACHE_MAX_USERS = 200;

/** 静态表缓存：categories（分类）/ phrases（短语）各一份（结果与维度无关） */
const categoriesCache = createTtlCache(STATIC_TTL_MS);
const phrasesCache = createTtlCache(STATIC_TTL_MS);
/** 静态表缓存：textbooks —— **只有一条 key**（见下面 getTextbooks 的注释） */
const textbooksCache = createTtlCache(STATIC_TTL_MS);
/** 静态表缓存：chapters —— key 是「学段|科目」（见下面 getChapters* 的注释） */
const chaptersCache = createTtlCache(STATIC_TTL_MS);
/** 按用户缓存：students / history（key 里带 user_id，限量） */
const studentsCache = createTtlCache(USER_TTL_MS, USER_CACHE_MAX_USERS);
const historyCache = createTtlCache(USER_TTL_MS, USER_CACHE_MAX_USERS);
/** 关键词缓存 —— 沿用最早那套（只缓存「不带 category 的按维度查询」，后台查的那类不缓存） */
const keywordCache = createTtlCache(STATIC_TTL_MS);

/** 清掉关键词缓存（改过关键词表之后调用；本进程立即生效）
 *
 *  名字用 invalidate* 而不是 revalidate*，是为了跟 Next 的 revalidatePath /
 *  revalidateTag 区分开 —— 那两者都**清不掉**这个进程内缓存（实测过）。
 *  调用点：admin/feedback-keywords/actions.ts 与 admin/feedback-candidates/actions.ts
 *  各自的 revalidate()（所有写操作都会经过它）。 */
export function invalidateKeywords() {
  clearCache(keywordCache);
}

/** 清掉「静态表」缓存：分类 / 教材 / 章节 / 短语（后台改了这些表之后调用） */
export function invalidateStaticTables() {
  clearCache(categoriesCache);
  clearCache(textbooksCache);
  clearCache(chaptersCache);
  clearCache(phrasesCache);
}

/** 清掉**整个**「学生档案」缓存（写完/删完档案后调用；本进程立即生效）
 *
 *  ⚠️ 粒度是整个 Map，不是「只清某个用户」：进程级缓存分不清是谁写的，
 *     所以别人会跟着多查一次库。方向是安全的（宁可多查、不会变旧），只是略有浪费。
 *     按用户的数据量很小（每人几十行），不值得为此引入 per-request 上下文。 */
export function invalidateStudents() {
  clearCache(studentsCache);
}

/** 清掉**整个**「反馈历史」缓存（写完/删完历史后调用；本进程立即生效）；粒度说明同上 */
export function invalidateHistory() {
  clearCache(historyCache);
}

// ============================================================
// 失败兜底：缓存层「不缓存失败」，接口层「不因失败而 500」
// ============================================================

/**
 * 把「查失败」翻译成「空结果」，让调用方优雅降级 —— 但**不会**把它写进缓存。
 *
 * 为什么两个都要（这是本文件最容易搞混的地方）：
 *   · `cached()` 要求 `load` 失败时**抛异常**，这样失败不会进缓存 —— 避免
 *     「一次瞬时故障」被放大成「TTL 时间内这页什么都没有」（`unstable_cache` 那个坑的形态）。
 *   · 但抛出去会让 `/api/feedback/data` 直接 500、整页空白，比改动前更差
 *     （改动前是「静默返回空」）。
 *   所以：**缓存层保持干净（失败不落盘），接口层优雅降级（返回空）**。
 *
 * 实际效果：查失败时这一次请求拿到空（与改动前一致），**但下一次请求会重新查库**，
 * 一旦数据库恢复立刻正常 —— 不会像缓存失败那样一直空到 TTL 过期。
 */
async function softFail<T>(label: string, run: () => Promise<T[]>): Promise<T[]> {
  try {
    return await run();
  } catch (e) {
    console.error(`[feedback] ${label} 查询失败，本次按空结果降级（未写入缓存）:`,
      e instanceof Error ? e.message : e);
    return [];
  }
}

/**
 * 取缓存用的用户标识。route 里已经有 guard.user.id，优先用调用方传进来的，
 * 免得为了拼一个缓存 key 再白付一次 `auth/v1/user` 往返（用户环境约 500ms）。
 * 没传时退回查一次会话（保持这个函数能被单独调用而不出错）。
 */
async function cacheUserId(explicit?: string): Promise<string | null> {
  if (explicit) return explicit;
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error) {
    console.error("[feedback] 读取会话失败:", error.message);
    return null;
  }
  return data.user?.id ?? null;
}

/** 把 scope 规范化成缓存键（只含真正参与过滤的维度）
 *
 *  ⚠️ `"any"` 与 `"null"` 必须区分开：`has()` 为假 = 该维度**不参与过滤**（不过滤），
 *     为真且值为 null = 明确「只要无归属的」。两者结果不同，键不能混。
 */
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
  // 只有「工具页会用到、且结果与用户无关」的那类查询才走缓存（见上面 STATIC_TTL_MS 注释）。
  // 带 category 的查询是管理后台用的，不缓存 —— 否则后台改完关键词看不到效果。
  if (scope.category) return softFail("关键词", () => loadKeywords(scope));
  return softFail("关键词", () => cached(keywordCache, keywordCacheKey(scope), () => loadKeywords(scope)));
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
    throw new Error(`读取关键词失败: ${error.code} ${error.message}`);
  }
  return (data ?? []) as KeywordRow[];
}

/**
 * 读取通用分类（数据库为权威来源，含 stage/subject 为空的全局分类）。
 *
 * ⚠️ 缓存口径：**缓存的是查库结果，不是按 stage 过滤后的结果**。
 *    从前的查询本身**并没有按 stage/subject 过滤**（`q` 上只加了 `.eq("active", true)`），
 *    只是把全部行取回来、再在内存里按 stage 过滤。所以这里缓存「全部行」是等价的，
 *    而且所有学段共用一份，比按 stage 分开存更省。
 */
export async function getCategories(stage?: string | null): Promise<CategoryRow[]> {
  // 读库失败时 loadCategories 自己会用 CATEGORY_FALLBACK 兜底（页面不空白），
  // 所以这里不需要 softFail —— 它永远不会抛。
  const all = await cached(categoriesCache, "all", loadCategories);

  // 只保留「全学段通用」或「匹配当前学段」的分类
  return all.filter((c) => c.stage === null || !stage || c.stage === stage);
}

/** 实际查库（不含缓存，也不含 stage 过滤）；读不到时用静态定义兜底，避免页面空白 */
async function loadCategories(): Promise<CategoryRow[]> {
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

  return (data ?? []) as CategoryRow[];
}

/**
 * 读取教材（可按学段/科目过滤）。静态表，**整个表只有一条缓存 key**。
 *
 * ⚠️ 为什么是「一张表一条 key」，而不是「按学段|科目各一条」：
 *    `feedback_textbooks` 只有 **219 行 / 24 KB**，而且下面这条查询**本来就没有
 *    按 stage/subject 过滤**（把全表取回来再在内存里筛，这是原来就有的行为）。
 *    按维度分 key 的话会有 **17 条**（线上实测 17 个「学段|科目」组合），
 *    用户每换一个科目就是一次**全新 miss** —— 白付一次外网往返，而省下的那点内存
 *    毫无意义。收敛成一条 key 之后，**换任何科目/学段都直接命中**（零代价）。
 *
 *    实测（2026-10）：换科目从 7 次出网降到 4 次出网。
 */
export async function getTextbooks(
  opts: { stage?: string | null; subject?: string | null } = {},
): Promise<TextbookRow[]> {
  const all = await softFail("教材", () => cached(textbooksCache, "all", loadTextbooks));
  return all.filter(
    (t) => (!opts.stage || t.stage === opts.stage) && (!opts.subject || t.subject === opts.subject),
  );
}

/** 实际查库（不含缓存，也不含 stage/subject 过滤） */
async function loadTextbooks(): Promise<TextbookRow[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("feedback_textbooks")
    .select("id, stage, subject, version, name, sort_order")
    .order("version", { ascending: true })
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });
  if (error) {
    console.error("[feedback] 读取教材失败:", error.code, error.message);
    throw new Error(`读取教材失败: ${error.code} ${error.message}`);
  }
  return (data ?? []) as TextbookRow[];
}

/**
 * 读取某个教材下的章节。
 *
 * 数据源与 `getChaptersByTextbookIds` **是同一份缓存**（按「学段|科目」），
 * 这样「同一科目内换教材」不会各自 miss 一次。
 * 但要先知道这本教材属于哪个「学段|科目」—— 从教材表（已缓存）里查，不额外查库。
 */
export async function getChapters(textbookId: number): Promise<ChapterRow[]> {
  if (!Number.isFinite(textbookId)) return [];
  return softFail("章节（单本）", async () => {
    const all = await loadAllTextbooks();
    const book = all.find((t) => t.id === textbookId);
    // 教材已被删除/查不到时，退回只查这一本（保证后台页面不出错）
    if (!book) return loadChaptersByTextbookId(textbookId);
    const rows = await getChaptersByScope(book.stage, book.subject);
    return rows.filter((c) => c.textbook_id === textbookId);
  });
}

/** 缓存里那份全量教材（给 `getChapters` 定位「学段|科目」用） */
async function loadAllTextbooks(): Promise<TextbookRow[]> {
  return cached(textbooksCache, "all", loadTextbooks);
}

/**
 * 一次读取**某个「学段+科目」下全部教材**的章节（一条查询，内存里按教材分组）。
 *
 * ⚠️ 为什么按「学段|科目」而不是按「教材」分缓存：
 *    按教材分会有 **64 条** key（线上 64 本教材有章节），用户在**同一科目内换教材**
 *    （比如人教A版 必修一 → 必修二）就是一次全新 miss。按「学段|科目」只有 **17 条**，
 *    而且这 17 条正好就是老师实际会来回切的粒度。
 *
 *    容量实测（2026-10）：最大的组合 senior|math 一次只有 **417 行 / 约 80 KB**，
 *    远低于 PostgREST 的 1000 行上限 —— 不会截断。但为防以后数据涨上去静默丢数据，
 *    仍带分页兜底（见下面 loadChaptersByScope）。
 */
export async function getChaptersByScope(
  stage: string | null | undefined,
  subject: string | null | undefined,
): Promise<ChapterRow[]> {
  if (!stage || !subject) return [];
  return softFail("章节（按科目）", () =>
    cached(chaptersCache, `${stage}|${subject}`, () => loadChaptersByScope(stage, subject)),
  );
}

const CHAPTER_PAGE = 1000;
/** 分页上限：正常一次就够（最大组合 417 行），只是防止异常数据把请求拖死 */
const CHAPTER_MAX_PAGES = 5;

/** 实际查库（按「学段|科目」；含分页兜底） */
async function loadChaptersByScope(stage: string, subject: string): Promise<ChapterRow[]> {
  const supabase = await createClient();

  // 该科目下全部教材 id（教材表已缓存，这里不产生额外出网）
  const books = await loadAllTextbooks();
  const ids = books.filter((t) => t.stage === stage && t.subject === subject).map((t) => t.id);
  if (!ids.length) return [];

  const all: ChapterRow[] = [];
  for (let page = 0; page < CHAPTER_MAX_PAGES; page++) {
    const from = page * CHAPTER_PAGE;
    const { data, error } = await supabase
      .from("feedback_chapters")
      .select("id, textbook_id, name, sort_order")
      .in("textbook_id", ids)
      .order("textbook_id", { ascending: true })
      .order("sort_order", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + CHAPTER_PAGE - 1);

    if (error) {
      console.error("[feedback] 读取章节失败:", error.code, error.message);
      // 已经拿到部分页时不要丢掉它们（下拉里少几本，好过整片空白）；
      // 但**一页都没拿到**必须抛，否则「查失败」会被缓存成「这个科目没有章节」。
      if (!all.length) throw new Error(`读取章节失败: ${error.code} ${error.message}`);
      return all;
    }
    const rows = (data ?? []) as ChapterRow[];
    all.push(...rows);
    if (rows.length < CHAPTER_PAGE) break;
  }
  return all;
}

/** 兜底：只查某一本教材的章节（教材在缓存里查不到时用；不进缓存，避免污染按科目的 key） */
async function loadChaptersByTextbookId(textbookId: number): Promise<ChapterRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("feedback_chapters")
    .select("id, textbook_id, name, sort_order")
    .eq("textbook_id", textbookId)
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });

  if (error) {
    console.error("[feedback] 读取章节失败:", error.code, error.message);
    throw new Error(`读取章节失败: ${error.code} ${error.message}`);
  }
  return (data ?? []) as ChapterRow[];
}

/**
 * 兼容旧签名：一次读取多本教材的章节（用 in 过滤）。
 *
 * ⚠️ 现在只是**把按「学段|科目」取回的结果在内存里按 id 过滤**（可能就一次查询都不用发），
 *    所以「不指定册次」那条分支不会再各自 miss 一次。
 *    调用方拿回结果后按 textbook_id 自行分组即可。
 */
export async function getChaptersByTextbookIds(textbookIds: number[]): Promise<ChapterRow[]> {
  const ids = textbookIds.filter((n) => Number.isFinite(n));
  if (!ids.length) return [];
  return softFail("章节（批量）", () => loadChaptersByTextbookIds(ids));
}

/** 实际实现：先按「学段|科目」整片命中，异常 id 才退回单独查 */
async function loadChaptersByTextbookIds(ids: number[]): Promise<ChapterRow[]> {
  const books = await loadAllTextbooks();
  const wanted = new Set(ids);
  const scopes = new Set(
    books.filter((t) => wanted.has(t.id)).map((t) => `${t.stage}|${t.subject}`),
  );

  // 缓存里能找到「学段|科目」就整片命中；找不到的（异常 id）退回单独查
  if (scopes.size) {
    const out: ChapterRow[] = [];
    for (const key of scopes) {
      const [stage, subject] = key.split("|");
      const rows = await getChaptersByScope(stage, subject);
      out.push(...rows.filter((c) => wanted.has(c.textbook_id)));
    }
    return out;
  }

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
    throw new Error(`批量读取章节失败: ${error.code} ${error.message}`);
  }
  return (data ?? []) as ChapterRow[];
}

/** 读取短语。静态表（10 行），全站共享缓存 10 分钟。 */
export async function getPhrases(): Promise<PhraseRow[]> {
  return softFail("短语", () => cached(phrasesCache, "all", loadPhrases));
}

/** 实际查库（不含缓存） */
async function loadPhrases(): Promise<PhraseRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("feedback_phrases")
    .select("id, phrase, sort_order")
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });

  if (error) {
    console.error("[feedback] 读取短语失败:", error.code, error.message);
    throw new Error(`读取短语失败: ${error.code} ${error.message}`);
  }
  return (data ?? []) as PhraseRow[];
}

/**
 * 学生档案：结果受 RLS 限制，只会返回属于当前用户的行。
 *
 * ⚠️ 这是**按用户**的数据，所以缓存 key 必须带 user_id —— 用共享 key 会把甲的档案发给乙。
 *    TTL 25 秒；工具页写完档案会调 `invalidateStudents()`，所以「刚存的马上能看到」。
 *    查询本身**不额外加 user_id 过滤**（照旧由 RLS 隔离），user_id 只用来做缓存 key。
 */
export async function getStudents(userId?: string): Promise<StudentRow[]> {
  const uid = await cacheUserId(userId);
  // 拿不到 uid 时不缓存：宁可多查一次库，也不能让「不知道是谁」的数据落进共享桶里
  if (!uid) return softFail("学生档案", loadStudents);
  return softFail("学生档案", () => cached(studentsCache, uid, loadStudents));
}

/** 实际查库（不含缓存） */
async function loadStudents(): Promise<StudentRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("feedback_students")
    .select("id, name, subject, salutation, teacher, type, notes, updated_at")
    .order("name", { ascending: true });

  if (error) {
    console.error("[feedback] 读取学生档案失败:", error.code, error.message);
    throw new Error(`读取学生档案失败: ${error.code} ${error.message}`);
  }
  return (data ?? []) as StudentRow[];
}

/**
 * 反馈历史：同样受 RLS 限制。
 *
 * ⚠️ 同 `getStudents()`：按用户缓存（key 带 user_id，TTL 25 秒），
 *    工具页写完历史会调 `invalidateHistory()`。
 */
export async function getHistory(userId?: string): Promise<HistoryRow[]> {
  const uid = await cacheUserId(userId);
  if (!uid) return softFail("反馈历史", loadHistory);
  return softFail("反馈历史", () => cached(historyCache, uid, loadHistory));
}

/** 实际查库（不含缓存） */
async function loadHistory(): Promise<HistoryRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("feedback_history")
    .select("id, student_name, text, date, type_name, subject, created_at")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[feedback] 读取历史失败:", error.code, error.message);
    throw new Error(`读取历史失败: ${error.code} ${error.message}`);
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

// ============================================================
// 启动预热（只烤「又小又每次都要」的三张表）
// ============================================================

/**
 * 模块加载时**不阻塞**地把分类 / 短语 / 教材烤进缓存，让第一个真实请求到达时它们已经是热的。
 *
 * 为什么只烤这三张：
 *   · 分类 8 行、短语 10 行、教材 219 行（约 24 KB）—— 小，而且**每个请求都要**，稳赚；
 *   · **章节和关键词故意不烤**：章节全量约 340 KB、关键词更多，预热它们等于给每个新实例
 *     加一堆启动开销，还会跟第一个真实请求抢连接 —— 那是净亏（见 ttl-cache.ts 的说明）。
 *
 * ⚠️ 它**不是**「用户来的时候一定热」的保证：Vercel 实例按需起、闲置就回收，
 *    而预热正好跑在「有请求才让实例起来」的那一刻，所以常常是跟第一个请求**并发**跑的。
 *    真正的收益来自缓存 key 收敛（换科目不再 miss），不是这里。
 *
 * ⚠️ 必须跳过 `next build`：构建期会 import 这个模块（收集页面数据），
 *    那时候查库既没意义又会拖慢构建、还可能在缺环境变量的机器上失败。
 *    `NEXT_PHASE` 是 Next 构建期一定会设的变量。
 */
const IS_BUILD =
  process.env.NEXT_PHASE === "phase-production-build" || !process.env.NEXT_PUBLIC_SUPABASE_URL;

if (!IS_BUILD) {
  warmInBackground("feedback 静态表", [getCategories, getPhrases, getTextbooks]);
}
