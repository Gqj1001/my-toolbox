import "server-only";

import { createClient } from "@/lib/supabase/server";

export type ScopeCampus = { id: string; name: string; regionId: string };
export type ScopeRegion = { id: string; name: string; campuses: ScopeCampus[] };
export type ScopeManager = {
  userId: string;
  email: string;
  teacherName: string;
  role: string;
  scope: "owner" | "region" | "campus" | null;
  scopeId: string | null;
  scopeName: string;
  campusId: string | null;
  campusName: string;
  updatedAt: string | null;
};

export type ScopeDataResult =
  | { ok: true; regions: ScopeRegion[]; managers: ScopeManager[] }
  | { ok: false; message: string };

type RawCampus = { id: string; name: string; region_id: string };
type RawManager = Record<string, unknown>;

export async function getScopeData(): Promise<ScopeDataResult> {
  try {
    const supabase = await createClient();
    const [regionsRes, campusesRes, managersRes] = await Promise.all([
      supabase.from("regions").select("id,name").order("name"),
      supabase.from("campuses").select("id,name,region_id").order("name"),
      supabase.rpc("admin_list_managers"),
    ]);

    if (regionsRes.error || campusesRes.error || managersRes.error) {
      const message = regionsRes.error?.message || campusesRes.error?.message || managersRes.error?.message || "";
      if (/Could not find the function|does not exist/i.test(message)) {
        return { ok: false, message: "权限管理函数还没建：请先执行 0033_admin_scopes_and_student_detail.sql。" };
      }
      console.error("[admin-scopes] 读取失败:", message);
      return { ok: false, message: "读取大区/校区/管理者失败，请稍后重试。" };
    }

    const campuses = (campusesRes.data ?? []) as RawCampus[];
    const regions: ScopeRegion[] = (regionsRes.data ?? []).map((r) => {
      const row = r as { id: string; name: string };
      return {
        id: row.id,
        name: row.name,
        campuses: campuses
          .filter((c) => c.region_id === row.id)
          .map((c) => ({ id: c.id, name: c.name, regionId: c.region_id })),
      };
    });

    const managers: ScopeManager[] = ((managersRes.data ?? []) as RawManager[]).map((m) => {
      const scope = m.admin_scope === "owner" || m.admin_scope === "region" || m.admin_scope === "campus"
        ? m.admin_scope
        : null;
      return {
        userId: String(m.user_id ?? ""),
        email: String(m.email ?? ""),
        teacherName: String(m.teacher_name ?? ""),
        role: String(m.role ?? ""),
        scope,
        scopeId: m.scope_id ? String(m.scope_id) : null,
        scopeName: String(m.scope_name ?? ""),
        campusId: m.campus_id ? String(m.campus_id) : null,
        campusName: String(m.campus_name ?? ""),
        updatedAt: m.updated_at ? String(m.updated_at) : null,
      };
    });

    return { ok: true, regions, managers };
  } catch (e) {
    console.error("[admin-scopes] 读取异常:", String(e));
    return { ok: false, message: "读取大区/校区/管理者失败，请稍后重试。" };
  }
}
