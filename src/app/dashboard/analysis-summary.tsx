import { formatDisplayDate } from "@/lib/feedback-db";
import { TOOL_LABELS, type StudentReport } from "@/lib/student-report";

/**
 * 学情分析 · **统计部分**（服务端渲染，所有人可见，不花 AI 钱）
 *
 * ⚠️ 算法全在 `src/lib/student-report.ts`（纯函数、有单元测试）。这里**只负责显示** ——
 *    同一个报告还要喂给 AI（`/api/students/analysis`），两处必须用**同一份**计算结果，
 *    所以这个组件不自己做任何统计或抽取。
 *
 * ⚠️ 「抽不到」的话必须显示出来（`report.notes`）：宁可让老师看到
 *    「有 2 条试卷分析里没有那句话」，也不能让页面看起来像"这位学生没有薄弱点"。
 */
const card = "rounded-xl border border-zinc-200 bg-white px-4 py-4 dark:border-zinc-800 dark:bg-zinc-900/40";
const th = "px-2 py-1 text-left font-medium text-zinc-500 dark:text-zinc-400";
const td = "px-2 py-1 text-zinc-700 dark:text-zinc-200";

export default function AnalysisSummary({ report }: { report: StudentReport }) {
  const { overview, scores, trend, hours, weaknesses, notes } = report;
  const hasAnything = overview.total > 0;

  return (
    <section className={card}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-200">学情分析</h2>
        <span className="text-xs text-zinc-400 dark:text-zinc-500">
          依据档案里已有的记录自动汇总，不含推测
        </span>
      </div>

      {!hasAnything ? (
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          这位学生还没有记录。先在「辅导方案 / 试卷分析 / 课后反馈」里存一条，这里就会有内容。
        </p>
      ) : (
        <>
          {/* ---------------- 概览 ---------------- */}
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
            共 <b>{overview.total}</b> 条记录：
            {overview.byTool.map((b, i) => (
              <span key={b.tool}>
                {i > 0 ? " · " : ""}
                {b.label} {b.count} 条
              </span>
            ))}
            {overview.firstDate && overview.lastDate ? (
              <>
                ；时间跨度 {formatDisplayDate(overview.firstDate)} ～ {formatDisplayDate(overview.lastDate)}
                {overview.spanDays != null ? `（${overview.spanDays} 天）` : ""}
              </>
            ) : null}
          </p>

          {/* ---------------- 成绩趋势 ---------------- */}
          <div className="mt-3">
            <p className="text-xs font-medium text-zinc-600 dark:text-zinc-300">成绩趋势</p>
            {scores.length ? (
              <>
                <div className="mt-1 overflow-x-auto">
                  <table className="w-full min-w-[26rem] border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-zinc-200 dark:border-zinc-800">
                        <th className={th}>日期</th>
                        <th className={th}>名称</th>
                        <th className={th}>来源</th>
                        <th className={`${th} text-right`}>得分</th>
                        <th className={`${th} text-right`}>得分率</th>
                      </tr>
                    </thead>
                    <tbody>
                      {scores.map((s, i) => (
                        <tr key={`${s.date}-${s.title}-${i}`} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
                          <td className={td}>{s.date ? formatDisplayDate(s.date) : "未知"}</td>
                          <td className={td}>{s.title}</td>
                          <td className="px-2 py-1 text-zinc-400 dark:text-zinc-500">{TOOL_LABELS[s.tool] ?? s.tool}</td>
                          <td className={`${td} text-right`}>
                            {s.score}
                            <span className="text-zinc-400 dark:text-zinc-500"> / {s.fullScore}</span>
                          </td>
                          <td className={`${td} text-right`}>{s.percent}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {trend ? (
                  <p className="mt-1.5 text-xs text-zinc-600 dark:text-zinc-300">
                    首次 <b>{trend.firstPercent}%</b> → 末次 <b>{trend.lastPercent}%</b>（
                    <span className={trend.delta >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}>
                      {trend.delta >= 0 ? "+" : ""}
                      {trend.delta} 个百分点
                    </span>
                    ）；平均 {trend.avgPercent}%；最高 {trend.best.percent}%（{trend.best.title}）；
                    最低 {trend.worst.percent}%（{trend.worst.title}）
                  </p>
                ) : null}
              </>
            ) : (
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                还没有「带满分」的考试记录，算不出得分率与趋势。
              </p>
            )}
          </div>

          {/* ---------------- 课时 ---------------- */}
          <div className="mt-3">
            <p className="text-xs font-medium text-zinc-600 dark:text-zinc-300">课时安排</p>
            {hours.entries.length ? (
              <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-300">
                累计 <b>{hours.total}</b> 课时（来自 {hours.entries.length} 份辅导方案）：
                {hours.entries
                  .map((e) => `${e.date ? formatDisplayDate(e.date) : "未知"} ${e.hours} 课时`)
                  .join(" · ")}
              </p>
            ) : (
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">还没有能从辅导方案里读到课时的记录。</p>
            )}
          </div>

          {/* ---------------- 薄弱与失分 ---------------- */}
          <div className="mt-3">
            <p className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
              薄弱与失分
              <span className="ml-1 font-normal text-zinc-400 dark:text-zinc-500">（摘自各工具正文原文）</span>
            </p>
            {weaknesses.length ? (
              <ul className="mt-1 flex flex-col gap-1">
                {weaknesses.map((w, i) => (
                  <li key={`${w.tool}-${w.label}-${w.date}-${i}`} className="text-xs text-zinc-700 dark:text-zinc-300">
                    <span className="text-zinc-400 dark:text-zinc-500">
                      [{TOOL_LABELS[w.tool] ?? w.tool}·{w.label}] {w.date ? formatDisplayDate(w.date) : "未知"}：
                    </span>
                    {w.text}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                现有记录的正文里没有抽到薄弱/失分信息（<b>没有替你猜</b>）。
              </p>
            )}
          </div>
        </>
      )}

      {/* ---------------- 如实说明：抽不到的、被排除的 ---------------- */}
      {notes.length ? (
        <ul className="mt-3 flex flex-col gap-1 rounded-lg bg-zinc-50 px-3 py-2 dark:bg-zinc-950/60">
          {notes.map((n) => (
            <li key={n} className="text-xs text-zinc-500 dark:text-zinc-400">
              · {n}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
