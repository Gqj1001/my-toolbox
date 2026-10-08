"use client";

import { useActionState, useEffect, useState } from "react";
import {
  cancelVip,
  grantVip,
  toggleBan,
  type ActionResult,
} from "@/app/admin/membership-actions";

const initialState: ActionResult = { status: "idle" };

const buttonBase =
  "inline-flex h-7 items-center justify-center whitespace-nowrap rounded-md border px-2 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-60";

type MemberActionsProps = {
  userId: string;
  isVipActive: boolean;
  banned: boolean;
  isSelf: boolean;
};

export default function MemberActions({ userId, isVipActive, banned, isSelf }: MemberActionsProps) {
  // grantVip 本来就接受 days 字段（默认 30），所以「30 天 / 90 天」只是同一 action 的两次调用。
  // ⚠️ 必须各自用一份 useActionState（就是两个不同的 form action），
  //    否则同一个 action 的 pending 状态会互相串：
  //    点 90 天时 30 天按钮也会显示「处理中…」，而且结果提示分不清是哪次操作。
  const [grantState, grantAction, granting] = useActionState(grantVip, initialState);
  const [grant90State, grant90Action, granting90] = useActionState(grantVip, initialState);
  const [cancelState, cancelAction, cancelling] = useActionState(cancelVip, initialState);
  const [banState, banAction, banning] = useActionState(toggleBan, initialState);

  const [showResult, setShowResult] = useState(false);
  const pending = granting || granting90 || cancelling || banning;

  const result =
    [grantState, grant90State, cancelState, banState].find((s) => s.status !== "idle") ?? initialState;

  useEffect(() => {
    if (result.status === "idle") return;
    setShowResult(true);
    const timer = setTimeout(() => setShowResult(false), 5000);
    return () => clearTimeout(timer);
  }, [result]);

  const nextStatus = banned ? "active" : "banned";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <form action={grantAction}>
          <input type="hidden" name="userId" value={userId} />
          <input type="hidden" name="days" value="30" />
          <button
            type="submit"
            disabled={pending}
            className={`${buttonBase} border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950/40`}
          >
            {granting ? "处理中…" : isVipActive ? "续费 30 天" : "开通 30 天会员"}
          </button>
        </form>

        {/* 90 天按钮：样式与 30 天完全一致，只是 days 不同。
            存在的理由：老师偶尔忘记续费 → 一次开 90 天，少一次断档风险。 */}
        <form action={grant90Action}>
          <input type="hidden" name="userId" value={userId} />
          <input type="hidden" name="days" value="90" />
          <button
            type="submit"
            disabled={pending}
            className={`${buttonBase} border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950/40`}
          >
            {granting90 ? "处理中…" : isVipActive ? "续费 90 天" : "开通 90 天会员"}
          </button>
        </form>

        <form action={cancelAction}>
          <input type="hidden" name="userId" value={userId} />
          <button
            type="submit"
            disabled={pending || !isVipActive}
            className={`${buttonBase} border-zinc-300 text-zinc-600 hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800`}
          >
            {cancelling ? "处理中…" : "取消会员"}
          </button>
        </form>

        <form action={banAction}>
          <input type="hidden" name="userId" value={userId} />
          <input type="hidden" name="nextStatus" value={nextStatus} />
          <button
            type="submit"
            disabled={pending || (banned === false && isSelf)}
            title={banned === false && isSelf ? "不能封禁当前登录的管理员自己" : undefined}
            className={`${buttonBase} ${
              banned
                ? "border-sky-300 text-sky-700 hover:bg-sky-50 dark:border-sky-800 dark:text-sky-300 dark:hover:bg-sky-950/40"
                : "border-red-300 text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950/40"
            }`}
          >
            {banning ? "处理中…" : banned ? "解封" : "封禁"}
          </button>
        </form>
      </div>

      {showResult && result.message ? (
        <span
          role={result.status === "error" ? "alert" : "status"}
          className={`text-xs ${
            result.status === "error"
              ? "text-red-600 dark:text-red-400"
              : "text-emerald-600 dark:text-emerald-400"
          }`}
        >
          {result.message}
        </span>
      ) : null}
    </div>
  );
}
