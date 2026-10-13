# 新会话开场提示词（复制下面整段粘给新会话）

> 用途：上下文太重时换新会话，用这段把"你是谁、规矩、现状、下一步"一次交代清楚。
> 维护：每批结束时**顺手更新**「当前状态」与「下一步」两节；其余部分很少变。

---

我在做一个给培训机构老师用的网站（My Toolbox，线上 010034.xyz），请接手继续开发。
下面是你需要知道的一切。

【项目与路径】
- 仓库：`D:\my-website\my-toolbox`（注意：工作目录可能是 `D:\my-website`，**仓库在子目录里**）
- 线上：https://010034.xyz （Next.js 16.3.8 + Supabase + Vercel）
- 技术：Next.js App Router；**工具本体是 `public/tools/` 下的静态 HTML**（Next 页面用 iframe 承载）
- 三个工具：高中数学辅导方案生成器 / 试卷分析工作台 / 课后反馈工作台

【第一件事：按顺序读这 4 份文档，读完再动手】
1. `docs/project-overview.md` —— 现状总入口（有哪些工具、公共设施、隐患、最近完成、待办）
2. `docs/dsh-work-guide.md` —— 怎么跟我配合 + **踩过的坑清单**（13 条，能省你几小时）
3. `docs/next-session-todo.md` —— 下一轮该做什么（每条都有「为什么」和「怎么验」）
4. `docs/company-export-plan.md` —— 公司模板导出那摊事的方案（含一键关掉/彻底撤销、后台功能开关）
   要改某个工具的细节，再读 `docs/math-plan-handoff.md` / `docs/paper-analysis-handoff.md`

【我是谁 / 怎么跟我沟通】
- 我**不是程序员**：请用**大白话**，别堆术语；必须用的术语顺手解释一句
- 关键决策**给我选项**（A/B/C + 你的推荐与理由），**别自己拍板**
- **改代码前先给方案**（写进文档也行），我说"开工"再动手；大的改动先小步验证
- 做完**停在 push 前**，我确认后你再推 —— 我很看重这个节奏
- 发现我之前的判断有问题**直接说**，不要顺着我

【硬性规矩（都是踩过坑总结的）】
- git **只点名文件** `add`，**绝不用 `git add -A`**；不要碰这四个未跟踪文件（别的会话的）：
  `public/tools/math-viz.html`、`src/app/tools/math-viz/`、`supabase/migrations/0013_seed_math_viz_tool.sql`、
  `进度与待办-阶段4后.md`
- **要动数据库表结构 / 跑 SQL：先停下问我**，别自己执行（迁移文件写进 `supabase/migrations/`，我来跑）
- 改动前先 `next build`；**一次只跑一个测试 runner**（同时跑会假红）
- 改完必须：① 加/改测试（**真 bug 要有变异自证**：把修复退回去，断言必须红）② 跑全套回归 ③ 顺手改文档
- 服务端调 AI：只有模型名含 `deepseek` 才带 `thinking:{type:"disabled"}`；上游错误**不要**透传
- **别用 PowerShell 的 `Get-Content`/`Set-Content` 改源码**（会把编码写坏，用编辑工具）；
  测试里跑 python 要带 `PYTHONIOENCODING=utf-8`（否则中文断言假红）
- **不要重复提醒我"狮子云代理"那件事**（我自己已经处理完了）

【当前状态（2026-10 第十三批结束时）】
- 全站 **33 个测试套件 / 1047 项断言全绿**
  （跑法：先 `next build`；纯函数/自带服务的套件直接跑 `tests/<套件>`；
   需要外部服务的 6 套 + 自带服务的 1 套用 `tests\_run-ui-suites.mjs`）
- 最近三批都是**新增模块**（红线：现有生成逻辑**一行没改**）：
  · 第十二批：**🏢 公司模板导出（附件1/2）** —— 以公司 docx 为底、按标签替换文字（见方案文档）
  · 第十二批：**一键开关三种关法**（改常量 / `?nocompanyexport=1` / localStorage）
  · 第十三批：**⚙️ 通用功能开关搬到管理后台**（新表 `feature_flags` + `/admin`「功能开关」
    + 服务端把关闭参数拼到 iframe 的 src 上 ⇒ 工具页代码不用改）

【下一步（按优先级；细节见 `docs/next-session-todo.md`）】
1. 🔴 **公司模板导出 · 附件3 接线**（math-plan 侧）：模板与引擎**已就绪**
   （`docs/company-template/附件3.docx` + `public/tools/company-template/company-docx.js` 已支持三个附件），
   只缺 math-plan 的数据组装 + 导出按钮。约半天。
2. 🟠 等我给**真实素材**的验收反馈（公司模板导出的 Word 排版、学校卷子/报告截图的识别质量、合并润色）
3. 🔴 我可能已经跑了 `supabase/migrations/0018_feature_flags.sql`（**不跑也安全**）——
   若跑了，`tests/admin-feature-flags.test.mjs` 会自动从"分支 A"切到"分支 B"，真测开关的关/开
4. 🔴 `public/tools/*.html` 里"本机模式"的默认模型名还有 **7 处**是已停用的 `deepseek-chat`
   （那是工具会话地盘，**我说动再动**）
5. 🔵 第二批：把「工具上下线 / 换权限」也搬进后台（同一套 UI，`tools.active` 本来就存在）
6. ⏳ 等触发：**题干**（学科网报告里没有题干，只对"拍整张卷子"那条路可行；用户已定先不做）、
   **全学科扩展**（先物理试点）
7. 🚫 长期不做：自动支付、会员使用统计、全站数据导出、多老师团队模式、换服务器架构（备案）、
   引第三方 OCR

【环境速查】
- node（跑测试）：`C:\Users\郭庆杰\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`
- python（读/写 docx）：`…\dependencies\python\python.exe`（自带 python-docx）
- git（**不在 PATH**）：`D:\my-website\.tools\git\cmd\git.exe`
- 推送：先 `git push origin main`；若 `github.com:443` 超时/被重置，用 `node scripts\push-via-api.mjs`
  （它会打印 `git update-ref` 对齐命令；注意它的 commit sha 会变、**内容一致**）
- 测试账号：`roleb`=VIP、`rolea`=免费+管理员（见 `tests/.test-users.json`）

开工前先跟我确认一件事：**这一轮你想让我做哪一项**（我默认建议先做附件3 接线）。
