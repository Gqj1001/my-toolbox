import "server-only";

import { createClient } from "@/lib/supabase/server";
import { cached, clearCache, createTtlCache } from "@/lib/ttl-cache";
import { PROFILE_MIGRATION, type UserProfile } from "@/lib/user-profile";

/**
 * `user_profiles` 的读写（服务端）。
 *
 * ⚠️ 两条硬规矩（都来自本项目踩过的坑）：
 *   1. **读不到就返回 null，绝不抛错**：表没建（迁移 `0021` 还没跑）或 DB 抖动时，
 *      工具与页面必须照常可用（落款与导出走默认值）—— 一个资料表不该把整站拖垮。
 *   2. **写失败要说清楚**：明确告诉用户"要跑哪个迁移"，不要报成"保存失败"。
 */

const COLUMNS = "teacher_name, subject, campus, sig_teacher";

/**
 * 进程内缓存（25 秒，与档案/历史同一套做法、同一量级）。
 *
 * ⚠️ **必须有**：`/api/feedback/data` 是热路径，`tests/feedback-data-cache.test.mjs` 有条硬断言
 *    「**热请求只剩 ≤1 次出网**」。我给那个接口加资料段之后，热请求多了一次 `user_profiles` 查询
 *    ⇒ 那条断言立刻变红（实测）。这不是"放松断言"的事 —— 该让资料读也走缓存。
 * ⚠️ 保存后**立刻清缓存**（与"写完就清档案缓存"同一道理），否则刚改完的资料 25 秒内看不到。
 * 按用户限量 2000 条，防止内存无限涨。
 */
const profileCache = createTtlCache(25_000, 2000);

/** 判断"表不存在"：PostgREST 未命中 schema cache 时返回 `PGRST205`（实测踩过），SQL 层是 `42P01` */
function isMissingTable(error: { code?: string | null; message?: string | null } | null): boolean {
  const code = String(error?.code ?? "");
  if (code === "42P01" || code === "PGRST205") return true;
  return /relation .*user_profiles.* does not exist|Could not find the table/i.test(String(error?.message ?? ""));
}

type Row = { teacher_name: string | null; subject: string | null; campus: string | null; sig_teacher: string | null };

function shape(row: Row | null): UserProfile | null {
  if (!row) return null;
  return {
    teacherName: String(row.teacher_name ?? ""),
    subject: String(row.subject ?? ""),
    campus: String(row.campus ?? ""),
    sigTeacher: String(row.sig_teacher ?? ""),
  };
}

/**
 * 读某个账号的资料。
 * @returns 资料（可能全是空串）；**没填过或表没建 → null**
 */
export async function getUserProfile(userId: string): Promise<UserProfile | null> {
  if (!userId) return null;
  // 走缓存：热路径（/api/feedback/data）每次请求都读资料，不缓存会让「热请求 ≤1 次出网」退化
  return cached(profileCache, userId, () => readProfile(userId));
}

/** 真正查库的那一层（缓存 miss 时才走） */
async function readProfile(userId: string): Promise<UserProfile | null> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("user_profiles")
      .select(COLUMNS)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) {
      if (isMissingTable(error)) return null;                    // 迁移没跑 ⇒ 走兜底
      console.error("[user-profile] 读取失败:", error.message);
      return null;                                               // 读失败也走兜底，不拦页面
    }
    return shape(data as Row | null);
  } catch (e) {
    console.error("[user-profile] 读取异常:", String(e));
    return null;
  }
}

/** 批量读资料（后台用户列表用；查不到的行就不出现在结果里）
 *
 *  ⚠️ **必须走 `admin_list_profiles()`**，不能直接 `.from("user_profiles")`：
 *     0021 的 RLS 只允许本人读，管理员会话直接查全表**只能读到管理员自己**，
 *     别人的资料会被静默过滤掉 ⇒ 后台一直显示「资料未填」。
 *     函数是 SECURITY DEFINER，内部用 `public.is_admin()` 校验，只返回后台需要的四列。
 *
 *  迁移 `0026` 还没跑时（函数不存在）退回旧的直接查询：至少管理员自己的资料能显示，
 *  页面不会崩；跑完迁移后自动恢复全员显示。
 */
export async function getProfiles(userIds: string[]): Promise<Record<string, UserProfile>> {
  const ids = userIds.filter(Boolean);
  if (!ids.length) return {};
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("admin_list_profiles");
    if (!error) {
      const out: Record<string, UserProfile> = {};
      for (const r of (data ?? []) as (Row & { user_id: string })[]) {
        const p = shape(r);
        if (p) out[r.user_id] = p;
      }
      return out;
    }

    const missingFn =
      error.code === "PGRST202" ||
      /Could not find the function|function .*admin_list_profiles.* does not exist/i.test(error.message ?? "");
    if (!missingFn) {
      console.error("[user-profile] 批量读取失败:", error.message);
      return {};
    }

    // 兜底：迁移 0026 还没跑。直接查只会拿到管理员自己（RLS），但不会让页面报错。
    console.warn(
      "[user-profile] admin_list_profiles() 不存在，后台只能显示自己的资料；请执行 supabase/migrations/0026_admin_list_profiles.sql",
    );
    const { data: rows, error: fallbackError } = await supabase
      .from("user_profiles")
      .select(`user_id, ${COLUMNS}`)
      .in("user_id", ids);
    if (fallbackError) {
      if (!isMissingTable(fallbackError)) console.error("[user-profile] 批量读取失败:", fallbackError.message);
      return {};
    }
    const out: Record<string, UserProfile> = {};
    for (const r of (rows ?? []) as (Row & { user_id: string })[]) {
      const p = shape(r);
      if (p) out[r.user_id] = p;
    }
    return out;
  } catch (e) {
    console.error("[user-profile] 批量读取异常:", String(e));
    return {};
  }
}

export type SaveResult = { ok: true } | { ok: false; error: string; needMigration?: boolean };

/** 写（或新建）某个账号的资料 */
export async function saveUserProfile(userId: string, p: UserProfile): Promise<SaveResult> {
  try {
    const supabase = await createClient();
    const { error } = await supabase.from("user_profiles").upsert(
      {
        user_id: userId,
        teacher_name: p.teacherName,
        subject: p.subject,
        campus: p.campus,
        sig_teacher: p.sigTeacher,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (error) {
      if (isMissingTable(error)) {
        return { ok: false, needMigration: true, error: `资料表还没建：请在 Supabase SQL Editor 执行 ${PROFILE_MIGRATION}（重复执行也安全）。` };
      }
      console.error("[user-profile] 保存失败:", error.message);
      return { ok: false, error: "保存失败，请稍后重试。" };
    }
    // ⚠️ 写完**立刻清缓存**：否则老师刚改完资料，25 秒内页面/工具还是旧值（用户能感知）
    invalidateProfiles();
    return { ok: true };
  } catch (e) {
    console.error("[user-profile] 保存异常:", String(e));
    return { ok: false, error: "保存失败，请稍后重试。" };
  }
}

/** 保存成功后清掉缓存，避免"刚改完 25 秒内看不到" */
export function invalidateProfiles() {
  clearCache(profileCache);
}
