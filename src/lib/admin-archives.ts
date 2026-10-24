import "server-only";

import { createClient } from "@/lib/supabase/server";

/**
 * 全机构档案总览（A2）的服务端读取。
 *
 * ⚠️ 只走 SECURITY DEFINER 的 `admin_list_all_students()`（0027）：
 *    不直接查 `feedback_students` —— 那样会被 RLS 过滤成“只有管理员自己的档案”，
 *    和后台资料 Bug 是同一类错误。
 * ⚠️ 本文件**不提供**改档案正文的能力；归属纠正只改 `extra.institutionCampus` 标签。
 */

export type AdminArchiveRow = {
  id: number;
  name: string;
  grade: string;
  school: string;
  manager: string;
  teacherName: string;
  teacherCampus: string;
  institutionCampus: string;
  campusSource: "manual" | "teacher" | "none";
  ownerEmail: string;
  updatedAt: string | null;
};

export type AdminArchiveResult =
  | { ok: true; rows: AdminArchiveRow[]; total: number }
  | { ok: false; message: string };

export const ARCHIVES_MIGRATION = "supabase/migrations/0027_admin_archives_a2.sql";

function describeDbError(message: string, code?: string | null): string {
  if (code === "PGRST202" || /Could not find the function|does not exist/i.test(message)) {
    return `全机构档案总览的数据库函数还没建：请先在 Supabase SQL Editor 执行 ${ARCHIVES_MIGRATION}（重复执行也安全）。`;
  }
  return message;
}

type RawRow = {
  id: number | string;
  name: string;
  grade: string | null;
  school: string | null;
  manager: string | null;
  teacher_name: string | null;
  teacher_campus: string | null;
  institution_campus: string | null;
  campus_source: string | null;
  owner_email: string | null;
  updated_at: string | null;
  total_count: number | string;
};

export async function listAllStudents(opts: {
  search?: string;
  campus?: string;
  teacher?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<AdminArchiveResult> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("admin_list_all_students", {
      p_search: opts.search ?? "",
      p_campus: opts.campus ?? "",
      p_teacher: opts.teacher ?? "",
      p_limit: opts.limit ?? 200,
      p_offset: opts.offset ?? 0,
    });
    if (error) {
      console.error("[admin-archives] 读取失败:", error.message);
      return { ok: false, message: describeDbError(error.message, error.code) };
    }
    const raw = (data ?? []) as RawRow[];
    const rows: AdminArchiveRow[] = raw.map((r) => ({
      id: Number(r.id),
      name: String(r.name ?? ""),
      grade: String(r.grade ?? ""),
      school: String(r.school ?? ""),
      manager: String(r.manager ?? ""),
      teacherName: String(r.teacher_name ?? ""),
      teacherCampus: String(r.teacher_campus ?? ""),
      institutionCampus: String(r.institution_campus ?? ""),
      campusSource: r.campus_source === "manual" || r.campus_source === "teacher" ? r.campus_source : "none",
      ownerEmail: String(r.owner_email ?? ""),
      updatedAt: r.updated_at,
    }));
    return { ok: true, rows, total: raw.length ? Number(raw[0].total_count) : 0 };
  } catch (e) {
    console.error("[admin-archives] 读取异常:", String(e));
    return { ok: false, message: "读取全机构档案失败，请稍后重试。" };
  }
}

export async function setStudentCampus(id: number, campus: string): Promise<{ ok: boolean; message?: string }> {
  try {
    const supabase = await createClient();
    const { error } = await supabase.rpc("admin_set_student_campus", {
      p_student_id: id,
      p_campus: campus,
    });
    if (error) {
      console.error("[admin-archives] 归属纠正失败:", error.message);
      return { ok: false, message: describeDbError(error.message, error.code) };
    }
    return { ok: true };
  } catch (e) {
    console.error("[admin-archives] 归属纠正异常:", String(e));
    return { ok: false, message: "归属纠正失败，请稍后重试。" };
  }
}
