"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { setUserRole, type RoleActionState } from "@/app/admin/actions";

const initialState: RoleActionState = { status: "idle" };

type RoleSelectProps = {
  userId: string;
  email: string | null;
  currentRole: "admin" | "user";
  isSelf: boolean;
};

export default function RoleSelect({ userId, email, currentRole, isSelf }: RoleSelectProps) {
  const [state, formAction, isPending] = useActionState(setUserRole, initialState);
  const [selected, setSelected] = useState(currentRole);
  const [savedRole, setSavedRole] = useState(currentRole);
  const [showHint, setShowHint] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  // 服务端返回结果后收起提示；失败则回滚下拉框显示
  useEffect(() => {
    if (state.status === "idle") return;

    if (state.status === "error") {
      setSelected(savedRole);
    } else {
      setSavedRole(selected);
    }

    const timer = setTimeout(() => setShowHint(false), 4000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const handleChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const nextRole = event.target.value as "admin" | "user";
    if (nextRole === currentRole) return;

    // 自我降级需要二次确认
    if (isSelf && nextRole === "user") {
      const confirmed = window.confirm(
        "确定要把自己降级为普通用户吗？你将立即失去管理后台的访问权限。",
      );
      if (!confirmed) {
        event.target.value = currentRole;
        return;
      }
    }

    setSelected(nextRole);
    setShowHint(true);
    formRef.current?.requestSubmit();
  };

  return (
    <form ref={formRef} action={formAction} className="flex flex-col gap-1">
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="targetEmail" value={email ?? ""} />
      <input type="hidden" name="isSelf" value={isSelf ? "1" : "0"} />

      <select
        name="role"
        value={selected}
        onChange={handleChange}
        disabled={isPending}
        aria-label={`修改 ${email ?? userId} 的角色`}
        className="h-8 w-28 rounded-lg border border-zinc-300 bg-white px-2 text-sm text-zinc-900 outline-none transition focus:border-zinc-900 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-100"
      >
        <option value="user">user</option>
        <option value="admin">admin</option>
      </select>

      {isPending ? (
        <span className="text-xs text-zinc-400 dark:text-zinc-500">保存中…</span>
      ) : showHint && state.message ? (
        <span
          role={state.status === "error" ? "alert" : "status"}
          className={
            state.status === "error"
              ? "text-xs text-red-600 dark:text-red-400"
              : "text-xs text-emerald-600 dark:text-emerald-400"
          }
        >
          {state.message}
        </span>
      ) : null}
    </form>
  );
}
