import "server-only";

import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import {
  computeIsVip,
  type AccountStatus,
  type Membership,
  type PlanId,
} from "@/lib/membership-types";

/** 应用层角色：数据库 user_role 枚举的超集，未建行的用户按 'user' 处理 */
export type AppRole = "admin" | "user";

export const DEFAULT_ROLE: AppRole = "user";

export type Viewer = {
  user: { id: string; email: string | null } | null;
  role: AppRole | null;
  membership: Membership;
  roleResolved: AppRole;
};

/** 未登录 / 读不到时的兜底会员状态（与历史行为一致：无行 = 免费用户） */
const EMPTY_MEMBERSHIP: Omit<Membership, "user"> = {
  plan: "free",
  isVip: false,
  status: "active",
  expiresAt: null,
};

/**
 * 一次拿到「当前用户 + 角色 + 会员」。
 *
 * 为什么要有这个函数：
 *   原先 getMembership() 与 getCurrentUserWithRole() 各自查一次 auth.getUser()，
 *   再各自查一次 user_roles —— 同一个请求里白跑 4 次网络往返（其中 user_roles 查的
 *   字段完全不重叠：plan/status/expires_at 与 role）。
 *   这里合并成「一次 getUser + 一次 select(...)」，字段一次取全。
 *
 * 性能约束（改动前请先读）：
 *   · 必须在**同一次渲染**里调用，React 的 cache() 才有去重效果。
 *   · Server Action / Route Handler 与 RSC 渲染是各自独立的请求作用域，跨不过去；
 *     中间件（src/proxy.ts）也不在 React 渲染树里 —— 它的查询省不掉。
 *   · 这里**只做请求内去重**，不做跨请求缓存：plan/status/expires_at 改完必须立刻生效。
 */
async function loadViewer(): Promise<Viewer> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return {
      user: null,
      role: null,
      roleResolved: DEFAULT_ROLE,
      membership: { user: null, ...EMPTY_MEMBERSHIP },
    };
  }

  // 读不到行（含查询出错）时按「普通用户 + 免费」处理，与改动前行为一致
  const { data } = await supabase
    .from("user_roles")
    .select("role, plan, status, expires_at")
    .eq("user_id", user.id)
    .maybeSingle();

  const roleResolved: AppRole = data?.role === "admin" ? "admin" : DEFAULT_ROLE;
  const plan: PlanId = data?.plan === "vip" ? "vip" : "free";
  const status: AccountStatus = data?.status === "banned" ? "banned" : "active";
  const expiresAt = data?.expires_at ?? null;

  const viewerUser = { id: user.id, email: user.email ?? null };

  return {
    user: viewerUser,
    role: roleResolved,
    roleResolved,
    membership: {
      user: viewerUser,
      plan,
      isVip: computeIsVip(plan, status, expiresAt),
      status,
      expiresAt,
    },
  };
}

/** 当前请求内的访问者信息（同一次渲染里多次调用只查一次库） */
export const getViewer = cache(loadViewer);
