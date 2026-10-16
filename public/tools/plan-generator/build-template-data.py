# -*- coding: utf-8 -*-
"""把 `模板-占位符.docx` 打成一个浏览器可直接用的 JS 文件（零件以 base64 内嵌）。

用法：
    python public/tools/plan-generator/build-template-data.py

产物：`public/tools/plan-generator/template-data.js`（挂 `window.PlanGenTemplateData`）
      —— 与 `public/tools/math-plan/template-data.js` 同一套机制，只是零件换成了物理模板。

⚠️ 模板改了就要重跑一次。**不要手改产物**。
⚠️ 刻意**不**导出明文的 `template-parts/`（math-plan 有一份，是给人 debug 用的）。
   两个工具各留一份同名的调试目录会让人分不清，这里只出 `.js`。
"""
import zipfile, io, os, json, re, base64

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "模板-占位符.docx")
OUT_JS = os.path.join(HERE, "template-data.js")
GLOBAL_NAME = "PlanGenTemplateData"

if not os.path.exists(SRC):
    raise SystemExit("找不到模板：%s\n（先跑 build-template.py）" % SRC)

z = zipfile.ZipFile(SRC)
names = [n for n in z.namelist() if not n.endswith("/")]
parts = {n: z.read(n) for n in names}

doc = parts["word/document.xml"].decode("utf-8")
PH = re.compile(r"\{\{\s*([^{}]+?)\s*\}\}")
ph = sorted(set(PH.findall(doc)))
row_nums = sorted({int(m[0]) for m in re.findall(r"\{\{\s*s(\d+)_([a-z]{2})\s*\}\}", doc)})

print("零件数：", len(parts))
print("全部零件合计：", sum(len(v) for v in parts.values()), "字节")
print("占位符种类：", len(ph), "->", ph)
print("进度表样板行编号：", row_nums)

L = []
L.append("/**")
L.append(" * 自动生成，请勿手改！")
L.append(" * 来源：public/tools/plan-generator/模板-占位符.docx")
L.append(" * 重新生成：python public/tools/plan-generator/build-template-data.py")
L.append(" *")
L.append(" * 把《辅导计划》Word 模板的所有零件以 base64 内嵌，浏览器无需解压即可直接使用。")
L.append(" */")
L.append("(function (root, factory) {")
L.append("  if (typeof module === 'object' && module.exports) module.exports = factory();")
L.append("  else root.%s = factory();" % GLOBAL_NAME)
L.append("}(typeof self !== 'undefined' ? self : this, function () {")
L.append("  'use strict';")
L.append("")
L.append("  /** 零件顺序 = 原 zip 内顺序，重新打包时保持一致 */")
L.append("  var ORDER = " + json.dumps(names, ensure_ascii=False) + ";")
L.append("")
L.append("  /** 各零件 base64 */")
L.append("  var B64 = {")
for n in names:
    L.append('    ' + json.dumps(n, ensure_ascii=False) + ': "'
             + base64.b64encode(parts[n]).decode("ascii") + '",')
L[-1] = L[-1].rstrip(",")
L.append("  };")
L.append("")
L.append("  var TEXT_PARTS = {};")
L.append("  function isText(n) { return /\\.(xml|rels)$/i.test(n); }")
L.append("")
L.append("  function b64ToBytes(b64) {")
L.append("    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));")
L.append("    var bin = atob(b64), out = new Uint8Array(bin.length);")
L.append("    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);")
L.append("    return out;")
L.append("  }")
L.append("  function utf8Decode(u8) {")
L.append("    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(u8);")
L.append("    return Buffer.from(u8).toString('utf8');")
L.append("  }")
L.append("  function utf8Encode(s) {")
L.append("    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);")
L.append("    return new Uint8Array(Buffer.from(s, 'utf8'));")
L.append("  }")
L.append("")
L.append("  function getText(name) {")
L.append("    if (TEXT_PARTS[name] != null) return TEXT_PARTS[name];")
L.append("    if (!B64[name]) throw new Error('模板里没有零件：' + name);")
L.append("    TEXT_PARTS[name] = utf8Decode(b64ToBytes(B64[name]));")
L.append("    return TEXT_PARTS[name];")
L.append("  }")
L.append("  function getBytes(name) {")
L.append("    if (B64[name] == null) throw new Error('模板里没有零件：' + name);")
L.append("    return b64ToBytes(B64[name]);")
L.append("  }")
L.append("  function setText(name, s) { TEXT_PARTS[name] = s; }")
L.append("  function reset() { TEXT_PARTS = {}; }")
L.append("  /**")
L.append("   * 组装最终零件表 [{name, data}]")
L.append("   * @param {object} [overrides] 本次覆盖的零件 {零件名: 明文}；不写回模块状态，可反复调用")
L.append("   */")
L.append("  function collect(overrides) {")
L.append("    overrides = overrides || {};")
L.append("    var files = [];")
L.append("    ORDER.forEach(function (n) {")
L.append("      if (B64[n] == null && overrides[n] == null) return;")
L.append("      var data;")
L.append("      if (overrides[n] != null) data = utf8Encode(overrides[n]);")
L.append("      else if (TEXT_PARTS[n] != null) data = utf8Encode(TEXT_PARTS[n]);")
L.append("      else data = b64ToBytes(B64[n]);")
L.append("      files.push({ name: n, data: data });")
L.append("    });")
L.append("    return files;")
L.append("  }")
L.append("")
L.append("  return { ORDER: ORDER, getText: getText, getBytes: getBytes, setText: setText,")
L.append("           reset: reset, collect: collect, isText: isText,")
L.append("           utf8Decode: utf8Decode, utf8Encode: utf8Encode, b64ToBytes: b64ToBytes,")
L.append("           PLACEHOLDERS: " + json.dumps(ph, ensure_ascii=False) + ",")
L.append("           LESSON_ROWS: " + json.dumps(len(row_nums)) + " };")
L.append("}));")

with io.open(OUT_JS, "w", encoding="utf-8", newline="\n") as f:
    f.write("\n".join(L) + "\n")

print("已写出：", OUT_JS, os.path.getsize(OUT_JS), "字节")

# ---------- 自检：base64 往返无损 + 零件清单一致 ----------
_src = io.open(OUT_JS, encoding="utf-8").read()
bad = []
for n in names:
    m = re.search(r'^\s*' + re.escape(json.dumps(n, ensure_ascii=False)) + r': "([A-Za-z0-9+/=]*)"',
                  _src, re.M)
    if not m:
        bad.append((n, "生成文件里找不到该零件"))
        continue
    if base64.b64decode(m.group(1)) != parts[n]:
        bad.append((n, "base64 往返后不一致"))

print()
if bad:
    print("[FAIL] 自检失败：")
    for n, why in bad:
        print("   ", n, "->", why)
    raise SystemExit(1)
print("[OK] 自检通过：", len(names), "个零件 base64 往返全部一致")
print("[OK] 占位符", len(ph), "种；进度表样板行", len(row_nums), "行")
