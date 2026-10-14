/**
 * 密码规则的**唯一来源**（纯函数：不碰网络、不认 React）
 *
 * 为什么单独成文件：这条规则会被**三个地方**用到 ——
 *   · 「修改密码」页（客户端先挡一道，给即时提示）
 *   · 「设置新密码」页（重置流程）
 *   · 服务端动作 `src/app/auth/password-actions.ts`（**真正的把关处**）
 * 各写一遍就是本项目反复踩过的"同一件事两个来源"，迟早一边松一边紧。
 *
 * ⚠️ 客户端那道只是**体验**，不是安全边界：真正说了算的是 Supabase Auth 服务端
 *    （它还会拒"太短 / 太弱 / 已泄露"的密码，报错由 `translateAuthError` 翻成中文）。
 *    这里的规则**故意与注册页保持一致**（注册页用 `minLength={6}` + Supabase 默认策略）。
 */

/** 与注册页保持一致的下限（Supabase 默认策略就是 6） */
export const MIN_PASSWORD_LENGTH = 6;

/** 上限只为挡住"整段粘贴"的意外（Supabase 自身上限是 72 字节） */
export const MAX_PASSWORD_LENGTH = 72;

export type PasswordCheckInput = {
  password?: unknown;
  confirm?: unknown;
  /** 当前密码（修改密码流程才有；重置流程没有） */
  oldPassword?: unknown;
};

export type PasswordCheckResult = { ok: true } | { ok: false; error: string };

export function checkNewPassword(input: PasswordCheckInput): PasswordCheckResult {
  const password = String(input.password ?? "");
  const confirm = String(input.confirm ?? "");
  const oldPassword = String(input.oldPassword ?? "");

  if (!password || !confirm) return { ok: false, error: "请把两个密码框都填上。" };
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `密码至少需要 ${MIN_PASSWORD_LENGTH} 个字符。` };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, error: `密码太长（最多 ${MAX_PASSWORD_LENGTH} 个字符）。` };
  }
  if (password !== confirm) {
    return { ok: false, error: "两次输入的密码不一样，请重新输入。" };
  }
  // ⚠️ 只在"确实填了当前密码"时才比：重置流程不需要旧密码，
  //    传空串进来不该被误判成"新密码和旧密码相同"。
  if (oldPassword && password === oldPassword) {
    return { ok: false, error: "新密码不能和当前密码一样。" };
  }
  return { ok: true };
}
