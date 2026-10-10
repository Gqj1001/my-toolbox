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
  // ---- 0014 新增的**统一学生档案**列（全站三个工具共用那一份档案） ----
  // 全部可空：老行（0014 之前建的）这几列都是 null，读出来照样要能用。
  // ⚠️ 新增列**一律不改老列的名字与含义** —— feedback.html 读的就是上面那几个。
  grade: string | null;
  gender: string | null;
  campus: string | null;
  manager: string | null;
  class_name: string | null;
  attitude: string | null;
  /** 工具专属字段（jsonb）。约定见 0014 的列注释。0014 保证它 not null，这里仍按可空处理 */
  extra: Record<string, unknown> | null;
};

export type HistoryRow = {
  id: number;
  student_name: string;
  text: string;
  date: string | null;
  type_name: string | null;
  subject: string | null;
  created_at: string;
  // ---- 0014 新增（跨工具共用一份记录表）----
  /** 归属工具：feedback / paper。默认 feedback（老行自动归位） */
  tool: string | null;
  /** 考试名（paper-analysis 的 examName）；feedback 的 type_name 含义不同，两者并存 */
  title: string | null;
  /** 得分 / 满分：paper-analysis 才有，feedback 那边是 null */
  score: number | null;
  full_score: number | null;
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

// ============================================================
// 数据版本号：随响应下发给浏览器，供**客户端缓存**判断「该不该丢」
// ============================================================

/** 版本号的时间粒度：与服务端静态表 TTL（`STATIC_TTL_MS` = 10 分钟）对齐 */
const DATA_VERSION_BUCKET_MS = 600_000;

/**
 * 当前数据版本号。**种子按 10 分钟分桶**，每次主动失效再 +1。
 *
 * 为什么不用「查一次 `MAX(updated_at)` 拿真实版本」：
 *   那要给每个请求多付一次 Supabase 往返 —— 而这个项目所有性能工作的核心结论就是
 *   **要减的是调用次数**（香港→新加坡每次 400–500ms）。版本号只是**提示**，
 *   不值得为它买一次外网往返。
 *
 * 为什么种子是「时间桶」而不是固定 0：
 *   · 同一个 10 分钟桶内启动的多个实例，版本号**天然相同** ⇒ 客户端在实例间漂移时
 *     不会因为版本号不同而白白清缓存；
 *   · 重启/重新部署后种子稳定（桶内不变），不会像「从 1 开始」那样每次部署都让
 *     所有客户端清一遍缓存；
 *   · 10 分钟正好等于静态表 TTL —— 也就是说「版本号没变」蕴含
 *     「数据要么没变、要么和 TTL 兜底口径一致」。
 *
 * ⚠️ **已知局限（安全方向，不是坑）**：跨 10 分钟桶启动的两个实例版本号可能不同，
 *    客户端遇到不同的版本号会**清掉本地缓存重拉一次**（web 端每个维度一次，
 *    push 端每个维度一次）。宁可多拉，不可用旧。真要做到全局一致只能查库，
 *    代价见上 —— 不做。
 */
let dataVersion = Math.floor(Date.now() / DATA_VERSION_BUCKET_MS);

/** 当前数据版本号（route 把它放进响应；客户端拿它对比本地缓存） */
export function getDataVersion(): number {
  return dataVersion;
}

/** 数据一变就 +1，使浏览器端的缓存版本对不上（本进程立即生效） */
function bumpDataVersion() {
  dataVersion++;
}

/** 清掉关键词缓存（改过关键词表之后调用；本进程立即生效）
 *
 *  名字用 invalidate* 而不是 revalidate*，是为了跟 Next 的 revalidatePath /
 *  revalidateTag 区分开 —— 那两者都**清不掉**这个进程内缓存（实测过）。
 *  调用点：admin/feedback-keywords/actions.ts 与 admin/feedback-candidates/actions.ts
 *  各自的 revalidate()（所有写操作都会经过它）。 */
export function invalidateKeywords() {
  clearCache(keywordCache);
  bumpDataVersion();
}

/** 清掉「静态表」缓存：分类 / 教材 / 章节 / 短语（后台改了这些表之后调用） */
export function invalidateStaticTables() {
  clearCache(categoriesCache);
  clearCache(textbooksCache);
  clearCache(chaptersCache);
  clearCache(phrasesCache);
  bumpDataVersion();
}

/** 清掉「学生档案 + 历史」两个进程内缓存（**仅供 `/api/debug/clear-caches` 调用**）。
 *
 *  为什么需要它：缓存是**进程内**的，而测试 / 脚本有时会**绕过写接口**直接改库
 *  （例如「直连 PostgREST 造一份带新列的档案」）。那时没有任何代码路径去清缓存，
 *  于是会读到最长 25 秒的旧值 —— 症状非常像「功能坏了」，其实是缓存没清。
 *
 *  ⚠️ **这里刻意不做任何开关判断**：授权只认 `src/lib/debug-gate.ts` 那一处
 *     （`ALLOW_DEBUG_CACHE_CLEAR=1` + `DEBUG_CACHE_TOKEN` ≥24 位 + 请求头一致，
 *      缺一即 404）。两处各写一套开关迟早会漂移，而且审计时要看两个文件。
 *     所以：**这个函数本身是"能被调就清"**，安全性完全由那一个门决定。
 *
 *  ⚠️ 它只清进程内缓存，不碰数据库、不改任何行。 */
export function clearUserDataCachesForTest(): boolean {
  clearCache(studentsCache);
  clearCache(historyCache);
  return true;
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

/** 实际查库（不含缓存）
 *
 *  ⚠️ **只加列，不动老列**：`id, name, subject, salutation, teacher, type, notes, updated_at`
 *     这 8 个是老工具（feedback.html）依赖的，名字与含义都不能变。
 *     0014 之后追加的 7 列服务「统一学生档案」；老行里它们是 null，读出来照样能用。
 *     `studentsByName()` 是**白名单构造**，所以这里多选列**不会**自动改变接口返回 ——
 *     要暴露给前端必须在那个函数里显式加（见那里的注释）。
 *
 *  ⚠️ select 必须是**一个字面量字符串**：用 `"a" + "b"` 拼接会让 PostgREST 的类型推断
 *     退化成 `GenericStringError`，编译期就报 TS2352（本轮踩过）。
 *     要和 `StudentRow` 对齐就改这一处 + 上面的类型定义。 */
async function loadStudents(): Promise<StudentRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("feedback_students")
    .select("id, name, subject, salutation, teacher, type, notes, updated_at, grade, gender, campus, manager, class_name, attitude, extra")
    .order("name", { ascending: true });

  if (error) {
    console.error("[feedback] 读取学生档案失败:", error.code, error.message);
    throw new Error(`读取学生档案失败: ${error.code} ${error.message}`);
  }
  return data ?? [];
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

/**
 * **不缓存**的学生档案读取 —— 给「学员档案」页（`/dashboard`）用。
 *
 * ⚠️ 为什么档案页必须绕开缓存（2026-10 实测踩到）：
 *    `getStudents()` 有 25 秒**进程内**缓存，而写入发生在**另一个请求**里
 *    （Server Action / 另一个标签页 / 手机端）。`invalidateStudents()` 只清得掉
 *    **同一个进程实例**里的那份；实测出现「表单提交成功、详情页显示得好好的，
 *    但紧接着任何读接口都返回空」——最长 25 秒，症状就是**保存了却看不见**。
 *    档案页是「以看为主」的页面，**正确性优先于省一次往返**，所以直接查库。
 *
 * ⚠️ 工具页（feedback / paper / math-plan）**继续用缓存的 `getStudents()`**：
 *    它们的读写都在同一个页面会话里，写完会自己失效，缓存收益是实打实的。
 *    不要为了"统一"把工具那边也改成直查 —— 那是把性能优化白白丢掉。
 *
 * ⚠️ `softFail` 与缓存版保持一致：查失败时返回空（不 500），且失败不落缓存（本来就不缓存）。
 */
export async function getStudentsFresh(): Promise<StudentRow[]> {
  return softFail("学生档案（直读）", loadStudents);
}

/** 同上：**不缓存**的历史读取 */
export async function getHistoryFresh(): Promise<HistoryRow[]> {
  return softFail("反馈历史（直读）", loadHistory);
}

/** 实际查库（不含缓存）
 *
 *  ⚠️ 同 `loadStudents()`：**只加列，不动老列**，select 必须是单字面量字符串。
 *     `historyByStudent()` 是白名单构造，所以多选列不会自动改变接口返回。 */
async function loadHistory(): Promise<HistoryRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("feedback_history")
    .select("id, student_name, text, date, type_name, subject, created_at, tool, title, score, full_score")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[feedback] 读取历史失败:", error.code, error.message);
    throw new Error(`读取历史失败: ${error.code} ${error.message}`);
  }
  return data ?? [];
}

