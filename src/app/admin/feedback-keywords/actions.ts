"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-role";
import { invalidateKeywords, invalidateStaticTables } from "@/lib/feedback-db";
import { createClient } from "@/lib/supabase/server";

export type KeywordActionResult = {
  status: "idle" | "success" | "error";
  message?: string;
};

/** 关键词库与短语库的字段上限，避免异常超长内容 */
const MAX_KEYWORD = 200;
const MAX_PHRASE = 500;

function deny(reason: "unauthenticated" | "forbidden"): KeywordActionResult {
  return {
    status: "error",
    message: reason === "unauthenticated" ? "登录已过期，请重新登录。" : "没有权限执行该操作。",
  };
}

function describe(message: string, code?: string): string {
  if (code === "42501" || /row-level security|permission denied/i.test(message)) {
    return "数据库拒绝了该操作（需管理员权限）。";
  }
  if (code === "23505" || /duplicate key/i.test(message)) {
    return "该条目已存在。";
  }
  if (code === "42P01" || /does not exist/i.test(message)) {
    return "数据表不存在，请先执行 supabase/migrations/0004_feedback_tables.sql。";
  }
  return message;
}

function revalidate() {
  revalidatePath("/admin/feedback-keywords");
  // 工具页的关键词来自同一份数据，也一并刷新
  revalidatePath("/tools/feedback");
  // ⚠️ revalidatePath 只清**路由缓存**，清不掉 getKeywords() 的**进程内 TTL 缓存**
  //    （实测过：调完 revalidatePath 再请求，仍然不查库、仍是旧值）。
  //    所以这里必须显式清一次，否则改完关键词最多 30 秒后工具页才更新。
  invalidateKeywords();
  // 同理：本文件里还有「教材 / 章节 / 短语」的增删改，以及分类的关键词维护，
  // 它们各自的静态表缓存（30 秒）也必须一起清 —— 否则后台改完教材/章节/短语，
  // 工具页最长 30 秒才更新。两个清缓存函数放在一起，避免以后新增写操作时漏掉一个。
  invalidateStaticTables();
}

// ============================================================
// 关键词
// ============================================================

