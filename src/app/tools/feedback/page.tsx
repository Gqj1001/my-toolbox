import ToolPageShell from "@/components/tool-page-shell";

export const metadata = {
  title: "课后反馈工作台 | My Toolbox",
};

/**
 * 课后反馈工作台。
 *
 * 工具本体是 public/tools/feedback.html（单文件 HTML），用 iframe 承载。
 * 该工具在数据库 tools 表中的 min_plan = 'vip'，因此：
 *   - 未登录 → /login
 *   - 被封禁 → /banned
 *   - 非会员 → /upgrade?tool=feedback
 * 这些判定统一由 ToolPageShell 处理。
 *
 * HTML 内部会探测自身路径（/tools/feedback）并进入「云端模式」：
 * 关键词库读 Supabase（全局共享）、档案与历史按账号隔离、
 * AI 润色走 /api/feedback/ai 服务端代理（同样校验 VIP）。
 */
export default function FeedbackPage() {
  return <ToolPageShell route="/tools/feedback" />;
}
