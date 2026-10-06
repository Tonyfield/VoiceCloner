# VoiceCloner WebApp 架构说明

适用范围：`VoiceCloner/webapp`（`server` = Node/TypeScript + Express + node:sqlite；`client` = React + Vite + Ant Design）。
本文件描述分层、模块边界与数据流；新增代码请落到对应层，不要把职责混在一起。

## 1. 总览

```
浏览器 (React SPA)
   │  HTTP / JSON / multipart
   ▼
Express 路由层  ──►  服务层（业务编排）  ──►  基础设施（SQLite / 文件系统 / TTS HTTP / 进程）
                          ▲
                          └── shared（无状态的通用工具）
```

两条硬性约束：
- **路由只做 HTTP**：解析请求、调用服务、返回响应；不直接访问数据库、不写业务规则。
- **服务只做业务/IO**：不感知 `express`（不引用 `Request`/`Response`）。目前唯一例外是 `shared/errors.ts` 的 `sendError` 接受 `Response`（属响应工具，见下）。

## 2. 服务端分层（`webapp/server/src`）

| 层 | 目录 | 职责 | 允许依赖 |
|---|---|---|---|
| 入口 | `main.ts`, `app.ts` | 启动、装配中间件与路由、静态资源、全局错误处理 | 全部 |
| 配置 | `config.ts`, `logger.ts` | 路径/端口/JWT 等常量；日志 | node 内置 |
| 路由 | `routes/*.ts` | HTTP 契约：参数校验、状态码、调用服务 | services, shared, logger |
| 服务 | `services/*.ts` | 业务编排与领域逻辑 | db, shared, logger, 其它服务 |
| 认证 | `auth/*.ts` | JWT 签发/校验、密码哈希、鉴权中间件 | node 内置 |
| 通用 | `shared/*.ts` | 无状态工具：错误、JSON、布尔归一化 | node 内置 |
| 基础设施 | `db/database.ts` | SQLite 连接、建表、初始账号 | config, auth/password |

### 模块清单

**HTTP**
- `app.ts` — 组合根：CORS、请求日志、`express.json`、挂载 `/api/{auth,models,voices,tasks}`、静态前端、错误处理。
- `routes/tasks.ts` — 任务全量接口（增删改查、prepare、run、分段、注音、合成、合并）。
- `routes/models.ts` / `routes/voices.ts` / `routes/auth.ts` — 模型、声音、登录/改密/me。

**业务服务**
- `services/authService.ts` — 用户认证与改密（`routes/auth.ts` 不再直接写 SQL）。
- `services/modelService.ts` — TTS 模型 CRUD + `parameters_schema_yaml` 解析（`parseParamSchema`）。
- `services/voiceService.ts` — 声音样本 CRUD + 文件读写。
- `services/taskService.ts` — 任务持久化、任务目录/文件路径、`intermediate.json` 读取（带 mtime 缓存）、分段与音频键。
- `services/taskRunner.ts` — 任务编排：`prepareTask` / `synthesizeTask` / `synthesizeSegment` / 停止 / 暂停 / 恢复、合成队列。
- `services/segmentBuilder.ts` — 分段键补零/排序、`intermediate.json` 组装。
- `services/segmenter.ts` — 文本切分（`splitText`）；`services/segmentWorker.ts` 为 worker 线程入口。
- `services/documentService.ts` + `services/extract/*` — 按扩展名提取正文（txt/html/epub/pdf/docx + `cleanText`）。
- `services/phonetic.ts` + `services/cedict.ts` + `services/jieba.ts` — 注音 XML、CC-CEDICT 最长匹配、jieba 分词边界。

**TTS / 音频**
- `services/ttsParams.ts` — **单一事实来源**：TTS 顶层键集合、任务级内部键集合、随机种子哨兵。
- `services/textEnhance.ts` — 分段文本增强（通用，可链式 `TextEnhancer`）：专有名词替换 / 正则插入 / 分词间隔 / 感叹词前缀。
- `services/ttsClient.ts` — `buildPayload`（业务变换）+ HTTP/SSE 客户端 + WAV 头修复。
- `services/audioFiles.ts` — 音频命名与内容 hash：`<分段key>-<注音后文本hash>.<ext>`；重新分段按 hash 复用旧音频。
- `services/audioMerger.ts` — 音频合并：同格式直拼（WAV 重建头 / mp3 直拼），其它走 ffmpeg。
- `services/exporter.ts` — 导出：`POST /api/tasks/:id/export`（scope=chapters|selected，format=mp3|wav|zip）。
  每章/选中 + mp3|wav 先合并，再用 `adm-zip` 打成 zip（每章一个音频）；`zip` 则按「章名/分段音频」打包。选中分段 + mp3|wav 直接返回单个音频文件。
