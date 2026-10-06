import "server-only";

import { getViewer, type AppRole } from "@/lib/viewer";

/**
 * 应用层角色：数据库 user_role 枚举的超集，未建行的用户按 'user' 处理。
 * 类型与常量定义在 src/lib/viewer.ts，这里再导出，保持既有 import 路径可用。
 */
export type { AppRole } from "@/lib/viewer";
export { DEFAULT_ROLE } from "@/lib/viewer";

export function isAdminRole(role: AppRole | null | undefined): boolean {
  return role === "admin";
}

/**
 * 读取当前登录用户的角色（未登录返回 null）。
 * 实现已合并到 src/lib/viewer.ts 的 getViewer()，同一次渲染内与 getMembership()
 * 共用同一次 user_roles 查询。
 */
export async function getCurrentUserRole(): Promise<AppRole | null> {
  const viewer = await getViewer();
  return viewer.user ? viewer.roleResolved : null;
}

/**
 * 一次性拿到当前用户与其角色。
 *
 * 返回结构保持不变（`{ user, role }`，未登录时两者皆为 null）——
 * 调用点很多，改动返回结构会牵连一大片。
 * `role` 仍是「已解析」的值：未建行的用户为 'user'，未登录才是 null。
 */
export async function getCurrentUserWithRole() {
  const viewer = await getViewer();
  return { user: viewer.user, role: viewer.role };
}

/**
 * 校验调用者身份（Server Action / Route Handler 的权威校验）。
 * 前端隐藏 UI 不构成安全边界，所有管理操作都必须先过这里。
 */
export async function requireAdmin() {
  const viewer = await getViewer();

  if (!viewer.user) {
    return { ok: false as const, reason: "unauthenticated" as const };
  }
  if (!isAdminRole(viewer.role)) {
    return { ok: false as const, reason: "forbidden" as const };
  }

  return { ok: true as const, user: viewer.user, role: viewer.role as AppRole };
}

export { getViewer };
