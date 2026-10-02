import ToolPageShell from "@/components/tool-page-shell";

export const metadata = {
  title: "高中数学辅导方案生成器 | My Toolbox",
};

/** 显式路由：优先于 /tools/[slug] 动态路由，业务逻辑复用同一个外壳 */
export default function MathPlanPage() {
  return <ToolPageShell route="/tools/math-plan" />;
}
