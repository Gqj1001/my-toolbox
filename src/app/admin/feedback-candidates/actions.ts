"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-role";
import { createClient } from "@/lib/supabase/server";

export type CandidateActionResult = {
  status: "idle" | "success" | "error";
  message?: string;
};

/** 「课堂内容」「下节课内容」两个分类都写入知识点，与现有数学人教A版保持一致 */
const CHAPTER_CATEGORIES = ["课堂内容", "下节课内容"] as const;

function deny(reason: "unauthenticated" | "forbidden"): CandidateActionResult {
  return {
    status: "error",
    message: reason === "unauthenticated" ? "登录已过期，请重新登录。" : "没有权限执行该操作。",
  };
}

function describe(message: string, code?: string): string {
  if (code === "42501" || /row-level security|permission denied/i.test(message)) {
    return "数据库拒绝了该操作（需管理员权限）。";
  }
  if (code === "23505" || /duplicate key/i.test(message)) return "该条目已存在。";
  if (code === "42P01" || /does not exist/i.test(message)) {
    return "数据表不存在，请先执行 supabase/migrations/0007_sections_and_candidates.sql。";
  }
  return message;
}

function revalidate() {
  revalidatePath("/admin/feedback-candidates");
  revalidatePath("/admin/feedback-keywords");
  revalidatePath("/tools/feedback");
}

// ============================================================
// 审核操作
// ============================================================

async function setStatus(ids: number[], status: "approved" | "rejected" | "pending") {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { error } = await supabase
    .from("feedback_section_candidates")
    .update({
      status,
      reviewed_by: user?.id ?? null,
      reviewed_at: status === "pending" ? null : new Date().toISOString(),
    })
    .in("id", ids);

  if (error) return { ok: false as const, message: describe(error.message, error.code) };
  return { ok: true as const, count: ids.length };
}

export async function reviewCandidate(
  _prev: CandidateActionResult,
  formData: FormData,
): Promise<CandidateActionResult> {
  const guard = await requireAdmin();
  if (!guard.ok) return deny(guard.reason);

  const id = Number(formData.get("id"));
  const action = String(formData.get("action") ?? "");
  if (!Number.isFinite(id)) return { status: "error", message: "缺少条目 ID。" };
  if (!["approve", "reject", "reset"].includes(action)) {
    return { status: "error", message: "未知操作。" };
  }

  const status = action === "approve" ? "approved" : action === "reject" ? "rejected" : "pending";
  const r = await setStatus([id], status);
  if (!r.ok) return { status: "error", message: r.message };
  revalidate();
  const label = action === "approve" ? "已通过" : action === "reject" ? "已拒绝" : "已重置";
  return { status: "success", message: label };
}

/** 批量：按批次 + 学段 + 科目（可选）审核 */
export async function reviewCandidatesBulk(
  _prev: CandidateActionResult,
  formData: FormData,
): Promise<CandidateActionResult> {
  const guard = await requireAdmin();
  if (!guard.ok) return deny(guard.reason);

  const batchId = String(formData.get("batchId") ?? "").trim();
  const subject = String(formData.get("subject") ?? "").trim();
  const action = String(formData.get("action") ?? "");
  if (!batchId) return { status: "error", message: "缺少批次号。" };
  if (!["approve", "reject", "reset"].includes(action)) {
    return { status: "error", message: "未知操作。" };
  }

  const supabase = await createClient();
  let q = supabase
    .from("feedback_section_candidates")
    .select("id")
    .eq("batch_id", batchId)
    .eq("status", "pending");
  if (subject) q = q.eq("subject", subject);

  const { data, error } = await q;
  if (error) return { status: "error", message: describe(error.message, error.code) };

  const ids = (data ?? []).map((r) => r.id);
  if (ids.length === 0) return { status: "error", message: "没有待审核的条目。" };

  const status = action === "approve" ? "approved" : action === "reject" ? "rejected" : "pending";
  const r = await setStatus(ids, status);
  if (!r.ok) return { status: "error", message: r.message };

  revalidate();
  return { status: "success", message: `已批量处理 ${ids.length} 条（${subject || "全部科目"}）` };
}

/** 保存审核备注 */
export async function saveCandidateNote(
  _prev: CandidateActionResult,
  formData: FormData,
): Promise<CandidateActionResult> {
  const guard = await requireAdmin();
  if (!guard.ok) return deny(guard.reason);

  const id = Number(formData.get("id"));
  const note = String(formData.get("note") ?? "").trim().slice(0, 500);
  if (!Number.isFinite(id)) return { status: "error", message: "缺少条目 ID。" };

  const supabase = await createClient();
  const { error } = await supabase
    .from("feedback_section_candidates")
    .update({ note: note || null })
    .eq("id", id);
  if (error) return { status: "error", message: describe(error.message, error.code) };

  revalidate();
  return { status: "success", message: "备注已保存" };
}