// ============================================================
// 统一学生档案：**写**路径（阶段2 第3步 /api/students 用）
// ============================================================
//
// ⚠️ 与 feedback 现有写路径（`/api/feedback/data` 的 upsert）的区别，是本节的**设计核心**：
//
//   feedback 的写法是 `upsert(payload, {onConflict:"user_id,name"})` —— PostgREST 的 upsert
//   是**整行覆盖**：payload 里没带的列会被写成 NULL。
//   这在单一工具时代没问题；但 0014 之后同一行要装三个工具的字段，于是会出这种事：
//
//     math-plan 存了 {grade:"高三", campus:"燕郊", extra:{phase:"秋"}}
//     → 老师在 feedback 里点一次「保存档案」（只发 subject/salutation/teacher/type/notes）
//     → grade / campus / extra **被静默清空**
//
//   所以这里改成**合并语义**：先读旧行，只覆盖「本次真正传了的字段」，其余原样保留。
//   `undefined` = 没传 = 保留；`null` = 明确要清空。
//   注意「空串」**不等于**「要清空」——空串按原值写入。
//
// ⚠️ 本轮**不改** feedback 的写路径（它是正常工作的老代码，动它有回归风险）。
//    将来若也要合并语义，应当让 `/api/feedback/data` 也走这两个函数，而不是各写一套。
//
// ★ **2026-10 第二批（技术债收口）：`extra` 也改成服务端按键合并。**
//   在此之前，合并语义只保护**顶层列**，`extra` 是一整个 jsonb、**传了就是整块替换** ——
//   于是每个工具都必须**自己**先把旧 `extra` 读回来展开、再盖上自己那几个键；
//   少写一句就会抹掉别家工具的数据。实测就是这样：paper-analysis 的
//   `CLOUD_STORE.saveStudent()` 只发 `{cls}`（它**没有**先读旧值），
//   所以「先在 math-plan 存了 phase/book/exam，再到 paper 点一次保存」
//   → 那三个键当场消失（`tests/math-plan-students.test.mjs` 的「extra 互不踩③」
//   以前如实记录着这个现象，现在那条断言已经**翻转**成"不再被盖掉"）。
//
//   现在合并放进 `buildStudentRow()`：即使某个工具（或将来新接的工具）**一句都不写**，
//   也不会踩到别人。工具页那句「先读旧值」**仍然保留** ——
//   服务端合并是**兜底**，不是替代（两边都做，结果一致、幂等）。

