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

// ============================================================
// 通用进程内 TTL 缓存（静态表 + 按用户表共用同一套写法）
// ============================================================

/**
 * 缓存有效期（毫秒）。
 *   · 静态表：全用户共享、极少变（分类 8 行 / 短语 10 行 / 教材 219 行 / 章节按需），30 秒足够；
 *   · 按用户表：用户自己刚存完就调 invalidate*，所以 TTL 只兜「别的标签页/别的设备改的」，
 *     取 25 秒（perf-notes.md 的口径是 20–30 秒）。
 */
const STATIC_TTL_MS = 30_000;
const USER_TTL_MS = 25_000;

/** 按用户缓存最多留几个用户，防止长期运行内存无限涨 */
const USER_CACHE_MAX_USERS = 200;

/**
 * ⚠️ 不要用 `unstable_cache`（2026-10 实测踩过，tools 表那次）：
 *    在 Next 16.3.8 下它会**每次都返回空数组、也从不查库**，
 *    页面不报错、只是**静默地什么都没有**，肉眼根本看不出来。
 *    所以这里一律用显式的进程内 Map 缓存 —— 写法与上面的 keywordCache 一致。
 *
 * 语义：命中且未过期 → 直接返回不查库；过期 → 重查并刷新；
 *      invalidate* → 立即清掉（本实例立即生效）。
 *
 * 局限：每个服务端实例各一份；生产是多实例时，其它实例最多滞后一个 TTL。
 *      对本项目（共享静态表 + 用户自己的几十行数据）可接受。
 */
type TtlCache = {
  /** 已缓存的行 */
  entries: Map<string, { rows: unknown; at: number }>;
  /** 并发去重：同一瞬间多个请求共用同一个 in-flight promise，只查一次库 */
  inflight: Map<string, Promise<unknown>>;
  ttlMs: number;
  /** 缓存 key 数量上限（0 = 不限）。只有按用户的缓存需要限量。 */
  maxKeys: number;
};

function makeCache(ttlMs: number, maxKeys = 0): TtlCache {
  return { entries: new Map(), inflight: new Map(), ttlMs, maxKeys };
}

/** 超出上限时按「最久没被写入」淘汰一条；在飞的条目不动，避免丢掉正在等的 promise */
function evictIfNeeded(cache: TtlCache) {
  if (!cache.maxKeys || cache.entries.size < cache.maxKeys) return;
  let oldestKey: string | null = null;
  let oldestAt = Infinity;
  for (const [key, entry] of cache.entries) {
    if (cache.inflight.has(key)) continue;
    if (entry.at < oldestAt) {
      oldestAt = entry.at;
      oldestKey = key;
    }
  }
  if (oldestKey !== null) cache.entries.delete(oldestKey);
}

/**
 * 带 TTL 与并发去重的读取。
 *
 * `key` 必须只包含**真正影响结果的过滤条件**（否则不同维度会互相污染）；
 * 按用户的表必须把 `user_id` 拼进 key（RLS 只返回本人的行，共用 key 会串号）。
 *
 * `load` 抛异常或失败时不会把结果写进缓存，并且会清掉自己设的那条 in-flight promise
 * （只清「还是自己这条」的，避免把别人新发起的加载顶掉）—— 否则这个 key 会永久卡在
 * 「每次请求都共用一条已经失败的 promise」的状态。
 */
async function cached<T>(cache: TtlCache, key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.entries.get(key);
  if (hit && Date.now() - hit.at < cache.ttlMs) return hit.rows as T;

  const flying = cache.inflight.get(key);
  if (flying) return flying as Promise<T>;

  evictIfNeeded(cache);
  const run: Promise<T> = load().then((rows) => {
    cache.entries.set(key, { rows, at: Date.now() });
    return rows;
  });
  cache.inflight.set(key, run as Promise<unknown>);
  const clearInflight = () => {
    if (cache.inflight.get(key) === (run as Promise<unknown>)) cache.inflight.delete(key);
  };
  void run.then(clearInflight, clearInflight);
  return run;
}

/** 静态表缓存：categories / phrases 各一份（结果与维度无关） */
const categoriesCache = makeCache(STATIC_TTL_MS);
const phrasesCache = makeCache(STATIC_TTL_MS);
/** 静态表缓存：textbooks 按「学段|科目」分开存 */
const textbooksCache = makeCache(STATIC_TTL_MS);
/** 静态表缓存：chapters 按「教材 id 列表」的 key 分开存 */
const chaptersCache = makeCache(STATIC_TTL_MS);
/** 按用户缓存：students / history（key 里带 user_id，限量） */
const studentsCache = makeCache(USER_TTL_MS, USER_CACHE_MAX_USERS);
const historyCache = makeCache(USER_TTL_MS, USER_CACHE_MAX_USERS);

