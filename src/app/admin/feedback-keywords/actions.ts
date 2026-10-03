"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-role";
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
}

// ============================================================
// 关键词
// ============================================================

export async function addKeyword(
  _prev: KeywordActionResult,
  formData: FormData,
): Promise<KeywordActionResult> {
  const guard = await requireAdmin(); // ← 服务端权威校验，前端判断不作为边界
  if (!guard.ok) return deny(guard.reason);

  const subject = String(formData.get("subject") ?? "").trim();
  const category = String(formData.get("category") ?? "").trim();
  const keyword = String(formData.get("keyword") ?? "").trim();

  if (!subject || !category || !keyword) {
    return { status: "error", message: "科目、分类、关键词都不能为空。" };
  }
  if (keyword.length > MAX_KEYWORD) {
    return { status: "error", message: `关键词过长（上限 ${MAX_KEYWORD} 字）。` };
  }

  const supabase = await createClient();

  // 排到该分类末尾
  const { data: last } = await supabase
    .from("feedback_keywords")
    .select("sort_order")
    .eq("subject", subject)
    .eq("category", category)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextOrder = (last?.sort_order ?? 0) + 1;

  const { error } = await supabase
    .from("feedback_keywords")
    .insert({ subject, category, keyword, sort_order: nextOrder });

  if (error) return { status: "error", message: describe(error.message, error.code) };

  revalidate();
  return { status: "success", message: `已在「${category}」添加：${keyword}` };
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
  if (!subject || !category) return { status: "error", message: "缺少科目或分类。" };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("feedback_keywords")
    .select("id, sort_order")
    .eq("subject", subject)
    .eq("category", category)
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });

  if (error) return { status: "error", message: describe(error.message, error.code) };

  const rows = data ?? [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].sort_order === i + 1) continue;
    const { error: upErr } = await supabase
      .from("feedback_keywords")
      .update({ sort_order: i + 1 })
      .eq("id", rows[i].id);
    if (upErr) return { status: "error", message: describe(upErr.message, upErr.code) };
  }

  revalidate();
  return { status: "success", message: `已重排「${category}」的 ${rows.length} 个关键词。` };
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
