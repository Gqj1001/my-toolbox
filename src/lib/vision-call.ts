import { getViewer } from "@/lib/viewer";
import { readContent, reasoningLength, truncatedByReasoning } from "@/lib/deepseek-thinking";

/**
 * 视觉模型调用的**公共实现**（2026-10 第七批抽出来的）
 *
 * 为什么抽出来：`vision-paper`（把图**逐字抄成文字**）与 `vision-paper-structure`
 * （把图**理解成题目结构**）除了提示词与出参，其余完全一样：鉴权口径、模型配置、
 * thinking 护栏、思考吃光预算的重试、错误口径、日志。写两份必然漂移
 * —— 尤其**「免费口径」只能有一处**，否则哪天有人给其中一个加上 `requireVip()`，
 * 另一个就成了另一种产品。
 *
 * ⚠️ **免费口径（用户 2026-10 明确定）**：这两个功能都**不是会员专属**，
 *    只要求「登录 + 未封禁」。**不要**在调用方改成 `requireVip()`。
 *
 * ⚠️ 与 `vision-scores`（答题卡识别，会员专属）的区别：那条要的是**每题得分数字**，
 *    出参是 JSON，鉴权是 VIP —— 它**没有**用这里的免费口径，别混。
 */

const DEFAULT_BASE = "https://api.deepseek.com/v1";

export type VisionAuthResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

/** 免费口径的鉴权：登录 + 未封禁。**这是唯一的实现**，两个视觉路由都调它。 */
export async function visionAuthGuard(): Promise<VisionAuthResult> {
  const viewer = await getViewer();
  if (!viewer.user) return { ok: false, status: 401, error: "请先登录。" };
  if (viewer.membership.status === "banned") {
    return { ok: false, status: 403, error: "账号已被封禁。" };
  }
  return { ok: true };
}

export type VisionCallResult =
  | { ok: true; text: string; retried: boolean }
  | { ok: false; status: number; error: string };

/**
 * 调一次视觉模型（单张或多张图 + 一段文字）。
 *
 * @param label      日志前缀（如 "[paper-analysis/vision-paper]"）
 * @param system     system 提示词
 * @param images     `data:image/...` 数组（**只能放在 user 消息里** —— 放 system/assistant 官方会 400）
 * @param userText   user 消息里的文字部分
 * @param maxTokens  输出上限（默认 6000）
 * @param timeoutMs  超时（默认 90s）
 */
export async function callVisionModel(opts: {
  label: string;
  system: string;
  images: string[];
  userText: string;
  maxTokens?: number;
  timeoutMs?: number;
}): Promise<VisionCallResult> {
  const { label, system, images, userText, maxTokens = 6000, timeoutMs = 90_000 } = opts;

  // ---------- 服务端配置 ----------
  const apiKey = process.env.AI_KEY;
  const visionModel = process.env.AI_VISION_MODEL;
  if (!apiKey || !visionModel) {
    return {
      ok: false,
      status: 503,
      error:
        "云端版未启用图片识别（需要额外的多模态模型）。" +
        "请改用 .docx 上传，或把报告里的文字直接复制粘贴进来。",
    };
  }
  const baseUrl = (process.env.AI_VISION_BASE_URL ?? process.env.AI_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, "");

  /**
   * ⚠️ 护栏：**只有确认是 DeepSeek 才带 `thinking` 这个专有字段**。
   * 模型名来自 `AI_VISION_MODEL`，可能是任意 OpenAI 兼容视觉模型；
   * 给不认识该字段的厂商发过去可能直接 400。另有 `AI_VISION_SUPPORTS_THINKING=0` 紧急开关。
   */
  const supportsThinking =
    /deepseek/i.test(visionModel) && process.env.AI_VISION_SUPPORTS_THINKING !== "0";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const callUpstream = () =>
    fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: visionModel,
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            // ⚠️ 图片只能放在 **user** 消息里（放 system/assistant 官方会 400）。
            // ⚠️ 没有图片时（如"估难度"那种纯文本任务）就**发纯字符串**，不要包成单元素数组：
            //    数组形式对文本模型虽然合法，但会让上游/桩难以区分"带图的请求"与"纯文本请求"，
            //    也白白多一层结构。这条在本轮被测试抓到过。
            content:
              images.length === 0
                ? userText
                : [
                    { type: "text", text: userText },
                    ...images.map((url) => ({ type: "image_url", image_url: { url } })),
                  ],
          },
        ],
        max_tokens: maxTokens,
        ...(supportsThinking ? { thinking: { type: "disabled" } } : {}),
      }),
      signal: controller.signal,
    });

  try {
    let res = await callUpstream();
    if (!res.ok) {
      console.error(`${label} 上游返回`, res.status, (await res.text()).slice(0, 300));
      return { ok: false, status: 502, error: "识别服务暂时不可用，请稍后重试。" };
    }

    let data = (await res.json()) as {
      choices?: Array<{ finish_reason?: string; message?: { content?: string; reasoning_content?: string } }>;
      usage?: Record<string, unknown>;
    };

    // 兜底重试：思考过程吃光预算（与另外几条 AI 路由同源）
    let retried = false;
    if (truncatedByReasoning(data)) {
      retried = true;
      console.warn(
        `${label} 思考过程吃光 max_tokens，关掉 thinking 重试一次 | 诊断:`,
        JSON.stringify({
          model: visionModel,
          supportsThinking,
          reasoningLen: reasoningLength(data),
          usage: data.usage ?? null,
        }),
      );
      res = await callUpstream();
      if (res.ok) data = (await res.json()) as typeof data;
      else console.error(`${label} 重试仍失败，上游返回`, res.status, (await res.text()).slice(0, 300));
    }

    return { ok: true, text: readContent(data), retried };
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    console.error(`${label} 调用失败:`, aborted ? "超时" : (e as Error)?.message);
    return {
      ok: false,
      status: 502,
      error: aborted ? "识别超时，请重试或换一张更清晰的图。" : "识别服务暂时不可用。",
    };
  } finally {
    clearTimeout(timer);
  }
}
