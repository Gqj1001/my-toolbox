import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "My Toolbox",
  description: "基于 Next.js 与 Supabase Auth 的在线工具箱",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="zh-CN"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      {/*
        body 固定为视口高度且不滚动，由各页面的 <main> 自己负责滚动
        （className 里带 overflow-y-auto）。这样 math-plan 这类需要
        「撑满剩余高度」的页面才能用 flex-1 正确计算高度。
      */}
      <body className="flex h-full flex-col overflow-hidden">{children}</body>
    </html>
  );
}
