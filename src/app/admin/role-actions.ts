"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOwner } from "@/lib/auth-role";
import { invalidateUserRoles } from "@/lib/viewer";

const BASE = "/admin";

function back(params: Record<string, string>): never {
  redirect(`${BASE}?${new URLSearchParams(params).toString()}`);
}

function errText(error: { message: string; code?: string | null }): string {
  if (error.code === "42501") return "只有 Owner 能分配角色。";
  if (error.code === "P0002") return "找不到这个邮箱、大区或校区。";
  if (error.code === "22023") return "角色/范围不合法，请检查后重试。";
  return error.message || "保存失败，请稍后重试。";
}

export async function assignRoleAction(formData: FormData) {
  const guard = await requireOwner();
  if (!guard.ok) redirect(guard.reason === "unauthenticated" ? "/login" : "/tools?error=admin_required");

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const role = String(formData.get("role") ?? "").trim();
  const regionId = String(formData.get("regionId") ?? "").trim();
  const campusId = String(formData.get("campusId") ?? "").trim();

  if (!email.includes("@")) back({ roleErr: "请填写正确的老师邮箱。" });
  if (role !== "user" && role !== "admin") back({ roleErr: "请选择普通老师或管理员。" });

  const supabase = await createClient();

  // 先查管理者列表，禁止在 /admin 误把 Owner 降级（即使前端传了错误参数）。
  const managers = await supabase.rpc("admin_list_managers");
  if (!managers.error && Array.isArray(managers.data)) {
    const target = managers.data.find((m) => String(m.email ?? "").toLowerCase() === email);
    if (target?.admin_scope === "owner") back({ roleErr: "这个账号是 Owner，不能在 /admin 里降级；请到 Supabase 处理。" });
  }

  let scope: "region" | "campus" | "none";
  let scopeId: string | null;
  if (role === "user") {
    scope = "none";
    scopeId = null;
  } else if (regionId) {
    scope = "region";
    scopeId = regionId;
  } else if (campusId) {
    scope = "campus";
    scopeId = campusId;
  } else {
    back({ roleErr: "管理员必须选择大区或校区，不能设置为无范围 admin。" });
  }

  const { error } = await supabase.rpc("admin_set_manager", {
    p_email: email,
    p_scope: scope,
    p_scope_id: scopeId,
  });
  if (error) back({ roleErr: errText(error) });

  invalidateUserRoles();
  revalidatePath(BASE);
  revalidatePath("/admin/archives");
  back({ roleOk: `已更新 ${email} 的角色：${role === "user" ? "普通老师" : scope === "region" ? "大区管理员" : "校区管理员"}` });
}