/** 可合并的列（= `loadStudents()` 选的列，去掉 id/updated_at）。
 *  ⚠️ 加了新列必须同步这里，否则新列永远写不进去（且不会报错）。 */
const STUDENT_MERGE_COLUMNS = [
  "subject", "salutation", "teacher", "type", "notes",
  "grade", "gender", "campus", "manager", "class_name", "attitude", "extra",
] as const;

export type StudentPatch = Partial<Record<(typeof STUDENT_MERGE_COLUMNS)[number], unknown>>;

/** 从「用户传来的对象」里挑出合法列；没传的键**不进结果**（= 保留原值）。
 *
 *  ⚠️ 这是合并语义的关键：**只有出现过的键**才会进 patch。
 *     值一律**原样**写入（含空串）—— 不做「空串转 null」，
 *     免得把用户明确清空的意图与「没传」混为一谈。 */
export function pickStudentPatch(input: Record<string, unknown>): StudentPatch {
  const patch: StudentPatch = {};
  for (const col of STUDENT_MERGE_COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(input, col)) {
      patch[col] = input[col] === undefined ? null : input[col];
    }
  }
  return patch;
}

/** 当前用户已有的档案（按姓名）——供合并写入前读取。
 *
 *  ★ **2026-10 第二批：改成直读最新行**（`getStudentsFresh()`，不走 25 秒缓存）。
 *     理由：`extra` 现在是**按键合并**，正确性完全依赖「旧 `extra` 是最新的」；
 *     用缓存版的话，多实例部署时可能把别家工具刚改过的键**写回旧值**（最长 25 秒窗口）。
 *  ⚠️ 直读靠 **RLS** 隔离用户，所以调用方必须是**带会话**的上下文
 *     （Route Handler / Server Action）。**绝不能**从 service_role 的上下文调用 ——
 *     那会读到所有用户的档案，同名学生会串号。
 *
 *  ⚠️ 另记一个**既有**隐患（本轮不动）：`getStudentsFresh()` 查失败时走 `softFail()` →
 *     返回空数组 → 这里就当成"没有旧行"，于是「没传的列」会被写成 NULL（= 回到整行覆盖）。
 *     也就是说**数据库抖一下可能静默抹掉别家工具的数据**。要根治得让写路径的读失败**明确抛错**，
 *     那是另一个取舍（读接口不能因此 500，但**写**路径失败也许应该）。留待用户决定。 */
