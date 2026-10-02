import { logOut } from "@/app/auth/actions";

export default function SignOutButton() {
  return (
    <form action={logOut}>
      <button
        type="submit"
        className="inline-flex h-9 items-center justify-center rounded-lg border border-zinc-300 px-3 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
      >
        退出登录
      </button>
    </form>
  );
}
