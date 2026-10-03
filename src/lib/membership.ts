import "server-only";

import { createClient } from "@/lib/supabase/server";
import {
  computeIsVip,
  type AccountStatus,
  type Membership,
  type PlanId,
} from "@/lib/membership-types";

export type { Membership, PlanId, AccountStatus } from "@/lib/membership-types";
export { computeIsVip, remainingDays, PLAN_LABELS, STATUS_LABELS } from "@/lib/membership-types";

const EMPTY: Omit<Membership, "user"> = {
  plan: "free",
  isVip: false,
  status: "active",
  expiresAt: null,
};

/**
 * 读取当前登录用户的会员状态。
 *
 * 数据来源：user_roles 表的 plan / expires_at / status
 * （受 RLS "users read own role" 策略保护，只能读到自己那一行）。
 *
 * isVip 判定：plan='vip' 且 status='active' 且 expires_at 未过期。
 * 未建行的用户一律按免费用户处理。
 */
export async function getMembership(): Promise<Membership> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { user: null, ...EMPTY };
  }

  const { data } = await supabase
    .from("user_roles")
    .select("plan, expires_at, status")
    .eq("user_id", user.id)
    .maybeSingle();

  const plan: PlanId = data?.plan === "vip" ? "vip" : "free";
  const status: AccountStatus = data?.status === "banned" ? "banned" : "active";
  const expiresAt = data?.expires_at ?? null;

  return {
    user: { id: user.id, email: user.email ?? null },
    plan,
    isVip: computeIsVip(plan, status, expiresAt),
    status,
    expiresAt,
  };
}

/** 当前用户是否被封禁（供 proxy 与页面守卫使用） */
export async function isCurrentUserBanned(): Promise<boolean> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return false;

  const { data } = await supabase
    .from("user_roles")
    .select("status")
    .eq("user_id", user.id)
    .maybeSingle();

  return data?.status === "banned";
}

/**
 * 校验调用者是否为有效会员（Server Action / API Route 的权威校验）。
 * 与 requireAdmin 一样，前端判断不构成安全边界。
 */
export async function requireVip() {
  const membership = await getMembership();

  if (!membership.user) {
    return { ok: false as const, reason: "unauthenticated" as const };
  }
  if (membership.status === "banned") {
    return { ok: false as const, reason: "banned" as const };
  }
  if (!membership.isVip) {
    return { ok: false as const, reason: "not_vip" as const };
  }

  return { ok: true as const, membership };
}
