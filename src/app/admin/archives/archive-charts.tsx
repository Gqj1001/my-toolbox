"use client";

import { useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Chart from "chart.js/auto";
import type { ArchiveStats } from "@/lib/admin-archives";

const TEXT = "rgb(113, 113, 122)";
const GRID = "rgba(148, 163, 184, 0.25)";
const COLORS = ["#2563eb", "#10b981", "#f59e0b", "#8b5cf6", "#ef4444", "#06b6d4", "#84cc16", "#f97316"];

/** 点击图表 → 修改 URL 查询串（服务端重新渲染列表），实现下钻。 */
export default function ArchiveCharts({ stats }: { stats: ArchiveStats }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pieRef = useRef<HTMLCanvasElement | null>(null);
  const lineRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const charts: Chart[] = [];

    const pushFilter = (key: "campus" | "month", value: string) => {
      const sp = new URLSearchParams(searchParams.toString());
      if (value) sp.set(key, value);
      else sp.delete(key);
      router.push(`/admin/archives?${sp.toString()}`);
    };

    if (pieRef.current && stats.campusDistribution.length) {
      charts.push(new Chart(pieRef.current, {
        type: "doughnut",
        data: {
          labels: stats.campusDistribution.map((x) => x.campus),
          datasets: [{
            data: stats.campusDistribution.map((x) => x.count),
            backgroundColor: stats.campusDistribution.map((_, i) => COLORS[i % COLORS.length]),
            borderWidth: 0,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: "58%",
          onClick: (_e, elements) => {
            if (!elements.length) return;
            const idx = elements[0].index;
            const campus = stats.campusDistribution[idx]?.campus ?? "";
            pushFilter("campus", campus === "未归属" ? "" : campus);
          },
          plugins: {
            legend: { position: "bottom", labels: { color: TEXT, boxWidth: 10 } },
            tooltip: {
              callbacks: {
                label: (ctx) => `${ctx.label}：${ctx.parsed} 人（点击筛选）`,
              },
            },
          },
        },
      }));
    }

    if (lineRef.current && stats.monthlyTrend.length) {
      charts.push(new Chart(lineRef.current, {
        type: "line",
        data: {
          labels: stats.monthlyTrend.map((x) => x.month),
          datasets: [{
            label: "整体平均得分率 %",
            data: stats.monthlyTrend.map((x) => x.avgPercent),
            borderColor: "#2563eb",
            backgroundColor: "rgba(37, 99, 235, 0.12)",
            pointBackgroundColor: "#2563eb",
            pointRadius: 3,
            tension: 0.25,
            fill: true,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          onClick: (_e, elements) => {
            if (!elements.length) return;
            const idx = elements[0].index;
            const month = stats.monthlyTrend[idx]?.month ?? "";
            pushFilter("month", month);
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: (ctx) => {
                  const p = stats.monthlyTrend[ctx.dataIndex];
                  return `平均 ${p.avgPercent}% · ${p.count} 条成绩（点击筛选）`;
                },
              },
            },
          },
          scales: {
            x: { grid: { display: false }, ticks: { color: TEXT } },
            y: {
              beginAtZero: true,
              suggestedMax: 100,
              grid: { color: GRID },
              ticks: { color: TEXT, callback: (v) => `${v}%` },
            },
          },
        },
      }));
    }

    return () => charts.forEach((c) => c.destroy());
  }, [stats, router, searchParams]);

  if (!stats.campusDistribution.length && !stats.monthlyTrend.length) return null;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {stats.campusDistribution.length ? (
        <div>
          <p className="mb-1 text-xs font-medium text-zinc-600 dark:text-zinc-300">
            各校区学员分布
            <span className="ml-1 font-normal text-zinc-400 dark:text-zinc-500">（点击扇形筛选下方列表）</span>
          </p>
          <div className="h-56 rounded-xl border border-zinc-200 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-900/40">
            <canvas ref={pieRef} aria-label="各校区学员分布饼图" role="img" />
          </div>
        </div>
      ) : null}

      {stats.monthlyTrend.length ? (
        <div>
          <p className="mb-1 text-xs font-medium text-zinc-600 dark:text-zinc-300">
            整体学情提分趋势
            <span className="ml-1 font-normal text-zinc-400 dark:text-zinc-500">（近 6 个月平均得分率；点击点筛选）</span>
          </p>
          <div className="h-56 rounded-xl border border-zinc-200 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-900/40">
            <canvas ref={lineRef} aria-label="整体学情提分趋势折线图" role="img" />
          </div>
        </div>
      ) : null}
    </div>
  );
}
