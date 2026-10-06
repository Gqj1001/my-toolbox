import "server-only";

import { getViewer, type Viewer } from "@/lib/viewer";
import { type Membership } from "@/lib/membership-types";

export type { Membership, PlanId, AccountStatus } from "@/lib/membership-types";
export { computeIsVip, remainingDays, PLAN_LABELS, STATUS_LABELS } from "@/lib/membership-types";

/**
 * 读取当前登录用户的会员状态。
 *
 * 数据来源：user_roles 表的 plan / expires_at / status
 * 实现已合并到 src/lib/viewer.ts 的 getViewer()：一次 getUser + 一次 user_roles 查询，
 * 并在**同一次渲染内**去重（SiteHeader 与页面各调一次时只查一次库）。
 *
 * isVip 判定：plan='vip' 且 status='active' 且 expires_at 未过期。
 * 未建行的用户一律按免费用户处理。
 */
export async function getMembership(): Promise<Membership> {
  const viewer = await getViewer();
  return viewer.membership;
}

/** 当前用户是否被封禁（供 proxy 与页面守卫使用） */
export async function isCurrentUserBanned(): Promise<boolean> {
  const viewer = await getViewer();
  return viewer.membership.status === "banned";
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

export { getViewer };
export type { Viewer };
