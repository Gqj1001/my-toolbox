/**
 * 图标标识与静态路由权限的共享类型。
 *
 * 说明：工具清单的**唯一数据源**已迁移到数据库 tools 表
 * （见 src/lib/tools-db.ts）。本文件只保留类型定义，
 * 避免数据库与代码各自维护一份清单导致不一致。
 */

/** 工具图标标识，对应 components/tool-icon.tsx 中的实现 */
export type ToolIcon =
  | "brackets"
  | "key"
  | "shield"
  | "clock"
  | "regex"
  | "hash"
  | "calculator"
  | "lock";
