/** 会员计划等级 */
export type PlanId = "free" | "vip";

/** 账号状态 */
export type AccountStatus = "active" | "banned";

/** user_roles 表中的会员相关字段 */
export type Membership = {
  user: { id: string; email: string | null } | null;
  plan: PlanId;
  isVip: boolean;
  status: AccountStatus;
  expiresAt: string | null;
};

export const PLAN_LABELS: Record<PlanId, string> = {
  free: "免费版",
  vip: "会员版",
};

export const STATUS_LABELS: Record<AccountStatus, string> = {
  active: "正常",
  banned: "已封禁",
};

/** 计算会员是否有效：plan=vip 且 status=active 且未过期 */
export function computeIsVip(
  plan: string | null | undefined,
  status: string | null | undefined,
  expiresAt: string | null | undefined,
): boolean {
  if (plan !== "vip") return false;
  if (status !== "active") return false;
  if (!expiresAt) return false;

  const expires = new Date(expiresAt).getTime();
  if (Number.isNaN(expires)) return false;

  return expires > Date.now();
}

/** 会员剩余天数（无效会员返回 null） */
export function remainingDays(expiresAt: string | null | undefined): number | null {
  if (!expiresAt) return null;
  const expires = new Date(expiresAt).getTime();
  if (Number.isNaN(expires)) return null;
  const diff = expires - Date.now();
  if (diff <= 0) return null;
  return Math.ceil(diff / 86_400_000);
}
