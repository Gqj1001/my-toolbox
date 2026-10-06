/**
 * DeepSeek「思考模式」相关的公共处理。
 *
 * 背景（2026-10 实测定位）：
 *   `deepseek-flash` **默认开启思考模式**（官方文档：thinking mode is enabled by default,
 *   default effort = high）。思考内容会走 `reasoning_content` 返回，并且**和正文一起**
 *   消耗 `max_tokens`。线上真实失败样本：
 *
 *     finish_reason: "length", contentLen: 0, reasoningLen: 3414, inputChars: 275
 *
 *   也就是：输入才 275 字符，模型先想了 3414 字符的思考过程，把 `max_tokens=2000` 吃光，
 *   一个字都没留给正文 → `content` 为空 → 前端看到「AI 返回内容为空，请重试」。
 *   同一个原因也造成「AI 润色很慢」（思考过程比正文长 12 倍）。
 *
 * 官方参数（https://api-docs.deepseek.com/guides/thinking_mode/）：
 *   `{"thinking": {"type": "disabled"}}` —— **默认是 enabled**，所以必须显式关闭。
 *   ⚠️ 该文档还说明：思考模式下 `temperature` 是**无效**的（设了不报错但被忽略）。
 *      关掉思考后 `temperature` 才真正生效。
 *
 * ⚠️ 这些都是 **DeepSeek 专有字段**。换厂商（或换不认识的模型）时必须不要带，
 *    否则可能直接 400。所以对外提供的是 `thinkingDisabled()` 这类「按模型判断」的工具。
 */

/** 判断一个模型名是不是 DeepSeek（用于决定能不能带 DeepSeek 专有字段） */
export function isDeepSeekModel(model: string): boolean {
  return /deepseek/i.test(model);
}

/**
 * DeepSeek 关闭思考模式的参数；非 DeepSeek 模型返回空对象（展开后等于不加）。
 *
 * @param model    本次实际请求用的模型名
 * @param envFlag  可选的「紧急摘除开关」环境变量名：
 *                 该变量被显式设成 "0" 时，即使模型是 DeepSeek 也不带这个参数。
 *                 留着它是因为 DeepSeek 的模型/接口行为会变，而这是线上功能，
 *                 必须能在**不改代码**的情况下摘掉。
 */
export function thinkingDisabled(model: string, envFlag?: string): Record<string, unknown> {
  if (!isDeepSeekModel(model)) return {};
  if (envFlag && process.env[envFlag] === "0") return {};
  return { thinking: { type: "disabled" } };
}

/**
 * 判定「这次响应是因为思考过程吃光预算而没吐出正文」——
 * 只有这种失败才值得**关掉思考重试一次**；其它空响应重试也没意义。
 *
 * 三个条件同时成立：
 *   1. `finish_reason === "length"`  —— 确实是被 max_tokens 截断
 *   2. `content` 为空               —— 没好输出
 *   3. `reasoning_content` 非空     —— 预算被思考吃掉了（这就是证据）
 */
export function truncatedByReasoning(data: unknown): boolean {
  const choice = (data as { choices?: Array<{ finish_reason?: string; message?: { content?: string; reasoning_content?: string } }> })
    ?.choices?.[0];
  if (!choice) return false;
  const content = choice.message?.content ?? "";
  const reasoning = choice.message?.reasoning_content ?? "";
  return choice.finish_reason === "length" && !content.trim() && reasoning.trim().length > 0;
}

/** 从响应里取正文（去空白） */
export function readContent(data: unknown): string {
  const c = (data as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content;
  return typeof c === "string" ? c.trim() : "";
}

/** 从响应里取思考内容长度（诊断用） */
export function reasoningLength(data: unknown): number {
  const r = (data as { choices?: Array<{ message?: { reasoning_content?: string } }> })?.choices?.[0]
    ?.message?.reasoning_content;
  return typeof r === "string" ? r.length : 0;
}
