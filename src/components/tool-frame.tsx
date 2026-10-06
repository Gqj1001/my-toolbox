"use client";

import { useState, type ReactNode } from "react";

type ToolFrameProps = {
  /** iframe 的地址，如 /tools/feedback.html */
  src: string;
  /** 无障碍标题（一般传工具名） */
  title: string;
  /**
   * 加载期间显示的骨架。**必须是不依赖任何 API 的纯静态内容。**
   * 不传时退化为原来的行为（只有 iframe，没有骨架）。
   */
  skeleton?: ReactNode;
};

/**
 * 工具 iframe + 加载骨架。
 *
 * ⚠️ 实现要点（不然会踩坑）：
 *   1. **iframe 从第一次渲染就挂上**，骨架是叠在它上面的绝对定位层。
 *      如果做法是「先不渲染 iframe、等 onLoad 再渲染」，那 onLoad 里改 state
 *      会引起重新渲染，React 可能把 iframe 重新挂载 → **工具被加载两次**。
 *      叠层法不会动 iframe 这个元素本身，所以不存在这个问题。
 *   2. 骨架必须**纯静态**：iframe 里那个工具自己要打好几次 API，
 *      骨架再去请求任何东西就等于把白屏时间叠上去。
 *   3. 淡出用 opacity 过渡，并且加载完把骨架设为 `pointer-events-none`
 *      —— 否则看不见的骨架会挡住工具页的点击（这是这种写法最经典的 bug）。
 */
export default function ToolFrame({ src, title, skeleton }: ToolFrameProps) {
  const [loaded, setLoaded] = useState(false);

  return (
    <main className="relative flex w-full flex-1 flex-col overflow-hidden">
      <iframe
        src={src}
        title={title}
        onLoad={() => setLoaded(true)}
        className="block h-full min-h-0 w-full border-0 bg-white opacity-100"
        allow="clipboard-write"
      />

      {skeleton ? (
        <div
          aria-hidden={loaded}
          data-skeleton={loaded ? "done" : "loading"}
          className={`absolute inset-0 overflow-hidden bg-white transition-opacity duration-300 dark:bg-zinc-950 ${
            loaded ? "pointer-events-none opacity-0" : "opacity-100"
          }`}
        >
          {skeleton}
        </div>
      ) : null}
    </main>
  );
}