- `services/retry.ts` — `withRetry`：失败后 10s/20s/30s 退避重试（最多 3 次）；停止/暂停（`signal.aborted`）不重试。
- `services/errorService.ts` — 任务错误历史（`task_errors` 表）：重试耗尽后 `record`，供 `GET/DELETE /api/tasks/:id/errors` 查询/清除；`/status` 返回 `error_count`。
- `services/segmentLogService.ts` — 分段标记与关键步骤记录：
  - `segment_marks`：点赞/点踩（点踩可附反馈，反馈可为空），`PUT /api/tasks/:id/segments/:key/mark`、`GET /api/tasks/:id/marks`；
  - `segment_steps`：**分段**（长度）/ **注音**（输入+结果）/ **合成**（送出的文本、耗时、HTTP 状态、报错），时间由 `created_at` 记录，`GET /api/tasks/:id/segments/:key/steps`；
  - `POST /api/tasks/:id/search` 支持 `mark` 过滤（可按「已点赞/已点踩」筛选分段，`query` 可为空）。
- 音频归属由服务端权威给出：`taskService.segmentHashes`（按 intermediate mtime 缓存）/ `audioNameMap`，经 `GET /api/tasks/:id/audio-map` 提供给前端（同序号多 hash 时只认当前内容 hash）。

**通用**
- `shared/errors.ts` — `getErrorMessage(error)`、`sendError(res, status, error)`：统一 `{ error }` 响应。
- `shared/json.ts` — `asRecord`、`parseJsonObject`、`parseBooleanFlag`：统一的解析/归一化。

## 3. 客户端分层（`webapp/client/src`）

| 层 | 文件 | 职责 |
|---|---|---|
| 入口 | `main.tsx` | Provider 组装（主题 → antd ConfigProvider → Router → Auth → App） |
| 壳 | `App.tsx`, `auth.tsx`, `theme.tsx` | 登录门禁、导航、路由表；认证与明暗主题上下文 |
| 传输 | `api/client.ts` | axios 实例 + 拦截器 + 全部领域类型与端点函数 |
| 工具 | `lib/*` | `session.ts`（token/用户持久化）、`errors.ts`、`taskStatus.ts`、`phoneticMarks.ts` + `pinyinSyllables.ts`（注音 XML 与拼音校验） |
| 钩子 | `hooks/*` | `usePolling.ts`（活跃时按固定间隔轮询） |
| 页面 | `pages/*` | 路由级页面：登录、任务列表、模型、声音、用户设置 |
| 组件 | `components/*` | `SegmentRow.tsx`（单段编辑/注音/合成）、任务表单、任务工作界面、动态参数表单、设置页骨架 |

### 参数设置页（重点）

```
TaskForm.tsx             任务弹窗：页头（名称 / TTS 模型 / 重置 / 保存）+ 分隔线 + 设置区
├─ settings/SettingsShell.tsx   左 Tab 栏(200px) + 右面板；面板常驻渲染，切换保留滚动位置
├─ settings/SettingRow.tsx      SectionHead / SettingRow + Select 宽度估算（selectWidth/inputCh）
├─ settings/settings.css        .st-* 设计 token、两列 Grid、响应式（1100/900/680）
├─ DynamicParamForm.tsx         按模型 schema 渲染参数行（label 列 + 控件列）
└─ paramGroups.ts               参数 key → 页签映射（输入/输出/分段参数/注音参数/指令/感情/高级）
```

参数元数据的**单一事实来源**是后端返回的模型 `schema.params`；`paramGroups.ts` 只描述「key 属于哪个页签」和隐藏项。新增参数时改模型 schema（`ModelsPage` 的 `DEFAULT_SCHEMA` 为模板），不要在组件里硬编码控件。

## 4. 关键数据流

**任务全生命周期**

