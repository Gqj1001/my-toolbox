import "server-only";

import { inflateRawSync, inflateSync } from "node:zlib";

/**
 * 试卷文件文本提取（零依赖，只用 Node 内置 zlib）
 *
 * 三个函数从「试卷分析工作台」原 server.js 原样搬运，**算法一行未改**：
 *   extractDocxText        —— docx 就是 ZIP，扫中央目录找 word/document.xml
 *   extractLegacyDocText   —— 老 .doc 二进制里尽力抓可读文本
 *   extractPdfText         —— PDF 内容流抽文本，支持 ToUnicode CMap
 *
 * 搬运时只改了两处机制性写法：
 *   require('zlib') → ESM import；module.exports 语义 → 具名导出。
 */

/** 从 docx（ZIP + XML）里抽出纯文本 */
export function extractDocxText(buf: Buffer): string {
  // 扫中央目录，找到 word/document.xml
  let target: { method: number; csize: number; lho: number; name: string } | null = null;
  let i = 0;
  while (true) {
    i = buf.indexOf(Buffer.from("PK\x01\x02"), i);
    if (i < 0) break;
    const method = buf.readUInt16LE(i + 10);
    const csize = buf.readUInt32LE(i + 20);
    const nlen = buf.readUInt16LE(i + 28);
    const elen = buf.readUInt16LE(i + 30);
    const clen = buf.readUInt16LE(i + 32);
    const lho = buf.readUInt32LE(i + 42);
    const name = buf.subarray(i + 46, i + 46 + nlen).toString("utf8");
    if (name === "word/document.xml") {
      target = { method, csize, lho, name };
      break;
    }
    i += 46 + nlen + elen + clen;
  }
  if (!target) throw new Error("不是有效的 docx（缺少 word/document.xml）");
  // 从本地文件头算出数据起始位置
  const lnameLen = buf.readUInt16LE(target.lho + 26);
  const lextraLen = buf.readUInt16LE(target.lho + 28);
  const start = target.lho + 30 + lnameLen + lextraLen;
  const raw = buf.subarray(start, start + target.csize);
  let xml: string;
  if (target.method === 0) xml = raw.toString("utf8");
  else if (target.method === 8) xml = inflateRawSync(raw).toString("utf8");
  else throw new Error("不支持的压缩方式 " + target.method);
  return docxXmlToText(xml);
}

/**
 * 把 word/document.xml 转成"表格用 <TABLE> 包裹、行内用 | 分隔"的文本
 *
 * ⚠ 所有标签的正则都必须允许带属性（`<w:tc w:rsidR="…">`、
 *   `<w:tr w14:paraId="…">`）。早期写成不带属性的 `<w:tc>`，
 *   真实 Word 导出的文件里一格都抓不到。前端 app.js 里是同逻辑，也要一致。
 */
export function docxXmlToText(xml: string): string {
  const out: string[] = [];
  // 逐个处理 表格 / 段落
  const parts = xml.split(/(<w:tbl(?:\s[^>]*)?>[\s\S]*?<\/w:tbl>)/g);
  parts.forEach((seg) => {
    if (/^<w:tbl[\s>]/.test(seg)) {
      out.push("<TABLE>");
      // 每一行
      (seg.match(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g) || []).forEach((tr) => {
        const cells: string[] = [];
        (tr.match(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g) || []).forEach((tc) => {
          // 单元格内的文本：按段落分组，段内 <w:t> 拼接
          const paras = tc.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g) || [tc];
          const txt = paras
            .map((p) =>
              (p.match(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g) || [])
                .map((t) => t.replace(/<[^>]+>/g, ""))
                .join(""),
            )
            .filter(Boolean)
            .join(" ");
          cells.push(unescapeXml(txt.trim()));
        });
        out.push(cells.join(" | "));
      });
      out.push("</TABLE>");
    } else {
      (seg.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g) || []).forEach((p) => {
        const txt = (p.match(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g) || [])
          .map((t) => t.replace(/<[^>]+>/g, ""))
          .join("");
        const s = unescapeXml(txt.trim());
        if (s) out.push(s);
      });
    }
  });
  return out.join("\n");
}