/** 清掉「静态表」缓存：分类 / 教材 / 章节 / 短语（后台改了这些表之后调用） */
export function invalidateStaticTables() {
  categoriesCache.entries.clear();
  categoriesCache.inflight.clear();
  textbooksCache.entries.clear();
  textbooksCache.inflight.clear();
  chaptersCache.entries.clear();
  chaptersCache.inflight.clear();
  phrasesCache.entries.clear();
  phrasesCache.inflight.clear();
}

/** 清掉**整个**「学生档案」缓存（写完/删完档案后调用；本进程立即生效）
 *
 *  ⚠️ 粒度是整个 Map，不是「只清某个用户」：进程级缓存分不清是谁写的，
 *     所以别人会跟着多查一次库。方向是安全的（宁可多查、不会变旧），只是略有浪费。
 *     按用户的数据量很小（每人几十行），不值得为此引入 per-request 上下文。 */
export function invalidateStudents() {
  studentsCache.entries.clear();
  studentsCache.inflight.clear();
}

/** 清掉**整个**「反馈历史」缓存（写完/删完历史后调用；本进程立即生效）；粒度说明同上 */
export function invalidateHistory() {
  historyCache.entries.clear();
  historyCache.inflight.clear();
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

/**
 * 读取通用分类（数据库为权威来源，含 stage/subject 为空的全局分类）。
 *
 * ⚠️ 缓存口径：**缓存的是查库结果，不是按 stage 过滤后的结果**。
 *    从前的查询本身**并没有按 stage/subject 过滤**（`q` 上只加了 `.eq("active", true)`），
 *    只是把全部行取回来、再在内存里按 stage 过滤。所以这里缓存「全部行」是等价的，
 *    而且所有学段共用一份，比按 stage 分开存更省。
 */
export async function getCategories(stage?: string | null): Promise<CategoryRow[]> {
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

/** 读取教材（可按学段/科目过滤）。静态表，按「学段|科目」分开缓存 30 秒。 */
export async function getTextbooks(
  opts: { stage?: string | null; subject?: string | null } = {},
): Promise<TextbookRow[]> {
  const key = `${opts.stage ?? "*"}|${opts.subject ?? "*"}`;
  return cached(textbooksCache, key, () => loadTextbooks(opts));
}

/** 实际查库（不含缓存） */
async function loadTextbooks(opts: {
  stage?: string | null;
  subject?: string | null;
}): Promise<TextbookRow[]> {
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

/** 读取某个教材下的章节。静态表，按教材 id 缓存 30 秒。 */
export async function getChapters(textbookId: number): Promise<ChapterRow[]> {
  if (!Number.isFinite(textbookId)) return [];
  return cached(chaptersCache, `one:${textbookId}`, () => loadChapters(textbookId));
}

/** 实际查库（不含缓存） */
async function loadChapters(textbookId: number): Promise<ChapterRow[]> {
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
 *
 * 静态表：按「教材 id 列表」缓存 30 秒。不指定册次时这个列表就是该科目**全部**教材，
 * 所以「物理高一没选册次」和「化学高一没选册次」各占一条缓存，互不干扰。
 */
export async function getChaptersByTextbookIds(textbookIds: number[]): Promise<ChapterRow[]> {
  const ids = textbookIds.filter((n) => Number.isFinite(n));
  if (!ids.length) return [];
  const key = `many:${ids.join(",")}`;
  return cached(chaptersCache, key, () => loadChaptersByTextbookIds(ids));
}

/** 实际查库（不含缓存） */
async function loadChaptersByTextbookIds(ids: number[]): Promise<ChapterRow[]> {
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

/** 读取短语。静态表（10 行），全站共享缓存 30 秒。 */
export async function getPhrases(): Promise<PhraseRow[]> {
  return cached(phrasesCache, "all", loadPhrases);
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
    return [];
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
  if (!uid) return loadStudents();
  return cached(studentsCache, uid, loadStudents);
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
    return [];
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
  if (!uid) return loadHistory();
  return cached(historyCache, uid, loadHistory);
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