// ============================================================
// 提升为正式数据
// ============================================================

/** 找或建教材行（册次级） */
async function findOrCreateTextbook(
  stage: string,
  subject: string,
  version: string,
  name: string,
): Promise<{ id: number | null; created: boolean; error?: string }> {
  const supabase = await createClient();
  const { data: exist } = await supabase
    .from("feedback_textbooks")
    .select("id")
    .eq("stage", stage)
    .eq("subject", subject)
    .eq("version", version)
    .eq("name", name)
    .maybeSingle();
  if (exist?.id) return { id: exist.id, created: false };

  const { data: last } = await supabase
    .from("feedback_textbooks")
    .select("sort_order")
    .eq("stage", stage)
    .eq("subject", subject)
    .eq("version", version)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: created, error } = await supabase
    .from("feedback_textbooks")
    .insert({ stage, subject, version, name, sort_order: (last?.sort_order ?? 0) + 10 })
    .select("id")
    .single();
  if (error) return { id: null, created: false, error: describe(error.message, error.code) };
  return { id: created!.id, created: true };
}

/**
 * 把已通过的候选提升为正式数据。
 * 每次最多处理 limit 条（默认 20），便于观察进度、出错可停。
 */
export async function promoteApproved(
  _prev: CandidateActionResult,
  formData: FormData,
): Promise<CandidateActionResult> {
  const guard = await requireAdmin();
  if (!guard.ok) return deny(guard.reason);

  const batchId = String(formData.get("batchId") ?? "").trim();
  const subject = String(formData.get("subject") ?? "").trim();
  const limit = Math.min(Math.max(Number(formData.get("limit") ?? 20) || 20, 1), 100);
  if (!batchId) return { status: "error", message: "缺少批次号。" };

  const supabase = await createClient();
  let q = supabase
    .from("feedback_section_candidates")
    .select("id, stage, subject, version, book_name, section_name, keywords")
    .eq("batch_id", batchId)
    .eq("status", "approved")
    .is("promoted_at", null)
    .limit(limit);
  if (subject) q = q.eq("subject", subject);

  const { data: candidates, error } = await q;
  if (error) return { status: "error", message: describe(error.message, error.code) };
  if (!candidates || candidates.length === 0) {
    return { status: "error", message: "没有「已通过但尚未提升」的条目。" };
  }

  let sections = 0;
  let chapters = 0;
  let keywords = 0;
  const promotedIds: number[] = [];
  const errors: string[] = [];

  for (const c of candidates) {
    // 1) 教材行
    const tb = await findOrCreateTextbook(c.stage, c.subject, c.version, c.book_name);
    if (!tb.id) {
      errors.push(`${c.version}/${c.book_name}: ${tb.error}`);
      continue;
    }

    // 2) 章（feedback_sections）
    const { data: existingSection } = await supabase
      .from("feedback_sections")
      .select("id")
      .eq("textbook_id", tb.id)
      .eq("name", c.section_name)
      .maybeSingle();

    let sectionId = existingSection?.id ?? null;
    if (!sectionId) {
      const { data: lastSec } = await supabase
        .from("feedback_sections")
        .select("sort_order")
        .eq("textbook_id", tb.id)
        .order("sort_order", { ascending: false })
        .limit(1)
        .maybeSingle();
      const { data: newSec, error: secErr } = await supabase
        .from("feedback_sections")
        .insert({
          textbook_id: tb.id,
          name: c.section_name,
          sort_order: (lastSec?.sort_order ?? 0) + 10,
        })
        .select("id")
        .single();
      if (secErr) {
        errors.push(`${c.section_name}: ${describe(secErr.message, secErr.code)}`);
        continue;
      }
      sectionId = newSec!.id;
      sections++;
    }

    // 3) 知识点（feedback_chapters）+ 关键词（feedback_keywords）
    const list: string[] = Array.isArray(c.keywords) ? c.keywords : [];
    for (let i = 0; i < list.length; i++) {
      const name = String(list[i]).trim();
      if (!name) continue;

      const { data: existCh } = await supabase
        .from("feedback_chapters")
        .select("id")
        .eq("textbook_id", tb.id)
        .eq("name", name)
        .maybeSingle();

      let chapterId = existCh?.id ?? null;
      if (!chapterId) {
        const { data: newCh, error: chErr } = await supabase
          .from("feedback_chapters")
          .insert({
            textbook_id: tb.id,
            section_id: sectionId,
            name,
            sort_order: (i + 1) * 10,
            import_batch_id: batchId,
          })
          .select("id")
          .single();
        if (chErr) {
          errors.push(`${c.section_name} / ${name}: ${describe(chErr.message, chErr.code)}`);
          continue;
        }
        chapterId = newCh!.id;
        chapters++;
      }

      // 两个内容分类各写一行
      for (const category of CHAPTER_CATEGORIES) {
        const { data: existKw } = await supabase
          .from("feedback_keywords")
          .select("id")
          .eq("subject", c.subject)
          .eq("category", category)
          .eq("keyword", name)
          .eq("chapter_id", chapterId)
          .maybeSingle();
        if (existKw?.id) continue;

        const { error: kwErr } = await supabase.from("feedback_keywords").insert({
          subject: c.subject,
          category,
          keyword: name,
          sort_order: (i + 1) * 10,
          stage: c.stage,
          textbook_id: tb.id,
          chapter_id: chapterId,
          chapter_name: c.section_name,
          import_batch_id: batchId,
        });
        if (kwErr) errors.push(`关键词 ${name}: ${describe(kwErr.message, kwErr.code)}`);
        else keywords++;
      }
    }

    promotedIds.push(c.id);
  }

  if (promotedIds.length) {
    await supabase
      .from("feedback_section_candidates")
      .update({ promoted_at: new Date().toISOString() })
      .in("id", promotedIds);
  }

  revalidate();

  const parts = [
    `已提升 ${promotedIds.length} 章`,
    `新增章 ${sections}`,
    `新增知识点 ${chapters}`,
    `新增关键词 ${keywords}`,
  ];
  if (errors.length) parts.push(`⚠️ ${errors.length} 个错误：${errors.slice(0, 3).join("；")}`);

  return {
    status: errors.length && promotedIds.length === 0 ? "error" : "success",
    message: parts.join("，"),
  };
}

