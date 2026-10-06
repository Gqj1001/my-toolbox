import "server-only";

import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { cached, clearCache, createTtlCache } from "@/lib/ttl-cache";
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
 * `user_roles` 那一行的**进程内**缓存（30 秒）。
 *
 * 为什么能缓存：会员等级 / 状态 / 到期时间**只有管理员会改**（`/admin` 的开通、取消、封禁），
 *   而这些动作都在 `src/app/admin/membership-actions.ts` 里，改完会调
 *   `invalidateUserRoles()` —— 所以是「改完即生效」，TTL 只是兜底
 *   （比如管理员直接在 Supabase SQL Editor 里改，那条路径绕不过去，最多 30 秒后生效）。
 *
 * 收益：每一次页面请求本来要查 **2 次** `user_roles`（中间件 1 次 + 这里 1 次），
 *   现在这里那次在 30 秒内不再出网。实测每次请求的出网次数因此少了 1 次。
 *
 * ⚠️ 安全取舍（用户已确认）：**封禁也是 30 秒内生效**，不是立即。
 *    也就是说被封的人在最坏情况下还能再访问 30 秒（若是通过 SQL 直接改库；走 /admin 是立即的）。
 *    这个取舍是明确接受的 —— 换掉的是一次外网往返。
 *
 * ⚠️ 中间件（`src/proxy.ts`）**不在 React 渲染树里**，用不到这份缓存（它自己查一次），
 *    所以这里省下的只是页面侧那一次。
 */
const USER_ROLES_TTL_MS = 30_000;
/** 按 user_id 缓存，限量防止内存无限涨（会员表一般不大） */
const userRolesCache = createTtlCache(USER_ROLES_TTL_MS, 500);

type UserRoleRow = {
  role: string | null;
  plan: string | null;
  status: string | null;
  expires_at: string | null;
};

/** 清掉 `user_roles` 缓存（改过会员/角色/封禁之后调用；本进程立即生效）
 *
 *  调用点：`src/app/admin/membership-actions.ts` 的 `revalidateAll()` ——
 *  开通会员 / 取消会员 / 封禁 / 解封 都会经过它。
 *
 *  ⚠️ 粒度是**整个 Map**（不是只清某个用户）：进程级缓存分不清是谁改的，
 *     别人会跟着多查一次库。方向安全（宁可多查、不会变旧），且后台写操作很少，可接受。
 *  ⚠️ `revalidatePath()` **清不掉**这个进程内缓存（实测过），必须显式调本函数。 */
export function invalidateUserRoles() {
  clearCache(userRolesCache);
}

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
 *   · `auth.getUser()` **每次都真的走网络**（校验会话，不能缓存 —— 这是安全底线）。
 *     但 `user_roles` 那一次现在走 30 秒进程内缓存（见上面 USER_ROLES_TTL_MS），
 *     改会员/封禁时由 `invalidateUserRoles()` 主动清掉。
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

  // 读不到行（含查询出错）时按「普通用户 + 免费」处理，与改动前行为一致。
  // ⚠️ 注意 `null` 也是**会被缓存**的（它就是「没有这行」的正常结果）：
  //    · 从未建过行的用户 → 缓存「免费」，正确；
  //    · 查询**出错**时拿到的也是 null，于是「免费」会被缓存 30 秒 ——
  //      对一个本来就按免费处理的人来说没有更坏，且有 TTL 兜底。
  //      （真正危险的是反过来：把「查到了 VIP」缓存成「没查到」，那不会发生。）
  const data = await cached(userRolesCache, user.id, async () => {
    const { data: row } = await supabase
      .from("user_roles")
      .select("role, plan, status, expires_at")
      .eq("user_id", user.id)
      .maybeSingle();
    return (row as UserRoleRow | null) ?? null;
  });

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
