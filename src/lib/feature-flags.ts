import "server-only";

import { createClient } from "@/lib/supabase/server";

/**
 * 功能开关（feature flags）—— 服务端读取
 * ==========================================================================
 * 干什么：让**管理后台**能一键关掉某个"初版功能"，不用改代码、不用重新部署。
 *
 * 三条约定（新增一个开关时照做，缺一条后台就管不住）：
 *   1. 在 `FEATURE_FLAG_REGISTRY` 里**登记**（key / 标签 / 说明 / 关闭参数名 / 作用于哪个工具）；
 *   2. 在迁移 `0018_feature_flags.sql` 里补一条**同 key 的种子**（表只存状态，代码才是"谁受影响"的来源）；
 *   3. 工具页要**认这个参数**（例：`app.js` 的 `companyExportDisabled()` 读 `?nocompanyexport=1`）。
 *      参数由 `ToolPageShell` 拼到 iframe 的 src 上 —— **工具页代码一行都不用改**。
 *
 * ⚠️ 读不到表（迁移没跑 / DB 抖动）时一律**当"开启"**：
 *    一个数据库小抖动不该悄悄把功能干掉；后台会明确显示"表还没建 + 要跑哪个迁移"。
 *
 * ⚠️ 缓存 30 秒进程内 —— 与 `tools` 表同一套做法（见 `tools-db.ts` 里那段"不要用 unstable_cache"的说明）。
 *    后台改完会 `invalidateFeatureFlags()`：本实例立刻生效，其它实例最多滞后 TTL。对"开关"够用。
 */

/** 登记表里的一条开关（**代码是"谁受影响"的唯一来源**） */
export type FeatureFlagSpec = {
  key: string;
  /** 后台里显示的名字 */
  label: string;
  /** 后台里显示的说明（写清"关掉后会发生什么"） */
  note: string;
  /** 关掉时拼上去的**参数名**（值固定为 1）。
   *  ⚠️ 两种落点，见 `tools` 字段的说明。 */
  param: string;
  /** 作用于哪些**工具页**（slug，如 paper-analysis）——关掉时 `ToolPageShell` 会把参数拼到 iframe src 上。
   *  ⚠️ 若受影响的是**网站页面**（不是工具 iframe），这里留 `[]`，由那个页面**自己**读开关
   *     （见 `pageDisables()`，例：`/dashboard` 的「补录历史材料」）。 */
  tools: string[];
};

export const FEATURE_FLAG_REGISTRY: FeatureFlagSpec[] = [
  {
    key: "company_export",
    label: "公司模板导出（试卷分析）",
    note: "试卷分析「③ 生成报告」页的「🏢 公司模板导出」面板（附件1 / 附件2）。关掉后面板消失、按钮点不动；其它功能（表单、报告、AI 润色、旧导出）一律照常。",
    param: "nocompanyexport",
    tools: ["paper-analysis"],
  },
  {
    // ★ 2026-10 第十八批（用户要求"初版功能要能一键关掉"）
    key: "backfill_materials",
    label: "补录历史材料（学员档案）",
    note: "学员档案详情页的「📥 补录历史材料」面板（把工具上线之前的旧试卷分析/辅导方案/课后反馈整理进档案）。关掉后面板消失；手动补录成绩、档案列表、学情分析等一律照常。⚠️ 它不在工具 iframe 里，所以由 /dashboard 页面自己读这个开关（见 feature-flags.ts 的 pageDisables）。",
    param: "nobackfill",
    // 不是工具 iframe ⇒ 不用服务端拼 iframe 参数；由页面自己读
    tools: [],
  },
];

/**
 * 页面级开关：受影响的是**网站页面**（不是工具 iframe）时用它。
 *
 * ⚠️ 为什么需要它：`ToolPageShell` 那套"把参数拼到 iframe 的 src 上"只对工具页有效；
 *    `/dashboard` 这类页面没有 iframe，**必须自己读开关**。调用方从自己的
 *    searchParams 里取出 `spec.param` 的值传进来（Next 给的是对象、不是 URLSearchParams，
 *    所以这里刻意收**单个字符串**，不去绑 Next 的类型）。
 *
 * 优先级与工具页一致：**URL 参数（含后台开关） > 代码常量** ⇒ 后台关掉＝一定关。
 *
 * @param key         登记表里的 key
 * @param paramValue  调用方从 URL 里取到的该参数值（'1' = 临时关掉）；没取到传 undefined
 */
export async function pageDisables(key: string, paramValue?: string | string[] | null): Promise<boolean> {
  const spec = FEATURE_FLAG_REGISTRY.find((f) => f.key === key);
  if (!spec) return false;                       // 没登记过的 key：不参与（与白名单同一口径）
  if (await isFeatureEnabled(key) === false) return true;          // 后台关掉
  const v = Array.isArray(paramValue) ? paramValue[0] : paramValue;
  return v === "1";                                                // 临时兜底：?nobackfill=1
}

