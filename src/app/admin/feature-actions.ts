"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-role";
import { createClient } from "@/lib/supabase/server";
import { FEATURE_FLAG_REGISTRY, invalidateFeatureFlags, isMissingTableError } from "@/lib/feature-flags";

/**
 * 功能开关：切换（管理后台）
 * ==========================================================================
 * 与会员操作同一套写法：**服务端** `requireAdmin()` 校验（前端藏按钮不算安全边界）。
 *
 * ⚠️ 两条护栏：
 *   1. **白名单**：只允许改 `FEATURE_FLAG_REGISTRY` 里登记过的 key ——
 *      否则谁都能往表里塞一行"开关"，后台会显示出一堆没人认识的条目；
 *   2. 改完 `invalidateFeatureFlags()`：本实例立刻生效（其它实例最多滞后 30 秒）。
 */

export type FlagActionResult = {
  status: "idle" | "success" | "error";
  message?: string;
};

export async function setFeatureFlag(
  _prev: FlagActionResult,
  formData: FormData,
): Promise<FlagActionResult> {
  const guard = await requireAdmin();
  if (!guard.ok) {
    return {
      status: "error",
      message:
        guard.reason === "unauthenticated" ? "请先登录。" : "只有管理员可以修改功能开关。",
    };
  }

  const key = String(formData.get("key") ?? "").trim();
  const spec = FEATURE_FLAG_REGISTRY.find((f) => f.key === key);
  if (!spec) {
    return {
      status: "error",
      message: `未登记的功能开关「${key || "(空)"}」：只允许改 src/lib/feature-flags.ts 里登记过的开关。`,
    };
  }

  // 表单带的是"**目标状态**"：enabled=1 表示要打开，0 表示要关掉
  const enabled = String(formData.get("enabled") ?? "") === "1";

  const supabase = await createClient();
  const { error } = await supabase.from("feature_flags").upsert(
    {
      key: spec.key,
      enabled,
      label: spec.label,
      note: spec.note,
      updated_at: new Date().toISOString(),
      updated_by: guard.user.email ?? null,
    },
    { onConflict: "key" },
  );

  if (error) {
    if (isMissingTableError(error)) {
      return {
        status: "error",
        message:
          "功能开关表还没建：请先执行 supabase/migrations/0018_feature_flags.sql（重复执行也安全）。",
      };
    }
    return { status: "error", message: `写入失败：${error.message}` };
  }

  invalidateFeatureFlags(); // 本实例立刻生效
  revalidatePath("/admin"); // 后台页面重新渲染（显示最新状态与"最后改动"）

  return {
    status: "success",
    message: enabled ? `已打开「${spec.label}」。` : `已关掉「${spec.label}」（最多 30 秒全站生效）。`,
  };
}
