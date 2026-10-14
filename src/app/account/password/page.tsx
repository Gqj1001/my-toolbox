import Link from "next/link";
import ChangePasswordForm from "@/components/change-password-form";
import SiteHeader from "@/components/site-header";
import { getViewer } from "@/lib/viewer";

/**
 * 「账号安全 / 修改密码」（登录后可见）。
 *
 * 为什么单独一页而不是塞进个人中心：个人中心（`/tools`）已经承载"我是谁 + 工具目录"，
 * 再塞表单会让那一页变长、也容易在改动里被碰坏；这一页只干一件事，出错面最小。
 * 入口放两处：个人中心的会员卡旁边 + 登录页下方（"忘记密码"）。
 *
 * ⚠️ 这里**不重新查库**，直接用 `getViewer()`（服务端的唯一来源，带 30 秒缓存）。
 */
export default async function AccountPasswordPage() {
  const viewer = await getViewer();

  return (
    <>
      <SiteHeader role={viewer.role ?? "user"} current="" />

      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 overflow-y-auto px-6 py-12">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            修改密码
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            当前账号：{viewer.user?.email ?? "（未取到邮箱）"}
            <br />
            为了安全，改密码前要先填一次当前密码。
          </p>
        </div>

        <section className="rounded-xl border border-zinc-200 bg-white px-5 py-5 dark:border-zinc-800 dark:bg-zinc-900/40">
          <ChangePasswordForm />
        </section>

        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          <Link href="/tools" className="font-medium text-zinc-900 underline dark:text-zinc-100">
            ← 返回个人中心
          </Link>
        </p>
      </main>
    </>
  );
}
