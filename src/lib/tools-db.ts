import "server-only";

import { existsSync } from "node:fs";
import path from "node:path";
import type { ToolIcon } from "@/lib/tool-icon-names";
import { createClient } from "@/lib/supabase/server";
import type { Membership, PlanId } from "@/lib/membership-types";

/** tools 表的一行 */
export type DbTool = {
  id: string | number;
  name: string;
  description: string | null;
  route: string;
  min_plan: PlanId;
  active: boolean;
  sort_order: number | null;
};

/** 供 UI 使用的工具视图（附加派生字段） */
export type ToolView = DbTool & {
  /** 从路由推导的 slug，用于 /tools/[slug] 链接 */
  slug: string;
  /** 是否需要会员 */
  vipOnly: boolean;
  /** 当前用户是否可以进入 */
  unlocked: boolean;
  /** 是否锁住（需要会员但当前不是会员） */
  locked: boolean;
  /** 图标：tools 表无此字段，按名称/路由推导 */
  icon: ToolIcon;
  /** 点击后应跳转的地址：锁住时指向 /upgrade */
  href: string;
};

const ICON_RULES: Array<{ pattern: RegExp; icon: ToolIcon }> = [
  { pattern: /json|格式/i, icon: "brackets" },
  { pattern: /密码|password/i, icon: "key" },
  { pattern: /权限|角色|role|admin/i, icon: "shield" },
  { pattern: /时间|日期|timestamp|date/i, icon: "clock" },
  { pattern: /正则|regex/i, icon: "regex" },
  { pattern: /哈希|加密|hash/i, icon: "hash" },
  { pattern: /数学|公式|方案|计算|math/i, icon: "calculator" },
];

function pickIcon(tool: DbTool): ToolIcon {
  const haystack = `${tool.name} ${tool.description ?? ""} ${tool.route}`;
  for (const rule of ICON_RULES) {
    if (rule.pattern.test(haystack)) return rule.icon;
  }
  return "shield";
}

/** 从路由推导 slug：/tools/math-plan -> math-plan */
export function slugFromRoute(route: string): string {
  const trimmed = route.replace(/\/+$/, "");
  const last = trimmed.split("/").filter(Boolean).pop();
  return last ?? "";
}

/**
 * 判断某个工具对应的入口 HTML 是否存在，返回可供 iframe 使用的 URL。
 *
 * 支持两种布局：
 *   ① 单文件工具： public/tools/<slug>.html
 *   ② 多文件工具： public/tools/<slug>/index.html（css/、js/、templates/ 等同级目录）
 *
 * 后者用于「试卷分析工作台」这类由多个文件组成的工具。两种都不存在时返回 null，
 * 由调用方回退到占位页面。
 */
export function resolveIframeSrc(slug: string): string | null {
  // 允许 slug 里带 /，以支持 public/tools/<a>/<b>/index.html 这种更深的多文件工具；
  // 仍严格限制字符集，避免路径穿越（.. 里含点，会被排除）
  if (!/^[a-z0-9][a-z0-9/-]*$/i.test(slug)) return null;

  const base = path.join(process.cwd(), "public", "tools");
  const single = path.join(base, `${slug}.html`);
  if (existsSync(single)) return `/tools/${slug}.html`;

  const multi = path.join(base, slug, "index.html");
  if (existsSync(multi)) return `/tools/${slug}/index.html`;

  return null;
}

/** 按路由读取单个工具（仅 active=true） */
export async function getToolByRoute(route: string): Promise<DbTool | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("tools")
    .select("id, name, description, route, min_plan, active, sort_order")
    .eq("route", route)
    .eq("active", true)
    .maybeSingle();

  if (error) {
    console.error("[tools] 按路由读取失败:", error.code, error.message);
    return null;
  }

  return (data as DbTool | null) ?? null;
}

/** 把数据库行转换为带权限判定的视图对象 */
export function toToolView(tool: DbTool, membership: Pick<Membership, "isVip">): ToolView {
  const slug = slugFromRoute(tool.route);
  const vipOnly = tool.min_plan === "vip";
  const unlocked = !vipOnly || membership.isVip;

  return {
    ...tool,
    slug,
    vipOnly,
    unlocked,
    locked: !unlocked,
    icon: pickIcon(tool),
    href: unlocked ? tool.route : `/upgrade?tool=${encodeURIComponent(slug)}`,
  };
}