async function loadStudentsByNameFresh(): Promise<Map<string, StudentRow>> {
  const rows = await getStudentsFresh();
  return new Map(rows.map((r) => [r.name, r]));
}

/** `extra` 是不是一个**普通对象**（jsonb 的合法形状）。
 *  ⚠️ 数组与标量都不是合法形状：0014 有 `check (jsonb_typeof(extra) = 'object')`，
 *     写进去会被数据库明确拒绝（23514）。我们**不**在这里"顺手修好"它 —— 见 `mergeExtra`。 */
function isExtraObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * `extra` 的**服务端按键合并**（★ 2026-10 第二批的收口点）
 *
 * 规则（四条都要记住，写错任何一条都会**静默**出问题）：
 *   1. 旧键先展开，**新键覆盖同名旧键**（本次写的一定赢）；
 *   2. **别的工具的键原样保留** —— 这正是本函数存在的理由；
 *   3. 新值里 **`null` 表示「把这个键删掉」**（不是"写成 null"）——
 *      这是唯一能删掉自己那个键的口子（用户 2026-10 选的口径）；
 *   4. 传进来的**不是对象**（数组 / 字符串 / 数字）→ **原样透传**，
 *      让数据库像以前一样**明确报错**，而不是被这里悄悄改成合法对象
 *      （"静默修好非法输入"是更难查的一类 bug）。
 */
function mergeExtra(oldValue: unknown, incoming: unknown): unknown {
  if (!isExtraObject(incoming)) return incoming;   // 规则 4：非法形状原样透传
  const merged: Record<string, unknown> = isExtraObject(oldValue) ? { ...oldValue } : {};
  for (const [k, v] of Object.entries(incoming)) {
    if (v === null) delete merged[k];              // 规则 3：null = 删掉这个键
    else merged[k] = v;                            // 规则 1、2：新键覆盖，别家键留着
  }
  return merged;
}

/** 只有出现过的键才覆盖；没出现过的一律沿用旧值（旧值没有就是 null）
 *
 *  ⚠️ `extra` 是 `not null default '{}'`（0014 的约束），**永远不能写 null** ——
 *     显式传 null 会撞 23502「null value in column "extra" violates not-null constraint」。
 *     本轮踩过：合并时「没有旧行 → 写 null」，于是**新建**档案一律 500，
 *     而**更新**已有档案却正常（因为有旧值）——症状很像"随机失败"。
 *     所以：没有值时**省略这个键**，让数据库默认值生效。
 *
 *  ⚠️ 反过来，其它列省略与写 null 等价（都可空），所以统一用 null 没问题。 */
function buildStudentRow(name: string, existing: StudentRow | undefined, patch: StudentPatch): Record<string, unknown> {
  const row: Record<string, unknown> = { name };
  for (const col of STUDENT_MERGE_COLUMNS) {
    if (col === "extra") {
      // ★ 第二批：extra 单独走**按键合并**（不是整块替换）。
      //   注意区分两件事：「整个 extra 传 null / 没传」= 沿用旧值；
      //   「extra 对象里的某个键值是 null」= 删掉那个键（在 mergeExtra 里处理）。
      if (Object.prototype.hasOwnProperty.call(patch, col) && patch.extra != null) {
        row[col] = mergeExtra(existing?.extra, patch.extra);
      } else {
        const old = existing?.extra;
        if (old == null) continue;   // 省略 → 用数据库默认 '{}'
        row[col] = old;
      }
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(patch, col)) {
      row[col] = patch[col];
    } else {
      const old = existing ? existing[col] : undefined;
      row[col] = old ?? null;
    }
  }
  return row;
}

