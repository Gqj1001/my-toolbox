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

/** 读取所有启用中的工具，按 sort_order 升序 */
export async function getActiveTools(): Promise<DbTool[]> {
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

/** 一次拿到「已按权限处理」的工具列表 */
export async function getToolViewsForMembership(
  membership: Pick<Membership, "isVip">,
): Promise<ToolView[]> {
  const tools = await getActiveTools();
  return tools.map((tool) => toToolView(tool, membership));
}