/** 回滚某一批次已提升的正式数据（软回滚：归档关键词，删除知识点与章） */
export async function rollbackBatch(
  _prev: CandidateActionResult,
  formData: FormData,
): Promise<CandidateActionResult> {
  const guard = await requireAdmin();
  if (!guard.ok) return deny(guard.reason);

  const batchId = String(formData.get("batchId") ?? "").trim();
  const mode = String(formData.get("mode") ?? "soft");
  if (!batchId) return { status: "error", message: "缺少批次号。" };

  const supabase = await createClient();

  // 关键词：软回滚 = 打 archived_at；硬回滚 = 删除
  const kwUpdate =
    mode === "hard"
      ? await supabase.from("feedback_keywords").delete().eq("import_batch_id", batchId).select("id")
      : await supabase
          .from("feedback_keywords")
          .update({ archived_at: new Date().toISOString() })
          .eq("import_batch_id", batchId)
          .is("archived_at", null)
          .select("id");
  if (kwUpdate.error) return { status: "error", message: describe(kwUpdate.error.message, kwUpdate.error.code) };

  // 知识点与章：只有硬回滚才删（软回滚保留，仅关键词不可见）
  let removedCh = 0;
  let removedSec = 0;
  if (mode === "hard") {
    const { data: chRows } = await supabase
      .from("feedback_chapters")
      .select("id, section_id")
      .eq("import_batch_id", batchId);
    const sectionIds = [...new Set((chRows ?? []).map((r) => r.section_id).filter(Boolean))];

    const delCh = await supabase.from("feedback_chapters").delete().eq("import_batch_id", batchId).select("id");
    if (delCh.error) return { status: "error", message: describe(delCh.error.message, delCh.error.code) };
    removedCh = (delCh.data ?? []).length;

    if (sectionIds.length) {
      // 只删该批次导入、且已没有知识点挂着的章
      for (const sid of sectionIds) {
        const { count } = await supabase
          .from("feedback_chapters")
          .select("*", { count: "exact", head: true })
          .eq("section_id", sid);
        if ((count ?? 0) === 0) {
          const del = await supabase.from("feedback_sections").delete().eq("id", sid).select("id");
          if (!del.error) removedSec += (del.data ?? []).length;
        }
      }
    }

    await supabase
      .from("feedback_section_candidates")
      .update({ promoted_at: null })
      .eq("batch_id", batchId);
  }

  revalidate();
  const label = mode === "hard" ? "硬回滚" : "软回滚";
  return {
    status: "success",
    message:
      mode === "hard"
        ? `${label}完成：删除关键词 ${(kwUpdate.data ?? []).length} 行、知识点 ${removedCh} 行、章 ${removedSec} 行`
        : `${label}完成：归档关键词 ${(kwUpdate.data ?? []).length} 行（知识点与章保留，可恢复）`,
  };
}
