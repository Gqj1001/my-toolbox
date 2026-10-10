import { redirect } from "next/navigation";

/**
 * 主页面统一入口：跳转到工具列表（= 个人中心）。
 * 未登录用户会先被 src/proxy.ts 拦截到 /login。
 *
 * ⚠️ 2026-10 起这里指向 `/tools`（原来是 `/dashboard`）：
 * 百宝箱要改成「学员档案」页，首页/登录后落点应当是**工具列表**，
 * 少一跳（原来 `/` → `/dashboard` → 用户再点工具）。
 */
export default function Home() {
  redirect("/tools");
}