/** 后台展示用：登记信息 + 表里的状态 */
export type FeatureFlagView = FeatureFlagSpec & {
  enabled: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
};

export type FeatureFlagsResult = {
  /** 表读到了吗（false = 迁移没跑或读失败，此时所有开关按"开启"算） */
  ready: boolean;
  error: string | null;
  flags: FeatureFlagView[];
};

/** 迁移没跑时的提示（照 0017 的先例：**明确指出迁移文件名**，别让人猜） */
const MIGRATION_HINT =
  "功能开关表还没建：请在 Supabase SQL Editor 执行 supabase/migrations/0018_feature_flags.sql" +
  "（重复执行也安全）。在它跑之前，所有功能保持开启。";

/**
 * 判断"表不存在"（= 迁移还没跑）。
 * ⚠️ 不能只判 Postgres 的 `42P01`：经 PostgREST 读表时，表不在 schema cache 里返回的是
 *    **`PGRST205`**（实测踩过 —— 只判 42P01 会导致"该跑哪个迁移"的提示不出现）。
 */
export function isMissingTableError(error: { code?: string | null; message?: string | null }): boolean {
  const code = String(error?.code ?? "");
  if (code === "42P01" || code === "PGRST205") return true;
  return /schema cache|does not exist|could not find the table/i.test(String(error?.message ?? ""));
}

/** 缓存有效期（毫秒）—— 与 tools 表的 30 秒一致 */
const TTL_MS = 30_000;

type CacheEntry = {
  at: number;
  enabled: Map<string, boolean>;
  meta: Map<string, { updatedAt: string | null; updatedBy: string | null }>;
};

let cache: CacheEntry | null = null;
let notice: string | null = null;

/** 清缓存（后台改完开关时调用；本实例立刻生效） */
export function invalidateFeatureFlags(): void {
  cache = null;
}

async function load(): Promise<{ ready: boolean; error: string | null }> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("feature_flags")
    .select("key, enabled, updated_at, updated_by");

  if (error) {
    // 表不存在（迁移还没执行）；其它错误也照"保持开启"处理
    const isMissing = isMissingTableError(error);
    notice = isMissing ? MIGRATION_HINT : `读取功能开关失败（已按"全部开启"处理）：${error.message}`;
    console.warn("[feature-flags]", notice);
    return { ready: false, error: notice };
  }

  const enabled = new Map<string, boolean>();
  const meta = new Map<string, { updatedAt: string | null; updatedBy: string | null }>();
  for (const row of data ?? []) {
    const key = String(row.key);
    enabled.set(key, row.enabled !== false);
    meta.set(key, {
      updatedAt: (row.updated_at as string | null) ?? null,
      updatedBy: (row.updated_by as string | null) ?? null,
    });
  }
  cache = { at: Date.now(), enabled, meta };
  notice = null;
  return { ready: true, error: null };
}

async function ensureFresh(): Promise<{ ready: boolean; error: string | null }> {
  if (cache && Date.now() - cache.at < TTL_MS) return { ready: true, error: null };
  return load();
}

/**
 * 读全部开关（带 30 秒缓存）。
 * ⚠️ `ready:false` 时下面每个 flag 的 `enabled` 都是 **true**（保持功能开启）。
 */
export async function getFeatureFlags(): Promise<FeatureFlagsResult> {
  const { ready, error } = await ensureFresh();
  const flags: FeatureFlagView[] = FEATURE_FLAG_REGISTRY.map((spec) => ({
    ...spec,
    enabled: ready ? cache?.enabled.get(spec.key) !== false : true,
    updatedAt: ready ? cache?.meta.get(spec.key)?.updatedAt ?? null : null,
    updatedBy: ready ? cache?.meta.get(spec.key)?.updatedBy ?? null : null,
  }));
  return { ready, error, flags };
}

/** 单个开关是否开启（读不到 = 开启） */
export async function isFeatureEnabled(key: string): Promise<boolean> {
  const { flags } = await getFeatureFlags();
  return flags.find((f) => f.key === key)?.enabled !== false;
}

/**
 * 某个工具需要带上的"关闭参数"串，例如 `nocompanyexport=1`（没有就是空串）。
 * 由 `ToolPageShell` 拼到 iframe 的 src 上。
 */
export async function getDisabledParamsForTool(slug: string): Promise<string> {
  const { flags } = await getFeatureFlags();
  return flags
    .filter((f) => !f.enabled && f.tools.includes(slug))
    .map((f) => `${f.param}=1`)
    .join("&");
}

/** 把参数串拼到 iframe src 上（已带 `?` 就用 `&`） */
export function withFeatureParams(src: string, params: string): string {
  if (!params) return src;
  return src + (src.includes("?") ? "&" : "?") + params;
}
