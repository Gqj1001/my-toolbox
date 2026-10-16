import ToolPageShell from "@/components/tool-page-shell";

export const metadata = {
  title: "辅导方案生成器（全学科） | My Toolbox",
};

/**
 * 通用「辅导方案生成器」（全学科 × 初高中）。
 *
 * ⚠️ 与 `/tools/math-plan` 是**两个独立工具**：
 *    · 数学版是单文件 `public/tools/math-plan.html`（数学老师每天在用，**一个字没动**）
 *    · 本工具是多文件 `public/tools/plan-generator/index.html` + `js/` + `subjects/`
 *      —— 学科是一份**配置**（`subjects/*.js`），加化学/语文只是再加一个文件。
 *
 * `resolveIframeSrc()` 认 `public/tools/<slug>/index.html` 这种多文件布局，
 * 所以这里的 route 写 `/tools/plan-generator` 即可。
 */
export default function PlanGeneratorPage() {
  return <ToolPageShell route="/tools/plan-generator" />;
}
