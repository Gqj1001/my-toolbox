import type { AppRole } from "@/lib/auth-role";

/** 工具图标标识，对应 components/tool-icon.tsx 中的实现 */
export type ToolIcon =
  | "brackets"
  | "key"
  | "shield"
  | "clock"
  | "regex"
  | "hash"
  | "calculator";

export type ToolAccess = "all" | "admin";

export type Tool = {
  slug: string;
  name: string;
  description: string;
  icon: ToolIcon;
  href: string;
  /** all = 所有登录用户可见；admin = 仅管理员可见 */
  access: ToolAccess;
};

/**
 * 工具目录（单一数据源）。
 *
 * 权限模型：目前按角色控制可见性（access 字段）。
 * 后续若需要「按用户逐个授权」，可在此基础上加一张授权表，
 * 把 access 换成 userId 列表，ToolGrid 与 dashboard 无需改动。
 */
export const TOOLS: Tool[] = [
  {
    slug: "json-formatter",
    name: "JSON 格式化",
    description: "校验并美化 JSON 文本",
    icon: "brackets",
    href: "/tools/json-formatter",
    access: "all",
  },
  {
    slug: "password-generator",
    name: "密码生成器",
    description: "生成高强度随机密码",
    icon: "key",
    href: "/tools/password-generator",
    access: "all",
  },
  {
    slug: "permission-console",
    name: "权限控制台",
    description: "查看角色策略与自己的权限边界（管理员专属）",
    icon: "shield",
    href: "/tools/permission-console",
    access: "admin",
  },
  {
    // 单文件 HTML 工具：内容放在 public/tools/math-plan.html，由 /tools/math-plan 用 iframe 承载
    slug: "math-plan",
    name: "高中数学辅导方案生成器",
    description: "根据学情参数自动生成高中数学辅导方案",
    icon: "calculator",
    href: "/tools/math-plan",
    access: "all",
  },
];

/** 按角色筛选可见工具 */
export function getToolsForRole(role: AppRole | null | undefined): Tool[] {
  const isAdmin = role === "admin";
  return TOOLS.filter((tool) => tool.access === "all" || isAdmin);
}

export function getToolBySlug(slug: string): Tool | undefined {
  return TOOLS.find((tool) => tool.slug === slug);
}

/**
 * 判断某角色能否访问指定路径（用于工具详情页的服务端校验）。
 * 返回 false 时应展示无权访问提示或重定向。
 */
export function canAccessHref(role: AppRole | null | undefined, href: string): boolean {
  const tool = TOOLS.find((item) => item.href === href);
  if (!tool) return true; // 不在目录中的路径交由其他守卫处理
  return tool.access === "all" || role === "admin";
}