/** upsert 一份档案（**合并语义**）。返回写后的行。
 *
 *  ⚠️ 顺序：**先读旧行 → 合并 → 再写**。不先读就无法区分「没传」与「传了空」。
 *  ★ 2026-10 第二批：这里的读改成**直读最新行**（见 `loadStudentsByNameFresh()`），
 *     不再走 25 秒缓存 —— 合并的正确性依赖旧值是最新的。
 *     代价：每次保存档案多一次 Supabase 往返（保存是低频动作，换来的是不丢数据）。
 *  ⚠️ 写完必须 `invalidateStudents()`，否则最长 25 秒读到的还是旧值。
 *
 *  ⚠️ 签名 2026-10 第二批去掉了 `uid`：它以前只用来拼**缓存 key**，
 *     现在合并走直读（由 RLS 隔离用户），这个参数已经没有用处，留着会误导人。
 *     调用方必须处于**带会话**的上下文（Route Handler / Server Action），见上面的警告。 */
export async function upsertStudent(
  name: string,
  patch: StudentPatch,
): Promise<StudentRow> {
  const supabase = await createClient();
  const existing = (await loadStudentsByNameFresh()).get(name);

  const row = buildStudentRow(name, existing, patch);

  const { data, error } = await supabase
    .from("feedback_students")
    .upsert(row, { onConflict: "user_id,name" })
    .select("id, name, subject, salutation, teacher, type, notes, updated_at, grade, gender, campus, manager, class_name, attitude, extra")
    .single();

  if (error) {
    console.error("[students] 保存档案失败:", error.code, error.message);
    throw new Error(`保存档案失败: ${error.code} ${error.message}`);
  }
  invalidateStudents();
  return data as StudentRow;
}

/** 按姓名删除档案（连同其历史）。返回是否成功。
 *
 *  ⚠️ 与 feedback 的 DELETE 分支行为一致（历史是按 `student_name` 删的，
 *     历史表没有外键指向档案，所以要显式删两次）。 */
export async function deleteStudentByName(name: string): Promise<void> {
  const supabase = await createClient();
  const { error: histError } = await supabase
    .from("feedback_history")
    .delete()
    .eq("student_name", name);
  const { error } = await supabase.from("feedback_students").delete().eq("name", name);

  if (histError || error) {
    console.error("[students] 删除档案失败:", histError?.code, error?.code);
    throw new Error(`删除档案失败: ${histError?.code ?? error?.code}`);
  }
  // 两份缓存都动了
  invalidateStudents();
  invalidateHistory();
}

/** 一条历史记录的合并列（= `loadHistory()` 选的列，去掉 id/created_at） */
const HISTORY_MERGE_COLUMNS = [
  "student_name", "text", "date", "type_name", "subject", "tool", "title", "score", "full_score",
] as const;

export type HistoryPatch = Partial<Record<(typeof HISTORY_MERGE_COLUMNS)[number], unknown>>;

/** 同上：只挑出现过的键 */
export function pickHistoryPatch(input: Record<string, unknown>): HistoryPatch {
  const patch: HistoryPatch = {};
  for (const col of HISTORY_MERGE_COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(input, col)) {
      patch[col] = input[col] === undefined ? null : input[col];
    }
  }
  return patch;
}

/**
 * 「考试记录」的导入（paper-analysis 迁移用）。
 *
 * 幂等设计（用户明确要求「多次调用结果一致」）：
 *   1. 先按 `(user_id, student_name, tool, title, date)` 查已存在的记录；
 *   2. 已存在 → **跳过**（不重复插入、不覆盖已有正文）；
 *   3. 不存在 → 插入。
 *   所以重复跑同一批数据，第二次会是 `inserted:0, skipped:N`，库里行数不变。
 *
 * ⚠️ 为什么用「业务键」判重而不是加唯一索引：
 *    `feedback_history` 上**没有** (user_id,student_name,tool,title,date) 唯一约束，
 *    而且历史里确实可能出现「同一天同一场考试存了两份不同正文」的合法情况
 *    （老师存了两次、改了内容）。加唯一约束会**拒绝**这种数据。
 *    所以判重放在应用层，作为**导入**这个动作的语义，而不是表的约束。
 *
 * ⚠️ 逐条插入（不是一次 bulk insert）：单次导入量是「几十条 × 一个老师」，
 *    而且需要逐条判重。真到了几千条再考虑批量。
 */
