import Link from "next/link";
import SignOutButton from "@/components/sign-out-button";

type SiteHeaderProps = {
  email: string | null;
  role: "admin" | "user";
  current?: string;
};

export default function SiteHeader({ email, role, current }: SiteHeaderProps) {
  const isAdmin = role === "admin";

  const linkClass = (href: string) =>
    `rounded-lg px-3 py-1.5 text-sm font-medium transition ${
      current === href
        ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
        : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
    }`;

  return (
    <header className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-3 px-6 py-3">
        <div className="flex items-center gap-1">
          <span className="mr-2 text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            My Toolbox
          </span>
          <Link href="/dashboard" className={linkClass("/dashboard")}>
            百宝箱
          </Link>
          <Link href="/tools" className={linkClass("/tools")}>
            工具列表
          </Link>
          {isAdmin ? (
            <Link href="/admin" className={linkClass("/admin")}>
              管理后台
            </Link>
          ) : null}
        </div>

        <div className="flex items-center gap-3">
          <span className="hidden text-sm text-zinc-500 sm:inline dark:text-zinc-400">
            {email}
          </span>
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              isAdmin
                ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
            }`}
          >
            {role}
          </span>
          <SignOutButton />
        </div>
      </div>
    </header>
  );
}
