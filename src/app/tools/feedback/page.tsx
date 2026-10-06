import ToolPageShell from "@/components/tool-page-shell";
import FeedbackSkeleton from "@/components/feedback-skeleton";

export const metadata = {
  title: "课后反馈工作台 | My Toolbox",
};

/**
 * 课后反馈工作台。
 *
 * 工具本体是 public/tools/feedback.html（单文件 HTML），用 iframe 承载。
 * 该工具在数据库 tools 表中的 min_plan = 'free'（工具本身所有登录用户可开），
 * 但**页内的 AI 润色是会员专属**（见 /api/feedback/ai 的 requireVip）。访问控制中
 * 「未登录 / 被封禁 / 该工具是否 vip」统一由 ToolPageShell 处理，顺序不能改。
 *
 * HTML 内部会探测自身路径（/tools/feedback）并进入「云端模式」：
 * 关键词库读 Supabase（全局共享）、档案与历史按账号隔离、
 * AI 润色走 /api/feedback/ai 服务端代理（同样校验 VIP）。
 *
 * 加载反馈：这个工具打开后还会打好几次 API（detectServer → loadCloudScoped），
 * 所以这里传一个**纯静态骨架**给 ToolFrame —— iframe 加载期间先顶着它，
 * 加载完淡出。骨架与 `tools/feedback/loading.tsx` 共用同一个组件，保证风格一致。
 */
export default function FeedbackPage() {
  return <ToolPageShell route="/tools/feedback" skeleton={<FeedbackSkeleton />} />;
}
