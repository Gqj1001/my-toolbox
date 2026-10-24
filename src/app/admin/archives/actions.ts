"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentUserWithRole } from "@/lib/auth-role";
import { setStudentCampus } from "@/lib/admin-archives";

/**
 * 只改「机构校区归属标签」，不改档案正文/分数。
 * 非管理员直接拒绝；数据库函数内部还会再校验一次 `public.is_admin()`。
 */
export async function setArchiveCampusAction(formData: FormData) {
  const { role } = await getCurrentUserWithRole();
  if (role !== "admin") {
    redirect("/tools?error=admin_required");
  }

  const rawReturn = String(formData.get("returnTo") ?? "/admin/archives");
  const base = rawReturn.startsWith("/admin/archives") ? rawReturn : "/admin/archives";
  const sep = base.includes("?") ? "&" : "?";

  const id = Number(formData.get("id"));
  const campus = String(formData.get("campus") ?? "").trim();
  if (!Number.isFinite(id) || id <= 0) {
    redirect(base + sep + "err=" + encodeURIComponent("缺少档案 id，未修改。"));
  }
  if (campus.length > 40) {
    redirect(base + sep + "err=" + encodeURIComponent("校区名过长（最多 40 字）。"));
  }

  const r = await setStudentCampus(id, campus);
  revalidatePath("/admin/archives");
  if (!r.ok) {
    redirect(base + sep + "err=" + encodeURIComponent(r.message ?? "归属纠正失败。"));
  }
  redirect(base + sep + "saved=1");
}