export async function importHistory(
  items: HistoryPatch[],
): Promise<{ inserted: number; skipped: number }> {
  const supabase = await createClient();
  // 一次性把该用户已有的记录全取回来做判重（比逐条查库省很多往返）。
  // ⚠️ **不要**在这里加 `.eq("tool", …)` 之类的过滤：判重键里已经含 tool，
  //    过滤掉一部分反而会让「不同 tool 但同名同日期」的判断出错。
  //    返回量 = 该用户自己的历史（几十~几百行），可接受。
  const { data: existing, error: readError } = await supabase
    .from("feedback_history")
    .select("student_name, tool, title, date");
  if (readError) {
    console.error("[students] 导入前读取失败:", readError.code, readError.message);
    throw new Error(`导入前读取失败: ${readError.code} ${readError.message}`);
  }
  const key = (i: { student_name?: unknown; tool?: unknown; title?: unknown; date?: unknown }) =>
    [String(i.student_name ?? ""), String(i.tool ?? ""), String(i.title ?? ""), String(i.date ?? "")].join("\u0000");
  const seen = new Set((existing ?? []).map(key));
  // 同一批内部也要判重，否则「本批次里有两份一样的数据」会插两次
  const batchSeen = new Set<string>();

  let inserted = 0, skipped = 0;
  for (const item of items) {
    const k = key(item as Record<string, unknown>);
    if (seen.has(k) || batchSeen.has(k)) { skipped++; continue; }
    batchSeen.add(k);
    const { error } = await supabase.from("feedback_history").insert(item);
    if (error) {
      console.error("[students] 导入插入失败:", error.code, error.message);
      throw new Error(`导入插入失败: ${error.code} ${error.message}`);
    }
    inserted++;
  }

  if (inserted > 0) invalidateHistory();
  return { inserted, skipped };
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

/** 学生档案数组 → 前端使用的 { 姓名: {...} } 结构
 *
 *  ⚠️ **这里是接口返回结构的唯一出口**（`loadStudents` 多选的列不会自动出现在响应里）。
 *     规则（阶段2 红线1「逐字节兼容」）：
 *       · 老字段**一个都不能少、名字与默认值都不能改** —— feedback.html 直接读它们：
 *         `subject / salutation / teacher / type / notes / updated / id`；
 *       · 新字段**只能追加**，而且必须给「老行（null）」一个安全默认值 ——
 *         否则界面会显示 undefined。
 *     对照组测试：`tests/students-unified.test.mjs`（老字段少一个就红）。 */
export function studentsByName(rows: StudentRow[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    out[r.name] = {
      // ---------- 老字段（0014 之前就有，禁止改动） ----------
      subject: r.subject ?? "",
      salutation: r.salutation ?? "家长",
      teacher: r.teacher ?? "",
      type: r.type ?? "",
      notes: r.notes ?? "",
      updated: (r.updated_at ?? "").slice(0, 10),
      id: r.id,
      // ---------- 0014 追加：统一学生档案（老行是 null → 空串 / {}） ----------
      grade: r.grade ?? "",
      gender: r.gender ?? "",
      campus: r.campus ?? "",
      manager: r.manager ?? "",
      class_name: r.class_name ?? "",
      attitude: r.attitude ?? "",
      extra: r.extra ?? {},
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

/** 历史数组 → 前端使用的 { 姓名: [{...}] } 结构
 *
 *  ⚠️ 同 `studentsByName()`：老字段 `text / date / typeName / subject / saved / id`
 *     名字与含义都不能动（feedback.html 读它们）；新字段只追加。
 *     `date` 仍然是**显示用格式**（`formatDisplayDate` → 「10月7日」），
 *     不要因为新增了 `tool/score` 就顺手把 date 换成 ISO —— 那会让老界面显示成原始串。 */
export function historyByStudent(rows: HistoryRow[]): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const r of rows) {
    out[r.student_name] ??= [];
    out[r.student_name].push({
      // ---------- 老字段（禁止改动） ----------
      text: r.text,
      date: formatDisplayDate(r.date),
      typeName: r.type_name ?? "",
      subject: r.subject ?? "",
      saved: r.created_at,
      id: r.id,
      // ---------- 0014 追加：跨工具记录（老行 tool='feedback'，其余为 null） ----------
      tool: r.tool ?? "feedback",
      title: r.title ?? "",
      score: r.score ?? null,
      fullScore: r.full_score ?? null,
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