/** 从 FormData 读取维度（stage / textbookId / chapterId），非数字视为空 */
function readScope(formData: FormData) {
  const stage = String(formData.get("stage") ?? "").trim();
  const toId = (name: string): number | null => {
    const raw = String(formData.get(name) ?? "").trim();
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return {
    stage: stage === "senior" || stage === "junior" ? stage : null,
    textbookId: toId("textbookId"),
    chapterId: toId("chapterId"),
    chapterName: String(formData.get("chapterName") ?? "").trim() || null,
  };
}

export async function addKeyword(
  _prev: KeywordActionResult,
  formData: FormData,
): Promise<KeywordActionResult> {
  const guard = await requireAdmin(); // ← 服务端权威校验，前端判断不作为边界
  if (!guard.ok) return deny(guard.reason);

  const subject = String(formData.get("subject") ?? "").trim();
  const category = String(formData.get("category") ?? "").trim();
  const keyword = String(formData.get("keyword") ?? "").trim();
  const scope = readScope(formData);

  if (!subject || !category || !keyword) {
    return { status: "error", message: "科目、分类、关键词都不能为空。" };
  }
  if (keyword.length > MAX_KEYWORD) {
    return { status: "error", message: `关键词过长（上限 ${MAX_KEYWORD} 字）。` };
  }

  const supabase = await createClient();

  // 同维度已存在则不重复插入（章节关键词在「课堂内容/下节课内容」下各有一行，
  // 因此在章节维度下新增时，两个分类一起补齐，保持数据一致）
  const targets =
    scope.chapterId !== null
      ? [
          { category: "课堂内容", ...scope },
          { category: "下节课内容", ...scope },
        ]
      : [{ category, ...scope }];

  let added = 0;
  for (const t of targets) {
    let dupQuery = supabase
      .from("feedback_keywords")
      .select("id")
      .eq("subject", subject)
      .eq("category", t.category)
      .eq("keyword", keyword)
      .is("archived_at", null)
      .limit(1);
    dupQuery = t.stage ? dupQuery.eq("stage", t.stage) : dupQuery.is("stage", null);
    dupQuery =
      t.textbookId === null ? dupQuery.is("textbook_id", null) : dupQuery.eq("textbook_id", t.textbookId);
    dupQuery =
      t.chapterId === null ? dupQuery.is("chapter_id", null) : dupQuery.eq("chapter_id", t.chapterId);
    const { data: dup } = await dupQuery.maybeSingle();
    if (dup) continue; // 该维度下已有，跳过

    // 排到同维度末尾
    let lastQuery = supabase
      .from("feedback_keywords")
      .select("sort_order")
      .eq("subject", subject)
      .eq("category", t.category)
      .order("sort_order", { ascending: false })
      .limit(1);
    lastQuery =
      t.textbookId === null ? lastQuery.is("textbook_id", null) : lastQuery.eq("textbook_id", t.textbookId);
    lastQuery =
      t.chapterId === null ? lastQuery.is("chapter_id", null) : lastQuery.eq("chapter_id", t.chapterId);
    const { data: last } = await lastQuery.maybeSingle();

    const { error } = await supabase.from("feedback_keywords").insert({
      subject,
      category: t.category,
      keyword,
      sort_order: (last?.sort_order ?? 0) + 10,
      stage: t.stage,
      textbook_id: t.textbookId,
      chapter_id: t.chapterId,
      chapter_name: t.chapterName,
    });
    if (error) return { status: "error", message: describe(error.message, error.code) };
    added++;
  }

  revalidate();
  if (added === 0) {
    return { status: "error", message: `该位置已有「${keyword}」。` };
  }
  const where = scope.chapterName ? `章节「${scope.chapterName}」` : `「${category}」`;
  return {
    status: "success",
    message: `已在${where}添加：${keyword}${scope.chapterId !== null ? "（课堂内容/下节课内容 各一条）" : ""}`,
  };
}

export async function updateKeyword(
  _prev: KeywordActionResult,
  formData: FormData,
): Promise<KeywordActionResult> {
  const guard = await requireAdmin();
  if (!guard.ok) return deny(guard.reason);

  const id = Number(formData.get("id"));
  const keyword = String(formData.get("keyword") ?? "").trim();
  const sortOrderRaw = String(formData.get("sortOrder") ?? "").trim();

  if (!Number.isFinite(id)) return { status: "error", message: "缺少条目 ID。" };
  if (!keyword) return { status: "error", message: "关键词不能为空。" };
  if (keyword.length > MAX_KEYWORD) return { status: "error", message: "关键词过长。" };

  const patch: Record<string, unknown> = { keyword };
  if (sortOrderRaw !== "") {
    const n = Number(sortOrderRaw);
    if (!Number.isFinite(n)) return { status: "error", message: "排序值必须是数字。" };
    patch.sort_order = n;
  }

  const supabase = await createClient();
  const { error } = await supabase.from("feedback_keywords").update(patch).eq("id", id);

  if (error) return { status: "error", message: describe(error.message, error.code) };

  revalidate();
  return { status: "success", message: "已更新。" };
}

export async function deleteKeyword(
  _prev: KeywordActionResult,
  formData: FormData,
): Promise<KeywordActionResult> {
  const guard = await requireAdmin();
  if (!guard.ok) return deny(guard.reason);

  const id = Number(formData.get("id"));
  if (!Number.isFinite(id)) return { status: "error", message: "缺少条目 ID。" };

  const supabase = await createClient();

  // 先读该行，判断是不是章节关键词（章节词在两个内容分类下各有一行，需要一起删）
  const { data: row, error: readErr } = await supabase
    .from("feedback_keywords")
    .select("id, subject, keyword, category, chapter_id, textbook_id")
    .eq("id", id)
    .maybeSingle();

  if (readErr) return { status: "error", message: describe(readErr.message, readErr.code) };
  if (!row) return { status: "error", message: "条目不存在。" };

  if (row.chapter_id !== null) {
    // 章节关键词：按「科目 + 关键词 + 章节」一次删掉两个内容分类的行
    const { data: deleted, error } = await supabase
      .from("feedback_keywords")
      .delete()
      .eq("subject", row.subject)
      .eq("keyword", row.keyword)
      .eq("chapter_id", row.chapter_id)
      .select("id");

    if (error) return { status: "error", message: describe(error.message, error.code) };
    revalidate();
    return {
      status: "success",
      message: `已删除章节关键词：${row.keyword}（${(deleted ?? []).length} 条）`,
    };
  }

  const { error } = await supabase.from("feedback_keywords").delete().eq("id", id);
  if (error) return { status: "error", message: describe(error.message, error.code) };

  revalidate();
  return { status: "success", message: "已删除。" };
}

/** 把一个分类里的关键词按当前 sort_order 重排为 1..n（用于清理空档） */
export async function normalizeCategory(
  _prev: KeywordActionResult,
  formData: FormData,
): Promise<KeywordActionResult> {
  const guard = await requireAdmin();
  if (!guard.ok) return deny(guard.reason);

  const subject = String(formData.get("subject") ?? "").trim();
  const category = String(formData.get("category") ?? "").trim();
  const scope = readScope(formData);
  if (!subject || !category) return { status: "error", message: "缺少科目或分类。" };

  const supabase = await createClient();
  let q = supabase
    .from("feedback_keywords")
    .select("id, sort_order")
    .eq("subject", subject)
    .eq("category", category)
    .is("archived_at", null);
  q = scope.textbookId === null ? q.is("textbook_id", null) : q.eq("textbook_id", scope.textbookId);
  q = scope.chapterId === null ? q.is("chapter_id", null) : q.eq("chapter_id", scope.chapterId);

  const { data, error } = await q.order("sort_order", { ascending: true }).order("id", { ascending: true });

  if (error) return { status: "error", message: describe(error.message, error.code) };

  const rows = data ?? [];
  for (let i = 0; i < rows.length; i++) {
    const want = (i + 1) * 10;
    if (rows[i].sort_order === want) continue;
    const { error: upErr } = await supabase
      .from("feedback_keywords")
      .update({ sort_order: want })
      .eq("id", rows[i].id);
    if (upErr) return { status: "error", message: describe(upErr.message, upErr.code) };
  }

  revalidate();
  return { status: "success", message: `已重排「${category}」的 ${rows.length} 个关键词。` };
}

// ============================================================
// 教材与章节（第 7 步新增）
// ============================================================

const MAX_TEXTBOOK = 80;
const MAX_VERSION = 40;
const MAX_CHAPTER = 120;

/** 册次占位符：表示该版本没有册次之分 */
const NO_VOLUME = "-";

export async function addTextbook(
  _prev: KeywordActionResult,
  formData: FormData,
): Promise<KeywordActionResult> {
  const guard = await requireAdmin();
  if (!guard.ok) return deny(guard.reason);

  const stage = String(formData.get("stage") ?? "").trim();
  const subject = String(formData.get("subject") ?? "").trim();
  const version = String(formData.get("version") ?? "").trim();
  const rawName = String(formData.get("name") ?? "").trim();
  if (stage !== "senior" && stage !== "junior") return { status: "error", message: "学段不合法。" };
  if (!subject || !version) return { status: "error", message: "科目与教材版本不能为空。" };
  if (version.length > MAX_VERSION) return { status: "error", message: "版本名过长。" };
  if (rawName.length > MAX_TEXTBOOK) return { status: "error", message: "册次名过长。" };
  const name = rawName || NO_VOLUME;

  const supabase = await createClient();
  const { data: last } = await supabase
    .from("feedback_textbooks")
    .select("sort_order")
    .eq("stage", stage)
    .eq("subject", subject)
    .eq("version", version)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { error } = await supabase
    .from("feedback_textbooks")
    .insert({ stage, subject, version, name, sort_order: (last?.sort_order ?? 0) + 10 });

  if (error) return { status: "error", message: describe(error.message, error.code) };
  revalidate();
  return { status: "success", message: `已添加教材：${version}${name === NO_VOLUME ? "" : " · " + name}` };
}

export async function updateTextbook(
  _prev: KeywordActionResult,
  formData: FormData,
): Promise<KeywordActionResult> {
  const guard = await requireAdmin();
  if (!guard.ok) return deny(guard.reason);

  const id = Number(formData.get("id"));
  const version = String(formData.get("version") ?? "").trim();
  const rawName = String(formData.get("name") ?? "").trim();
  const sortRaw = String(formData.get("sortOrder") ?? "").trim();
  if (!Number.isFinite(id)) return { status: "error", message: "缺少教材 ID。" };
  if (!version) return { status: "error", message: "版本名不能为空。" };
  if (version.length > MAX_VERSION) return { status: "error", message: "版本名过长。" };
  if (rawName.length > MAX_TEXTBOOK) return { status: "error", message: "册次名过长。" };

  const patch: Record<string, unknown> = { version, name: rawName || NO_VOLUME };
  if (sortRaw !== "") {
    const n = Number(sortRaw);
    if (!Number.isFinite(n)) return { status: "error", message: "排序必须是数字。" };
    patch.sort_order = n;
  }

  const supabase = await createClient();
  const { error } = await supabase.from("feedback_textbooks").update(patch).eq("id", id);
  if (error) return { status: "error", message: describe(error.message, error.code) };

  revalidate();
  return { status: "success", message: `已更新教材：${version}${rawName ? " · " + rawName : ""}` };
}

/** 删除教材会级联删除其章节；关键词的 textbook_id/chapter_id 会被置空（on delete set null） */
export async function deleteTextbook(
  _prev: KeywordActionResult,
  formData: FormData,
): Promise<KeywordActionResult> {
  const guard = await requireAdmin();
  if (!guard.ok) return deny(guard.reason);

  const id = Number(formData.get("id"));
  if (!Number.isFinite(id)) return { status: "error", message: "缺少教材 ID。" };

  const supabase = await createClient();
  const { data: tb } = await supabase.from("feedback_textbooks").select("name").eq("id", id).maybeSingle();
  const { error } = await supabase.from("feedback_textbooks").delete().eq("id", id);
  if (error) return { status: "error", message: describe(error.message, error.code) };

  revalidate();
  return { status: "success", message: `已删除教材：${tb?.name ?? id}（其章节一并删除）` };
}

export async function addChapter(
  _prev: KeywordActionResult,
  formData: FormData,
): Promise<KeywordActionResult> {
  const guard = await requireAdmin();
  if (!guard.ok) return deny(guard.reason);

  const textbookId = Number(formData.get("textbookId"));
  const name = String(formData.get("name") ?? "").trim();
  if (!Number.isFinite(textbookId)) return { status: "error", message: "缺少教材 ID。" };
  if (!name) return { status: "error", message: "章节名不能为空。" };
  if (name.length > MAX_CHAPTER) return { status: "error", message: "章节名过长。" };

  const supabase = await createClient();
  const { data: last } = await supabase
    .from("feedback_chapters")
    .select("sort_order")
    .eq("textbook_id", textbookId)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { error } = await supabase
    .from("feedback_chapters")
    .insert({ textbook_id: textbookId, name, sort_order: (last?.sort_order ?? 0) + 10 });

  if (error) return { status: "error", message: describe(error.message, error.code) };
  revalidate();
  return { status: "success", message: `已添加章节：${name}` };
}

export async function updateChapter(
  _prev: KeywordActionResult,
  formData: FormData,
): Promise<KeywordActionResult> {
  const guard = await requireAdmin();
  if (!guard.ok) return deny(guard.reason);

  const id = Number(formData.get("id"));
  const name = String(formData.get("name") ?? "").trim();
  const sortRaw = String(formData.get("sortOrder") ?? "").trim();
  if (!Number.isFinite(id)) return { status: "error", message: "缺少章节 ID。" };
  if (!name) return { status: "error", message: "章节名不能为空。" };
  if (name.length > MAX_CHAPTER) return { status: "error", message: "章节名过长。" };

  const patch: Record<string, unknown> = { name };
  if (sortRaw !== "") {
    const n = Number(sortRaw);
    if (!Number.isFinite(n)) return { status: "error", message: "排序必须是数字。" };
    patch.sort_order = n;
  }

  const supabase = await createClient();
  const { error } = await supabase.from("feedback_chapters").update(patch).eq("id", id);
  if (error) return { status: "error", message: describe(error.message, error.code) };

  revalidate();
  return { status: "success", message: `已更新章节：${name}` };
}

export async function deleteChapter(
  _prev: KeywordActionResult,
  formData: FormData,
): Promise<KeywordActionResult> {
  const guard = await requireAdmin();
  if (!guard.ok) return deny(guard.reason);

  const id = Number(formData.get("id"));
  if (!Number.isFinite(id)) return { status: "error", message: "缺少章节 ID。" };

  const supabase = await createClient();
  const { data: ch } = await supabase.from("feedback_chapters").select("name").eq("id", id).maybeSingle();
  const { error } = await supabase.from("feedback_chapters").delete().eq("id", id);
  if (error) return { status: "error", message: describe(error.message, error.code) };

  revalidate();
  return { status: "success", message: `已删除章节：${ch?.name ?? id}` };
}

// ============================================================
// 短语
// ============================================================

export async function addPhrase(
  _prev: KeywordActionResult,
  formData: FormData,
): Promise<KeywordActionResult> {
  const guard = await requireAdmin();
  if (!guard.ok) return deny(guard.reason);

  const phrase = String(formData.get("phrase") ?? "").trim();
  if (!phrase) return { status: "error", message: "短语不能为空。" };
  if (phrase.length > MAX_PHRASE) return { status: "error", message: "短语过长。" };

  const supabase = await createClient();
  const { data: last } = await supabase
    .from("feedback_phrases")
    .select("sort_order")
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { error } = await supabase
    .from("feedback_phrases")
    .insert({ phrase, sort_order: (last?.sort_order ?? 0) + 10 });

  if (error) return { status: "error", message: describe(error.message, error.code) };

  revalidate();
  return { status: "success", message: "已添加短语。" };
}

export async function deletePhrase(
  _prev: KeywordActionResult,
  formData: FormData,
): Promise<KeywordActionResult> {
  const guard = await requireAdmin();
  if (!guard.ok) return deny(guard.reason);

  const id = Number(formData.get("id"));
  if (!Number.isFinite(id)) return { status: "error", message: "缺少条目 ID。" };

  const supabase = await createClient();
  const { error } = await supabase.from("feedback_phrases").delete().eq("id", id);

  if (error) return { status: "error", message: describe(error.message, error.code) };

  revalidate();
  return { status: "success", message: "已删除短语。" };
}

export async function updatePhrase(
  _prev: KeywordActionResult,
  formData: FormData,
): Promise<KeywordActionResult> {
  const guard = await requireAdmin();
  if (!guard.ok) return deny(guard.reason);

  const id = Number(formData.get("id"));
  const phrase = String(formData.get("phrase") ?? "").trim();
  if (!Number.isFinite(id)) return { status: "error", message: "缺少条目 ID。" };
  if (!phrase) return { status: "error", message: "短语不能为空。" };
  if (phrase.length > MAX_PHRASE) return { status: "error", message: "短语过长。" };

  const supabase = await createClient();
  const { error } = await supabase.from("feedback_phrases").update({ phrase }).eq("id", id);

  if (error) return { status: "error", message: describe(error.message, error.code) };

  revalidate();
  return { status: "success", message: "已更新短语。" };
}