1. `POST /api/tasks` — 上传文档 + 参数 → `taskService.create`（写 DB 与 `tasks/<id>/uploads/`）。
2. `POST /api/tasks/:id/prepare` — `taskRunner.prepareTask`：提取正文 → worker 线程 `splitText` → 写 `intermediate.json`（状态 `segmented/ready`）。
3. `POST /api/tasks/:id/run` 或 `/:id/segments/:key/synthesize` — `taskRunner` 逐段调用 `buildPayload` + `synthesizeText`，写入 `tasks/<id>/<分段key>-<内容hash>.wav`；`skipExisting=true` 时跳过已有内容匹配音频的分段。
4. `POST /api/tasks/:id/export` — `services/exporter.ts` 导出：每章 / 选中分段的 mp3|wav（合并）或 zip（打包分段音频）。

> 抽取 → 分段 → 注音 → TTS 载荷的逐阶段细节与函数调用位置见
> [`docs/epub-to-indextts-pipeline.md`](docs/epub-to-indextts-pipeline.md)。

**TTS 载荷构建（`ttsClient.buildPayload`）**

模型 schema 默认值 ∪ 任务参数 → 剔除 `shared`/`ttsParams` 定义的内部键 → 顶层键直发/其余进 `extra_params` → 情感模式互斥展开（`emotion_mode` = `text|random|vector`）→ `seed=-1` 转随机 → 流式与 `response_format` 协调（非 pcm/wav 自动关流式）。

## 5. 横切关注点

- **错误**：服务抛 `Error`，路由用 `sendError(res, status, e)` 统一成 `{ error }`；客户端统一走 `lib/errors.ts` 的 `getErrorMessage`。禁止各处重复实现。
- **日志**：服务端统一 `logger`（winston）；请求日志在 `app.ts`。
- **认证**：`auth/middleware.ts` 的 `requireAuth` 注入 `req.auth`；令牌在客户端存于 `localStorage`（`api/client.ts` 的 `TOKEN_KEY`）。
- **配置**：所有路径/端口/开关集中在 `config.ts`，不散落魔法字符串。

## 6. 约定（新增代码请遵守）

1. **分层不越界**：路由不碰 DB/文件；服务不引 express；共享工具无状态。
2. **单一事实来源**：参数键集合 → `ttsParams.ts`；错误响应 → `shared/errors.ts`；任务状态文案与门禁 → 客户端 `lib/taskStatus.ts`。
3. **不支持向前/向后兼容**：不保留旧字段回退、旧格式解析、旧接口分支。数据格式变更时直接改当前实现（必要时清理旧数据），不要写兼容分支。
4. **删除优于保留**：无引用的导出、未使用的样式、注释掉的代码一律删除。
5. **路径统一**：任务目录下的文件路径一律经 `taskService` 的路径函数，不要各自拼 `path.join(TASKS_DIR, ...)`。
6. **测试就近存放**：测试与实现同目录（`src/**/*.test.ts`），`npm test`（`tsx --test`）运行。`npm run typecheck`（基础 `tsconfig.json`）覆盖测试；`npm run build` 使用 `tsconfig.build.json` 排除测试，产物 `dist` 不包含 `*.test.js`。

## 7. 重构进度与剩余技术债

**已完成**
- `SegmentRow` 从 `TaskDetail.tsx` 拆出为 `components/SegmentRow.tsx`（TaskDetail 由约 1600 行降到约 1210 行）。
- 轮询：`TasksPage` 改用 `hooks/usePolling.ts`；状态元数据与门禁集中在 `lib/taskStatus.ts`（`STATUS_META` / `needsPrepare` / `isSkipTtsBlocked`）。
- 会话：token 与当前用户统一走 `lib/session.ts`，刷新后不再丢用户名；401 由 axios 拦截器统一清理会话。
- 导航高亮由路由派生（`App.tsx` 使用 `useLocation`），刷新/前进后退保持一致。
- 拼音音节表移出 `phoneticMarks.ts`，独立为 `lib/pinyinSyllables.ts`。
- 参数展示文案覆盖集中到 `paramGroups.ts` 的 `PARAM_PRESENTATION`（单一维护点）。

**剩余**
- `TaskDetail.tsx` 仍约 1210 行：可继续拆出 `useTaskPolling`（其轮询是「忙碌状态驱动的链式 timeout」，与 `usePolling` 的固定间隔不同）、章节加载、选择/工具栏为独立 hook 或子组件。
- `TaskDetail` 内部仍有重复片段：注音下拉（禁用/启用两段）、Empty 刷新块、`setInfo` + `pollStatus` 模式。
- `lib/phoneticMarks.ts` 仍混合解析、渲染与校验，可再按职责拆分。