/** 缓存有效期（毫秒）。tools 表是极少变动的共享目录，30 秒足够。 */
const TOOLS_TTL_MS = 30_000;

/**
 * 进程内 TTL 缓存。
 *
 * ⚠️ **不要改回 `unstable_cache`**（2026-10 实测踩过）：
 *    在 Next 16.3.8 下用它包 `getActiveTools` 之后，它**每次都返回空数组、也从不查库**，
 *    导致 /tools 与 /dashboard **静默地不显示任何工具**。
 *    实测 A/B（同一份代码，只差这一层）：
 *      · 原始代码：/tools 响应体 45,534 字节，含工具名，查库 1 次；
 *      · 加 unstable_cache：响应体 14,889 字节，**工具名全部消失**，查库 0 次。
 *    故改用下面这套显式缓存。
 *
 * 语义：命中且未过期 → 直接返回不查库；过期 → 重查并刷新；
 *      `revalidateTools()` → 立刻清掉本进程缓存（改完即见）。
 *
 * 局限：缓存**每个服务端实例各一份**。改完 tools 表后，本实例立即失效，
 *      其它已在运行的实例最多滞后 TTL（30 秒）。对「极少变的目录」可接受。
 */
type ToolsCacheEntry = { rows: DbTool[]; at: number };
let toolsCache: ToolsCacheEntry | null = null;
/** 并发去重：同时到达的多个请求只查一次库 */
let toolsInflight: Promise<DbTool[]> | null = null;

/**
 * 读取所有启用中的工具，按 sort_order 升序（带 30 秒进程内缓存）。
 *
 * 缓存的目的：/dashboard、/tools、/upgrade 每次渲染都要这份**全用户共享**的目录，
 * 不缓存就是每次白跑一次外网往返。
 */
export async function getActiveTools(): Promise<DbTool[]> {
  const now = Date.now();
  if (toolsCache && now - toolsCache.at < TOOLS_TTL_MS) {
    return toolsCache.rows;
  }

  // 并发去重：同一瞬间多个请求共用一个 in-flight promise
  if (toolsInflight) return toolsInflight;

  toolsInflight = loadActiveTools()
    .then((rows) => {
      toolsCache = { rows, at: Date.now() };
      return rows;
    })
    .finally(() => {
      toolsInflight = null;
    });

  return toolsInflight;
}

/**
 * 清掉工具目录缓存（改了 tools 表之后调用）—— 本实例立即生效。
 *
 * ⚠️ 两个实测结论（别想当然）：
 *   1. `revalidatePath("/tools")` **不能**清掉这个进程内缓存 ——
 *      实测调完 revalidatePath 之后紧接着请求，仍然查库 0 次、仍是旧值。
 *      所以「改了 tools 表 + 只调 revalidatePath」**不会**立即生效。
 *   2. 本函数只清**当前实例**的缓存。生产是多实例，其它实例最多滞后 TTL（30 秒）。
 *
 * 因此：管理员在 Supabase SQL Editor 里直接改 tools 表 →
 *      **最多 30 秒后全站生效**（无需手动操作）。
 *      若以后要在管理后台加「改工具权限」按钮，那个 Server Action 里请调本函数，
 *      可获得「本实例改完即见」。
 */
export function revalidateTools() {
  toolsCache = null;
  toolsInflight = null;
}

/**
 * 实际查库（不含缓存）。抽出来是为了让缓存层只管缓存，
 * 也让「缓存坏掉」时容易定位。
 */
async function loadActiveTools(): Promise<DbTool[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("tools")
    .select("id, name, description, route, min_plan, active, sort_order")
    .eq("active", true)
    .order("sort_order", { ascending: true });

  if (error) {
    console.error("[tools] 读取 tools 表失败:", error.code, error.message);
    return [];
  }

  return (data ?? []) as DbTool[];
}

/** 一次拿到「已按权限处理」的工具列表 */
export async function getToolViewsForMembership(
  membership: Pick<Membership, "isVip">,
): Promise<ToolView[]> {
  const tools = await getActiveTools();
  return tools.map((tool) => toToolView(tool, membership));
}
