import { redirect } from "next/navigation";

/**
 * 主页面统一入口：跳转到百宝箱。
 * 未登录用户会先被 src/proxy.ts 拦截到 /login。
 */
export default function Home() {
  redirect("/dashboard");
}
