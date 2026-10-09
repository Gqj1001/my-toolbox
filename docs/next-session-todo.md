# 下个会话待办

> 更新时间：2026-10（阶段4 math-plan 接入统一学生 API 的那一笔）。
> **已完成的条目已删除**，这里只剩还没做的。
> 配套阅读：`docs/project-overview.md`（现状总入口）、`docs/dsh-work-guide.md`（配合方式）、
> `docs/perf-notes.md`（性能完整记录）。
>
> 每条都写了「为什么」和「怎么验」，**不要只照标题做**。

---

## 1. ✅ 阶段 4：math-plan 接入统一学生 API（**已完成 2026-10**）

> 这一条做完了，**不要再做一遍**。留下的结论与新待办见下面「已完成」与「1b」。

### 已完成（做了什么）

1. `public/tools/math-plan.html` 的「① 学生与考区」多了一排**已保存学生的小圆片**
   （点一下带出 年级/校区/教师/学段/教材/考区）+ 一个「💾 保存档案」。
   **只在 `/tools/math-plan.html` 下出现**（双击 HTML、放到别的服务器上行为不变）。
2. 数据层照 paper 的模板抄：`CLOUD_STORE`（`loadAll` / `deleteStudent`）+
   `persistStudent`（**唯一的写入口**）/ `removeStudent`。
   ⚠️ 刻意**没有**在 `CLOUD_STORE` 里再放一个 `saveStudent` —— 那会变成
   「同一件事有两个来源」（本项目反复踩过的坑），迟早有一份忘了合并 `extra`。
3. **只存学生身份**：`name/grade/campus/teacher` + `extra` 里的 `phase/book/exam`。
   分数 / 目标分 / 课时 / 频次 / 薄弱模块 / 已完成模块 / 备注 **一个都不进档案**
   （它们是「这一次方案」的参数）。测试有双重防护：点名查这些键，
   **并且**断言 `extra` 里没有数字型值（身份字段全是字符串）。
4. ⚠️ **`extra` 是整块替换、不是按键合并** —— 合并语义只保护顶层列。
   所以 `persistStudent()` 先 `loadAll()` 读回旧行、展开旧 `extra`，再盖自己的三个键。
   少了这一步，老师用一次辅导方案就会把 paper 的 `extra.cls` 抹掉
   （有变异测试证明这条断言真的会 FAIL，不是空过）。
5. 顺手修掉一个真实 bug（`src/app/api/students/route.ts`）：
   `op:"import"` 的 `tool` 原来是「缺省按 paper」→ 会把**将来接进来的工具**的数据
   **静默标成 paper**（接口 200、归属错、不报错）。现在白名单外的值一律 400，
   混着传时「好的进、坏的条数如实报」(`rejectedTool`)。`tests/math-plan-students.test.mjs`
   与 `tests/students-unified.test.mjs` 都钉住了。
6. 顺手把左侧底部那句「不上传任何数据」改成实话（点保存会上传学生身份，
   但不上传分数/课时）—— 原文与实际行为不符。

### 测试

- 新增 `tests/math-plan-students.test.mjs`（29 项，真服务 + 真浏览器）：
  选学生带出信息、**只存身份字段**、刷新不丢、**两家工具的 `extra` 键同时活着**、
  `import` 的 `tool` 校验、**本机模式（`file://`）行为一行没变**。
  ⚠️ 它自己起 `next start`，**会杀 3000 端口**，别和别人并行跑。
- 扩 `tests/students-unified.test.mjs`：补「阶段4」组（两家工具的 `extra` 键同时活着、
  `import` 的 `tool` 校验）；合并语义组原样保留。**62 项**。
- 顺手把 `students-unified` 里两条**写死数字**的断言改成**相对口径**
  （见「怎么验」——这正是 `dsh-work-guide.md` 坑 1 说的那种假红）。

### ⚠️ 1b. 留下的两件（**不在本轮范围**）

| # | 事项 | 说明 |
|---|---|---|
| a | **math-plan 不写历史记录** | `feedback_history.tool` 的 CHECK 只允许 `('feedback','paper')`（`0014` 第 93 行）。想让 math-plan 也存「方案历史」，**必须先跑一条迁移**放宽约束，**再**改接口与前端 —— 两步缺一不可（只改接口会在写库时撞约束）。SQL 见下面「1c」。 |
| b | 接口层的 `extra` 仍是整块替换 | 现在靠**每个工具自己**先读旧值再合并。将来若要根治，应当让服务端把 `extra` 也做成**按键合并**（或在 `buildStudentRow()` 里合并 `extra`），这样任何工具少写一句都不会踩别人。 |

### 1c. 「方案历史」要用的迁移 SQL（**已写好，还没执行**）

只在用户明确要做「方案历史」时，才让他去 **Supabase 的 SQL Editor** 里逐字跑：

