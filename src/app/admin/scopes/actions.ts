"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOwner } from "@/lib/auth-role";
import { invalidateUserRoles } from "@/lib/viewer";

const BASE = "/admin/scopes";

function back(params: Record<string, string>): never {
  const sp = new URLSearchParams(params);
  redirect(`${BASE}?${sp.toString()}`);
}

function errMessage(error: { message: string; code?: string | null }): string {
  if (error.code === "42501") return "只有 Owner 能操作。";
  if (error.code === "P0002") return "找不到这个账号、大区或校区。";
  if (error.code === "22023") return "名称/范围不合法，请检查后重试。";
  return error.message || "操作失败，请稍后重试。";
}

export async function createRegionAction(formData: FormData) {
  const guard = await requireOwner();
  if (!guard.ok) redirect(guard.reason === "unauthenticated" ? "/login" : "/tools?error=admin_required");

  const name = String(formData.get("name") ?? "").trim();
  if (name.length < 2 || name.length > 40) back({ err: "大区名称需 2–40 个字。" });

  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_create_region", { p_name: name });
  if (error) back({ err: errMessage(error) });

  revalidatePath(BASE);
  back({ ok: `已新建大区：${name}` });
}

export async function createCampusAction(formData: FormData) {
  const guard = await requireOwner();
  if (!guard.ok) redirect(guard.reason === "unauthenticated" ? "/login" : "/tools?error=admin_required");

  const regionId = String(formData.get("regionId") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  if (!regionId) back({ err: "请先选择大区。" });
  if (name.length < 2 || name.length > 40) back({ err: "校区名称需 2–40 个字。" });

  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_create_campus", {
    p_region_id: regionId,
    p_name: name,
  });
  if (error) back({ err: errMessage(error) });

  revalidatePath(BASE);
  back({ ok: `已新建校区：${name}` });
}

export async function assignManagerAction(formData: FormData) {
  const guard = await requireOwner();
  if (!guard.ok) redirect(guard.reason === "unauthenticated" ? "/login" : "/tools?error=admin_required");

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const scope = String(formData.get("scope") ?? "").trim();
  if (!email.includes("@")) back({ err: "请填写正确的老师邮箱。" });
  if (!["owner", "region", "campus", "none"].includes(scope)) back({ err: "请选择要分配的角色。" });

  let scopeId: string | null = null;
  if (scope === "region") {
    scopeId = String(formData.get("regionId") ?? "").trim() || null;
    if (!scopeId) back({ err: "请选择大区。" });
  } else if (scope === "campus") {
    scopeId = String(formData.get("campusId") ?? "").trim() || null;
    if (!scopeId) back({ err: "请选择校区。" });
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_set_manager", {
    p_email: email,
    p_scope: scope,
    p_scope_id: scopeId,
  });
  if (error) back({ err: errMessage(error) });

  invalidateUserRoles();
  revalidatePath(BASE);
  revalidatePath("/admin");
  back({ ok: `已更新 ${email} 的权限。` });
}
