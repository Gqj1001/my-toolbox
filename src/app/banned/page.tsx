import SignOutButton from "@/components/sign-out-button";
import SiteHeader from "@/components/site-header";
import { getCurrentUserWithRole } from "@/lib/auth-role";

export const metadata = {
  title: "账号已被封禁 | My Toolbox",
};

export default async function BannedPage() {
  const { user, role } = await getCurrentUserWithRole();

  return (
    <>
      <SiteHeader email={user?.email ?? null} role={role ?? "user"} />

      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center gap-6 overflow-y-auto px-6 py-16 text-center">
        <span
          aria-hidden="true"
          className="flex h-14 w-14 items-center justify-center rounded-full bg-red-100 text-2xl text-red-600 dark:bg-red-950 dark:text-red-400"
        >
          !
        </span>

        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            账号已被封禁
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-300">
            你的账号已被管理员封禁，暂时无法使用任何工具。
          </p>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            如有疑问，请联系管理员处理。
          </p>
        </div>

        {user?.email ? (
          <p className="text-xs text-zinc-400 dark:text-zinc-500">当前账号：{user.email}</p>
        ) : null}

        <SignOutButton />
      </main>
    </>
  );
}