```sql
-- 把 feedback_history.tool 的合法值放开到 math-plan（0014 原本只允许 feedback/paper）
alter table public.feedback_history drop constraint if exists feedback_history_tool_check;
alter table public.feedback_history
  add constraint feedback_history_tool_check
  check (tool in ('feedback', 'paper', 'math-plan'));
```

⚠️ **跑完 SQL 只是第一步**，还要把 `src/app/api/students/route.ts` 里的
`ALLOWED_TOOLS` 数组加上 `"math-plan"`，否则接口仍然拒绝。
那条白名单是**故意**的：它防的是「没登记的工具被**静默标成 paper**」。
两边都改完才通；只改一边要么写库撞约束、要么接口 400。

---

## 2. vision-scores 启用态测试（半天）

**为什么**：答题卡识别的**路由与前端都完整**（逐项查过，见下），
但**「启用之后」那条路径从来没有被执行过** —— 现有测试只覆盖两条降级路径。
**你配好 `AI_VISION_MODEL` 打开开关那一刻，是这条路径第一次真正跑起来。**

### 已经查过、**不需要改**的部分

| 项 | 结论 |
|---|---|
| `src/app/api/paper-analysis/vision-scores/route.ts` | 235 行，完整 |
| 入参 / 出参 | `{image:"data:image/...", questions:[...], model?}` → `{ok:true, scores:[{no,got}]}` |
| thinking 护栏 | ✅ **只有模型名含 `deepseek` 才带** `thinking:{type:"disabled"}`；另有 `AI_VISION_SUPPORTS_THINKING=0` 紧急开关 |
| 错误处理 | 401 / 403(非会员) / 403(封禁) / 503(未配模型，给明确提示) / 413 / 400 / 502 / 超时；思考吃光预算会重试一次 |
| 图片位置 | ✅ 只放 **user** 消息（官方要求：放 system/assistant 会 400）—— 核对过官方文档 |
| 前端 `photoRun()` | ✅ `public/tools/paper-analysis/js/app.js`；按钮 `index.html:129`；API 路径正确 |
| `mode` 路由暴露 `visionModel` | ✅ `src/app/api/paper-analysis/mode/route.ts:41`（**这是启用的关键依赖，通的**） |

### 要补的测试

起一个**桩上游**（本地小 HTTP server 冒充 `{baseUrl}/chat/completions`），
用 `AI_VISION_BASE_URL` 指向它（**这个环境变量已存在，不需要改产品代码**）。断言：

1. 请求体里 `content` 是**数组**、`image_url` 块在 **user** 消息里（system 只有文本）；
2. 模型名含 `deepseek` → 请求体**带** `thinking`；
   模型名不含 deepseek（如 `glm-4v-flash`）→ **不带** `thinking`
   （防止将来有人改成无条件带，那会直接 400）；
3. 桩返回 `{"scores":[{"no":1,"got":5}]}` → 响应 `ok:true` 且 `scores` 正确；
4. 桩返回**非 JSON** → `ok:true` 但 `scores:[]` 且带 `raw`（**不 500**）；
5. 未配 `AI_VISION_MODEL` → 仍返回 503（现有断言，保留）。

> ⚠️ 提醒用户：识别结果**必须人工核对**；模型会把看不清的题**直接省略**
> （prompt 明确要求「看不清不要猜」），所以「识别出 15 道题」≠「其余 5 道是 0 分」。

---

## 3. ⚠️ 悬着的问题：feedback.html「下载 10 秒」（需要 HAR）

**用户报的现象**：`feedback.html` 42.8 KB，Content download 花了 **10.31 秒**
（等待服务器响应只有 504ms）。

**已经查到的（2026-10）**：
- **不是 A-2 引入的**：A-2 提交（`6ccfcc3`）与它的父提交在本地**输出逐字一致**。
- **服务端正常**：线上实测 `feedback.html` 首字节 **145ms**、总 **247ms**，
  `Cache-Control: public`（没被改过）。171,933 字节未压缩 ≈ 用户看到的 42.8 KB。
- 42.8 KB ÷ 10.31 秒 ≈ **4 KB/s** —— 这个量级像是**链路**问题，不是服务器。
- 顺带发现：`/api/feedback/data` **冷启动 5.4 秒**（第二次 408ms）—— 独立问题，与本条无关。

**下一步**：要用户给一份 **HAR**（F12 → Network → 右键 → Save all as HAR），
才能判断是 CDN、运营商还是别的。**没有 HAR 不要再猜。**

---

## 4. `/tools` 改个人中心 + `/dashboard` 改 redirect（半天）

两页 99% 重复（都渲染同一个 tool-grid）。`/tools` 挂上会员状态卡 + 退出登录，
`/dashboard` 改成自动跳转。

---

## 5. 全学科扩展（等触发条件）

从**物理**试水（与数学最接近），跑通后把「科目配置」抽出来，再横向复制到其他学科。
详细清单见 `docs/other-subjects-plan.md`。
**触发条件**：有物理老师主动要，或数学用稳 2–3 周。依赖：每科要 10–15 份学科网报告。

---

## 6. 其余待办（原清单里还没做的）

