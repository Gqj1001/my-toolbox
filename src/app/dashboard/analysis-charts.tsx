"use client";

import { useEffect, useRef } from "react";
import Chart from "chart.js/auto";

/**
 * 学情分析 · 图表（纯前端渲染，不额外请求）
 *
 * ⚠️ 只接收 `student-report.ts` 已经算好的数字；**不在前端重新算分/拆模块**。
 *    图表与文字必须同源，否则会出现“图上 60%、正文 70%”这种互相打脸。
 * ⚠️ Chart.js 必须在客户端 effect 里创建；SSR 时没有 canvas 上下文。
 */

export type ScoreChartPoint = {
  date: string;
  title: string;
  score: number;
  fullScore: number;
  percent: number;
};

type Props = {
  scores: ScoreChartPoint[];
  totalHours: number | null;
  consumedHours: number | null;
  skillRadar: { key: string; name: string; count: number; score: number }[];
};

const GRID = "rgba(148, 163, 184, 0.25)";
const TEXT = "rgb(113, 113, 122)";
const BLUE = "rgb(37, 99, 235)";
const GREEN = "rgb(16, 185, 129)";
const AMBER = "rgb(245, 158, 11)";

function shortDate(iso: string) {
  return /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(5).replace("-", "/") : iso || "未知";
}

export default function AnalysisCharts({ scores, totalHours, consumedHours, skillRadar }: Props) {
  const scoreRef = useRef<HTMLCanvasElement | null>(null);
  const hoursRef = useRef<HTMLCanvasElement | null>(null);
  const weakRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const charts: Chart[] = [];

    if (scoreRef.current && scores.length) {
      charts.push(new Chart(scoreRef.current, {
        type: "line",
        data: {
          labels: scores.map((s) => `${shortDate(s.date)} ${s.title}`.trim()),
          datasets: [{
            label: "得分率 %",
            data: scores.map((s) => s.percent),
            borderColor: BLUE,
            backgroundColor: "rgba(37, 99, 235, 0.12)",
            pointBackgroundColor: BLUE,
            pointRadius: 3,
            tension: 0.25,
            fill: true,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: (ctx) => {
                  const s = scores[ctx.dataIndex];
                  return `${s.score}/${s.fullScore} 分 · ${s.percent}%`;
                },
              },
            },
          },
          scales: {
            x: { grid: { display: false }, ticks: { color: TEXT, maxRotation: 30 } },
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

    if (hoursRef.current && totalHours != null && totalHours > 0 && consumedHours != null) {
      const used = Math.max(0, Math.min(consumedHours ?? 0, totalHours));
      const rest = Math.max(0, totalHours - used);
      charts.push(new Chart(hoursRef.current, {
        type: "doughnut",
        data: {
          labels: ["已消耗", "剩余"],
          datasets: [{
            data: [used, rest],
            backgroundColor: [GREEN, "rgba(148, 163, 184, 0.25)"],
            borderWidth: 0,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: "68%",
          plugins: {
            legend: { position: "bottom", labels: { color: TEXT, boxWidth: 10 } },
            tooltip: {
              callbacks: {
                label: (ctx) => `${ctx.label}：${ctx.parsed} 课时`,
              },
            },
          },
        },
      }));
    }

    if (weakRef.current && skillRadar.some((d) => d.count > 0 || d.score !== 100)) {
      charts.push(new Chart(weakRef.current, {
        type: "radar",
        data: {
          labels: skillRadar.map((d) => d.name),
          datasets: [{
            label: "能力值（100 分制）",
            data: skillRadar.map((d) => d.score),
            borderColor: AMBER,
            backgroundColor: "rgba(245, 158, 11, 0.22)",
            pointBackgroundColor: AMBER,
            pointBorderColor: "#fff",
            pointRadius: 3,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            r: {
              beginAtZero: true,
              min: 0,
              max: 100,
              ticks: { stepSize: 20, color: TEXT, backdropColor: "transparent" },
              grid: { color: GRID },
              angleLines: { color: GRID },
              pointLabels: { color: TEXT, font: { size: 11 } },
            },
          },
        },
      }));
    }

    return () => charts.forEach((c) => c.destroy());
  }, [scores, totalHours, consumedHours, skillRadar]);

  const hasHours = totalHours != null && totalHours > 0 && consumedHours != null;
  const hasSkill = skillRadar.some((d) => d.count > 0 || d.score !== 100);
  const noData = !scores.length && !hasHours && !hasSkill;
  if (noData) return null;

  return (
    <div className="mt-3 grid gap-4 lg:grid-cols-2">
      {scores.length ? (
        <div>
          <p className="mb-1 text-xs font-medium text-zinc-600 dark:text-zinc-300">成绩趋势（得分率）</p>
          <div className="h-48 rounded-lg border border-zinc-200 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-900/40">
            <canvas ref={scoreRef} aria-label="成绩趋势折线图" role="img" />
          </div>
        </div>
      ) : null}

      {hasHours ? (
        <div>
          <p className="mb-1 text-xs font-medium text-zinc-600 dark:text-zinc-300">
            课时消耗
            <span className="ml-1 font-normal text-zinc-400 dark:text-zinc-500">（按方案课表估算）</span>
          </p>
          <div className="h-48 rounded-lg border border-zinc-200 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-900/40">
            <canvas ref={hoursRef} aria-label="课时消耗环形图" role="img" />
          </div>
        </div>
      ) : null}

      {hasSkill ? (
        <div className="lg:col-span-2">
          <p className="mb-1 text-xs font-medium text-zinc-600 dark:text-zinc-300">能力值雷达（100 分制）</p>
          <div className="h-64 rounded-lg border border-zinc-200 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-900/40">
            <canvas ref={weakRef} aria-label="能力值雷达图" role="img" />
          </div>
        </div>
      ) : null}
    </div>
  );
}