export function unescapeXml(s: string): string {
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** 从老 .doc 二进制里抓可读文本（尽力而为） */
export function extractLegacyDocText(buf: Buffer): string {
  // WordDocument 流里中文多为 UTF-16LE；先试 UTF-16LE，再退回 Latin1 过滤
  const tryDecode = (enc: BufferEncoding, filter: (x: string) => boolean) => {
    let s = buf.toString(enc);
    s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ");
    return s
      .split(/[\r\n\u0007\u000D]+/)
      .map((x) => x.replace(/\s+/g, " ").trim())
      .filter((x) => x && filter(x));
  };
  let lines = tryDecode("utf16le", (x) => /[\u4e00-\u9fa5A-Za-z0-9]/.test(x) && x.length > 1);
  if (lines.join("").length < 50) {
    lines = tryDecode("latin1", (x) => /[\u4e00-\u9fa5]/.test(x) === false && x.length > 3);
  }
  // 去掉 Word 内部的样式名等噪声
  const noise =
    /^(Microsoft|Times New Roman|Calibri|Normal|Default|WordDocument|SummaryInformation|DocumentSummary|1Table|ObjectPool|CompObj|MSWordDoc|Root Entry|Data|Word|0Table)/i;
  return lines
    .filter((x) => !noise.test(x))
    .join("\n")
    .slice(0, 60000);
}

/**
 * 从 PDF 里尽量抽文本。
 * 支持：Tj/TJ 字符串、以及带 ToUnicode CMap 的 CID 编码。
 * 抽不到（扫描版/字体子集无映射）就返回空串，交给上层提示走视觉模型。
 */
export function extractPdfText(buf: Buffer): string {
  const raw = buf.toString("latin1");

  /* ---- 1. 收集 ToUnicode CMap 映射 ---- */
  const map: Record<number, string> = {};
  const pushPairs = (src: string) => {
    // beginbfchar: <0003> <0020>
    (src.match(/beginbfchar([\s\S]*?)endbfchar/g) || []).forEach((blk) => {
      (blk.match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g) || []).forEach((pair) => {
        const m = pair.match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/);
        if (!m) return;
        const code = parseInt(m[1], 16);
        const uni = m[2].length >= 4 ? parseInt(m[2].slice(0, 4), 16) : parseInt(m[2], 16);
        if (!isNaN(uni)) map[code] = String.fromCharCode(uni);
      });
    });
    // beginbfrange: <0003> <0005> <0020>
    (src.match(/beginbfrange([\s\S]*?)endbfrange/g) || []).forEach((blk) => {
      (blk.match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g) || []).forEach((t) => {
        const m = t.match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/);
        if (!m) return;
        const lo = parseInt(m[1], 16),
          hi = parseInt(m[2], 16),
          base = parseInt(m[3].slice(0, 4), 16);
        for (let c = lo; c <= hi && c - lo < 256; c++) map[c] = String.fromCharCode(base + (c - lo));
      });
    });
  };

  /* ---- 2. 解压所有流，收集 CMap 与内容流 ---- */
  const streams: string[] = [];
  let si = 0;
  while ((si = raw.indexOf("stream", si)) >= 0) {
    let s = si + 6;
    if (raw[s] === "\r") s++;
    if (raw[s] === "\n") s++;
    const e = raw.indexOf("endstream", s);
    if (e < 0) break;
    const bytes = buf.subarray(s, e);
    let dec: string | null = null;
    try {
      dec = inflateSync(bytes).toString("latin1");
    } catch {
      try {
        dec = inflateRawSync(bytes).toString("latin1");
      } catch {
        /* 解压失败就跳过这个流 */
      }
    }
    if (dec) streams.push(dec);
    si = e + 9;
  }
  streams.forEach(pushPairs);
  const hasMap = Object.keys(map).length > 0;

  /* ---- 3. 从内容流抽文本 ---- */
  const out: string[] = [];
  streams.forEach((st) => {
    if (st.indexOf("BT") < 0 && st.indexOf("Tj") < 0 && st.indexOf("TJ") < 0) return;
    // 括号字符串 (...) 与 十六进制串 <> 都要处理
    const tokens =
      st.match(/\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]+>|\bTJ\b|\bTj\b|\bTd\b|\bTD\b|\bT\*\b/g) || [];
    let line = "";
    const flush = () => {
      if (line.trim()) out.push(line.trim());
      line = "";
    };
    tokens.forEach((tk) => {
      if (tk === "Td" || tk === "TD" || tk === "T*") {
        flush();
        return;
      }
      if (tk === "TJ" || tk === "Tj") return;
      if (tk[0] === "(") {
        const s = tk
          .slice(1, -1)
          .replace(/\\n/g, "\n")
          .replace(/\\r/g, "\r")
          .replace(/\\t/g, "\t")
          .replace(/\\([()\\])/g, "$1")
          .replace(/\\([0-7]{1,3})/g, (_m, o: string) => String.fromCharCode(parseInt(o, 8)));
        line += s;
        return;
      }
      if (tk[0] === "<") {
        const hex = tk.slice(1, -1).replace(/\s/g, "");
        if (hex.length % 4 === 0 && hasMap) {
          for (let i = 0; i < hex.length; i += 4) {
            const code = parseInt(hex.substr(i, 4), 16);
            line += map[code] || "";
          }
        } else {
          // 双字节 Unicode（无 CMap 时的兜底）
          for (let i = 0; i + 3 < hex.length; i += 4) {
            const code = parseInt(hex.substr(i, 4), 16);
            const ch = String.fromCharCode(code);
            if (ch >= " " || /[\u4e00-\u9fa5]/.test(ch)) line += ch;
          }
        }
      }
    });
    flush();
  });

  // 只保留像"有内容"的行，过滤 PDF 噪声
  const clean = out
    .map((x) => x.replace(/\s+/g, " ").trim())
    .filter((x) => x.length > 1 && /[\u4e00-\u9fa5A-Za-z0-9]/.test(x) && !/^[\d\s.]+$/.test(x));
  // 去重相邻重复
  const ded = clean.filter((x, i) => i === 0 || x !== clean[i - 1]);
  return ded.join("\n").slice(0, 80000);
}