| # | 项 | 备注 |
|---|---|---|
| 7 | 空壳工具清理 | `json-formatter` / `password-generator` 已下线（`0012`），但代码文件还在 `public/tools/` 里。触发条件：确认不再需要 |
| 8 | few-shot 效果评估 | 触发条件：累计用 AI 润色 20–30 次后 |
| 9 | 深度优化 AI 润色（调温度/prompt） | 可选 |
| 11 | feedback 离线模式入口 | 可选（现在云端拉不到就是空页面，是**有意**的） |
| 12 | `DEFAULT_MODEL = "deepseek-chat"` 改 `deepseek-flash` | 已用 Vercel 的 `AI_MODEL` 覆盖，属技术债清理 |

**长期（现在不做）**：自动支付、会员使用统计、全站数据导出、多老师团队模式、更换服务器架构（国内备案）。

---

## 7. 已知问题（记录，修不修都行）

1. **非法 ISO 日期会被原样写库 → 500**（`2026-13-45` 这种）。
   详见 `docs/perf-notes.md`「七、已知问题」。**按用户要求未修**。
   修的时候 `tests/date-input.test.mjs` 的老实现副本会红 —— 那是预期的。
   （注：`2026年10月7日` 那类**不是**这个问题，阶段 3 已支持。）
2. **`tools` 表的建表语句不在仓库里**（只有种子数据），
   会员那三列（`plan`/`status`/`expires_at`）的加列语句也不在。
   **不要试图用仓库的 SQL 重建数据库。**
3. **换工具权限 / 下线工具没有后台界面** —— 只能去 Supabase SQL Editor 手工跑
   （照 `0012` 的写法）。改完最多 30 秒全站生效（`tools` 表有 30 秒进程内缓存）。
4. **`tests/feedback-data-cache.test.mjs` 与 `tests/math-plan-ai-vip-path.test.mjs`
   会杀 3000 端口**，别和其它真服务套件并行跑。
5. **`tests/step7-ui.test.mjs` 隔离弱点**：按关键词查全表，会被上次运行遗留数据污染。
6. **Edge 调试端口会被「幽灵监听者」占住**（2026-10 踩过一次）：
   `Get-NetTCPConnection` 列得出 9490 在监听、PID 却是个**不存在的进程**，
   新起的 Edge 绑不上 → 真浏览器套件统一报 `无法连接 Edge 调试端口`。
   **重启机器**即可（换端口也行）。不是代码问题。

---

## 8. 环境备忘（新会话不用再问用户）

| 项 | 值 |
|---|---|
| 仓库 | `D:\my-website\my-toolbox`（注意：工作目录可能是 `D:\my-website`，**仓库在子目录里**） |
| git | `D:\my-website\.tools\git\cmd\git.exe`（**不在 PATH**） |
| 线上 | `https://010034.xyz` |
| 测试账号 | `roleb`=VIP（`userEmail`）、`rolea`=免费/管理员（`adminEmail`） |
| 跑测试 | `C:\Users\郭庆杰\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe tests\<套件>`；**先 `next build`** |
| 推送 | 先 `git push origin main`；若 `github.com:443` 不通（会超时 300 秒），用 `node scripts\push-via-api.mjs` |
| 三份交接文档 | `docs/project-overview.md`、`docs/dsh-work-guide.md`、`docs/perf-notes.md` |
| 本文件 | `docs/next-session-todo.md` |

**全套回归现状（2026-10 阶段4 本轮实测，24 个套件全绿 ✅）**：

```
math-plan-template 82/82   math-plan-lessons 44/44   math-plan-students 29/29
math-plan-ai-apply 20/20   middleware-cache 13/13    verify-checklist 18/18
step7-api 39/39            step7-ui 36/36            ai-thinking-mode 11/11
paper-analysis 56/56       paper-regression 18/18    paper-score-edit 59/59
paper-score-report 15/15   paper-score-ui 36/36      paper-preset 18/18
paper-analysis-students 27/27
feedback-data-cache 26/26  feedback-client-cache 51/51
students-unified 62/62     date-input 11/11          admin-grant90 18/18
math-plan-ai-sections 26/26  math-plan-ai-vip-path 17/17
math-plan-export-ui 18/18
```

> ⚠️ **一次只跑一个 runner；看到「端口类失败」先怀疑端口被抢**。
> 本轮我同时起了两个 runner，`ai-thinking-mode` 直接变 **0/11**（请求被别人的服务回答，
> 回来 503「未配置 AI Key」），而代码是好的。重跑就 11/11。
> 需要外部服务的套件已固化成 `tests/_run-ui-suites.mjs`（会先等 3000 空出来再跑）：

```powershell
& "<bundled node>" tests\_run-ui-suites.mjs
```

> ✅ `math-plan-ai-apply` 与 `verify-checklist` 上一轮**重启机器后已补跑通过**，
> 之前那次失败是 Edge 调试端口的幽灵监听者（见「已知问题」第 6 条），不是代码问题。
