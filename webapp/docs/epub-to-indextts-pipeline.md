# 设计文档：EPUB → IndexTTS 输入文本处理管线

范围：`VoiceCloner/webapp`（TypeScript 实现，当前维护版本）。
文末附 Python CLI（`clone-voice-v6`）的等价实现位置。

## 1. 目标与约束

把上传的文档（重点：EPUB）转成可逐段送进 IndexTTS 的**分段文本**，并在需要时附带**注音表达**。

关键约束：

- **保留段落结构**：EPUB 的每个 HTML part（章）→ 物理行（`<p>`）是分段与合并的基本单位，不被随意跨段粘连。
- **长度可控**：每段不超过 `max_chars_per_segment`（默认 100），超长按句/标点强制切分。
- **注音与分词对齐**：注音标记必须完整覆盖一个或多个 jieba 分词，避免标签落在词内部。
- **不阻塞 HTTP**：抽取 + 分段在 worker 线程执行。

## 2. 管线总览

```
上传文件
  │  POST /api/tasks                      routes/tasks.ts
  ▼
tasks/<id>/uploads/<原文件名>
  │  POST /api/tasks/:id/prepare          routes/tasks.ts:196 → taskRunner.prepareTask
  ▼
prepareTask                              taskRunner.ts:276
  ├─ runSegmentationWorker               taskRunner.ts:45      （worker 线程）
  │    └─ segmentWorker.main             segmentWorker.ts:27
  │         ├─ extractText               documentService.ts:28
  │         │    └─ .epub → extractEpub  extract/epub.ts:31
  │         │         └─ htmlToText      extract/html.ts:20
  │         │              └─ cleanText  extract/cleanText.ts:6
  │         ├─ buildSegments             segmentBuilder.ts:46
  │         │    ├─ splitText            segmenter.ts:121
  │         │    └─ xmlize               phonetic.ts:91        （可选，phonetic=on）
  │         ├─ buildIntermediateBody     segmentBuilder.ts:72
  │         └─ 写 intermediate.json      segmentWorker.ts:65-70
  └─ （worker 不可用时回退主线程同步）   taskRunner.ts:311-323
  ▼
intermediate.json   → 任务状态 ready
  │  POST /api/tasks/:id/run 或 /:id/segments/:key/synthesize
  ▼
synthesizeSegment                       taskRunner.ts:406
  ├─ enhanceText                        textEnhance.ts（专有名词/正则/分词间隔/感叹词前缀）
  ├─ phoneticXmlToInput                 taskRunner.ts:201 → phonetic.ts:137
  ├─ buildPayload                       ttsClient.ts:30
  └─ synthesizeText                     ttsClient.ts:172  → tasks/<id>/<key>-<hash>.wav
  ▼
mergeAudios                             audioMerger.ts:101  → 最终音频
```

## 3. 阶段明细

### 3.1 上传

- 路由：`routes/tasks.ts`（multer `memoryStorage`），落盘到 `tasks/<id>/uploads/`。
- 中文文件名经 `decodeOriginalName` 修正（multipart latin1→utf8）。

### 3.2 抽取（`extractText`，`documentService.ts:28`）

按扩展名分派；EPUB 走 `extractEpub`：

| 步骤        | 函数            | 位置                       | 说明                                                                                                |
| ----------- | --------------- | -------------------------- | --------------------------------------------------------------------------------------------------- |
| 解包 + 选章 | `extractEpub` | `extract/epub.ts:31`     | `adm-zip` 读包，取 `.html/.xhtml`，排除 `META-INF`/`container.xml`，按条目名排序            |
| 章节范围    | `sliceRange`  | `extract/epub.ts:16`     | `epub_start`/`epub_end`（1 基；负数从末尾数）                                                   |
| 每章转文本  | `htmlToText`  | `extract/html.ts:20`     | 只取`<body>`；块级标签（`p/div/li/h1..h6/tr/...`）边界转 `\n`，`<br>` → `\n`             |
| 噪声清理    | `htmlToText`  | `extract/html.ts:24-34`  | 丢`<head>/<title>/<meta>/<link>/<style>/<script>`、`p.notecontent`（脚注）、纯 `[n]` 角标链接 |
| 文本归一    | `cleanText`   | `extract/cleanText.ts:6` | `\r\n`→`\n`、去控制字符、横向空白折叠、`\n` 两侧空格去除、多空行折叠为双换行                 |

输出：

```ts
ExtractResult = {
  text: string,                    // 全书正文（各 part 用 "\n\n" 拼接）
  sourceLabels: string[],          // 各 part 条目名，如 "text/part0000.html"
  format: string,
  parts?: { entry: string; text: string }[]   // 分章文本，用于按章分组
}
```

`documentService.ts:55-59` 对 EPUB 返回 `parts`，因此后续可**按章**保留 `source`。

### 3.3 分段（`buildSegments`，`segmentBuilder.ts:46`）

- 有 `parts`：逐章 `splitText(part.text, maxChars)`，段落的 `source = part.entry`。
- 无 `parts`：整篇 `splitText(...)`，`source = sourceLabels[0]`。
- 每段先做 **文本增强**（`enhanceText` / `TextEnhancer`，见 3.9）：按任务选项在感叹词前 / 分词之间插入指定字符串、应用专有名词替换与正则插入，增强后的文本即写为 `text`。
- 若开启注音：对增强后的文本调用 `xmlize(t)` 生成 `phonetic`（标记因此始终与 `text` 对齐）。

分段规则（`splitText`，`segmenter.ts:121`）：

1. 以**物理行**为单位，行内不拆分；
2. 相邻行在上限内**合并**，合并处给上一行末尾补 `，`（除非已以 `。！？!?.…` 结尾）；
3. 单行超上限 → `forceSplit`（`segmenter.ts:95`）：
   - `chunkableUnits`（`:77`）优先按句末标点（`。！？!?` + 右引号）切；否则按空格；否则按中文标点（`，、,；;：:`）；否则按 `max(40, maxChars/2)` 硬切；
   - 前若干块各自成段，**最后一块留在 pending**，仍可与后续行合并；
4. 「超限」判定 = 字符数 > `maxChars`，或预估时长 > 30s。

段数上限与键：`padKey`（`segmentBuilder.ts:20`）按总段数决定补零宽度，保证 JSON 对象键保持文档顺序。

### 3.4 中间表达（`buildIntermediateBody`，`segmentBuilder.ts:72`）

`intermediate.json`：

```jsonc
{
  "text": "全书正文",
  "sources": ["text/part0000.html", "..."],
  "segments": {
    "001": { "text": "分段文本", "phonetic": "注音XML或空", "source": "text/part0000.html" },
    "002": { ... }
  }
}
```

写入：worker 内先写 `.tmp-worker-<pid>` 再 `rename`（原子替换），见 `segmentWorker.ts:65-70`。

### 3.5 注音表达（`phonetic.ts`）

- **内部表达**（存 `intermediate.json`、给前端编辑）：`<phoneme pinyin="e1 pang2 gong1">阿房宫</phoneme>赋`
- 生成：`xmlize`（`phonetic.ts:91`）= CEDICT 最长匹配 + 约束：
  - 命中起点/终点都必须是 **jieba 分词边界**（`segmentationBoundaries`，`phonetic.ts:66`，源自 `jieba.ts` 的 `cutWords`）；
  - 音节数必须等于字数，否则跳过该候选；
  - 无命中按单字原样输出（不注音）。
- 解析：`parsePhoneticXml`（`phonetic.ts:28`）。
- **转 IndexTTS 输入**：`phoneticXmlToInput(text, xml)`（`phonetic.ts:137`）→ `<字|拼音>` 形式（`<阿|e1><房|pang2>…`），非中文原样；无注音时退回原文。

### 3.6 合成（`synthesizeSegment`，`taskRunner.ts:406`）

1. 取任务参数 `params_json` 与模型；`api_key` 只来自模型设置/默认值，任务级 `api_key` 被忽略（`taskRunner.ts:191-199`）。
2. **文本 → TTS input**：`phoneticXmlToInput(seg.text, seg.phonetic)`（`taskRunner.ts`）
   - `seg.text` 在分段/注音阶段**已完成 IndexTTS 文字增强**（见 3.9），合成时不再重复处理；
   - 无注音时退回原文（注音 XML 为空）。
3. **构建 payload**：`buildPayload`（`ttsClient.ts:30`）
   - 模型 schema 默认值 ∪ 任务参数；
   - 剔除 `ttsParams.ts` 定义的内部键（`name/model_id/skip_tts/phonetic/...`）；
   - `TTS_TOP_LEVEL_KEYS` 直发顶层，其余进 `extra_params`；
   - 情感互斥展开：`emotion_mode = text|random|vector`；
   - `seed = -1` → 随机；
   - 流式与格式协调：`response_format` 非 `pcm/wav` 时自动关流式。
4. **请求**：`synthesizeText`（`ttsClient.ts:172`）POST `{apiUrl}{apiPath}`；SSE 响应经 `extractSseAudio`（`ttsClient.ts:135`）重组，`repairWavHeader`（`ttsClient.ts:103`）修 RIFF/data 长度。
   外层包 `withRetry`（`services/retry.ts`）：失败后 10s / 20s / 30s 退避重试（最多 3 次）；停止/暂停（`signal.aborted`）不重试。重试耗尽仍失败 → `errorService.record` 记入错误历史，任务转 `error`；工作界面右上角错误图标可查看/清除。
5. 落盘 `tasks/<id>/<key>-<内容hash>.wav`（`taskRunner.ts`，命名见 `services/audioFiles.ts`）。

### 3.8 音频复用（重新分段 / 跳过已合成）

音频文件名 = `<分段key>-<注音后文本hash>.<ext>`（hash = `sha1(phoneticXmlToInput(text, phonetic))`，其中 `text` 已含 IndexTTS 文字增强；见 `services/audioFiles.ts`）。
因此**重新分段不删除音频**：只要某段「注音后文本」未变，其 hash 不变，就能直接复用旧语音。

- **重新分段**（`POST /:id/prepare`）：不再接收分段长度 / `skip_tts` 覆盖（参数取自任务设置）；`prepareTask` 只清 `intermediate.json`，随后 `taskService.relinkAudioByContent`（`taskService.ts`）把 hash 命中、但序号已变化的音频重命名为新分段的 `<newKey>-<hash>.<ext>`，未命中的文件保留在磁盘。前端只弹 Notification 告知分段长度与后果。
- **播放判定**：`taskService.audioKeys` / `segmentAudioPath`（`taskService.ts`）按「分段内容 hash」匹配文件，命中才算「已合成」；`readSegmentsPage` 返回的 `audio` 即该文件名。
  - 同一分段序号下可能同时存在**多个不同 hash** 的历史音频（改过文本后重新合成）。客户端**不做任何文件名猜测**，一律使用服务端权威映射 `GET /api/tasks/:id/audio-map`（`taskService.audioNameMap`，只返回 `key + 当前内容 hash` 都匹配的文件）；轮询用该映射刷新各行「播放」按钮。
  - 内容 hash 由 `taskService.segmentHashes` 按 `intermediate.json` 的 mtime 缓存，轮询时不会重复计算。
- **跳过已合成**：`POST /:id/tts`（或 `/run`）带 `skipExisting=true` 时，`synthesizeTask`（`taskRunner.ts`）先剔除已有内容匹配音频的分段再入队。
- **单段重合成**：`POST /:id/segments/:key/synthesize` 返回实际生成的音频文件名（含 hash）。

### 3.7 合并

`mergeAudios`（`audioMerger.ts:101`）：`detectAudioFormat`（`:10`）按魔数识别；同格式 WAV 重建头直拼，mp3/aac 直拼，异构转 ffmpeg。

### 3.9 分段文本增强（`services/textEnhance.ts`）

在把分段文本转换成 TTS 输入之前做文本增强，**在分段/注音阶段写入 `intermediate.json`**（不再在合成时处理）。模块与具体 TTS 引擎无关，提供可链式的 `TextEnhancer`（`replaceEntities().insertWithRegexRules().insertWordGaps().prefixInterjections().toString()`）与一次性的 `enhanceText`。

选项来自任务参数（`enhanceOptionsFromParams`），前端在「编辑任务 → 文档」页签以「复选框 + 字符填充框」配置：

| 参数 | 含义 | 默认 |
|---|---|---|
| `interjection_prefix_enabled` / `interjection_prefix` | 在感叹词（啊/哦/呀…）前插入指定字符串 | 开 / `-` |
| `word_gap_enabled` / `word_gap` | 用 jieba 分词后，在每个分词之间插入指定字符串 | 关 / `-` |
| `punct_comma_enabled` | 在感叹号/问号（`! ！ ? ？`）后补一个逗号（全角补「，」、半角补「,」） | 关 |
| 专有名词（不在此参数表内） | 来自 `named_entities` 表，勾选的条按「替换文本」改写（长词优先） | — |

- **专有名词标注**：数据存数据库 `named_entities` 表（首次启动由 `data/named_entities.json` 导入：`类型 → { 名词: 出现次数 }`）；服务 `services/namedEntityService.ts`，接口 `/api/named-entities`（列表/增删改/全局替换），界面在「注音参数」页签的「专有名词」中管理。注音时取 `replacementRules()`（仅勾选且替换文本不同的条目，长词优先）参与文本改写。

- 感叹词判定：目标字属于 `INTERJECTIONS`（啊哦呀哈嗨嘿哎唉咦哟噢喔喂嗯呃哇哼嘻唷咳），且**前一字符是边界**（串首/空白/标点，即非汉字·字母·数字·下划线），且前面尚未有该前缀 → 插入（幂等）；避免误伤语气助词（`好呀`、`你来啊` 不变）。
- 补逗号：`!`/`?` 后补 `,`，`！`/`？` 后补 `，`；若其后已是逗号或同类句末标点（`，,、。；;：:!！?？…`）则不重复插入。
- 顺序：**专有名词替换 → 补逗号 → 分词间隔 → 感叹词前缀**；分词间隔会过滤掉上一步插入的间隔符，保证重复执行结果一致。
- 应用位置：
  - `buildSegments`（分段/准备，`segmentBuilder.ts`）——写入分段文本；
  - `POST /:id/phonetic`（批量注音）与 `POST /:id/segments/:key/auto-phonetic`（单段自动注音）——先增强再 `xmlize`，并把增强后的文本一并回写。
- 合成时只做 `phoneticXmlToInput(seg.text, seg.phonetic)`；内容哈希基于增强后的文本，因此改变增强选项会导致音频按 hash 重新生成（需重新分段/合成）。

## 4. 关键参数

| 参数                                              | 来源                         | 默认   | 作用                                                            |
| ------------------------------------------------- | ---------------------------- | ------ | --------------------------------------------------------------- |
| `max_chars_per_segment` / `segment_max_chars` | 任务参数（前端「文档」页签） | 100    | 分段字上限；`taskRunner.segmentMaxChars`（`:21`）优先取前者 |
| `epub_start` / `epub_end`                     | 任务参数                     | 1 / -1 | EPUB 章节范围（1 基，负数从末尾）                               |
| `phonetic`                                      | 任务参数                     | false  | 抽取后是否自动注音（`buildSegments` 的第 2 参）               |
| `interjection_prefix_enabled` / `interjection_prefix` | 任务参数（前端「文档」页签） | true / `-` | 在感叹词前插入的字符串（IndexTTS 文字增强，见 3.9） |
| `word_gap_enabled` / `word_gap` | 任务参数（前端「文档」页签） | false / `-` | 在每个分词之间插入的字符串（IndexTTS 文字增强，见 3.9） |
| `punct_comma_enabled` | 任务参数（前端「文档」页签） | false | 在感叹号/问号后补逗号（IndexTTS 文字增强，见 3.9） |
| `skip_tts`                                      | 任务列                       | false  | 仅分段，跳过合成                                                |

## 5. 错误与回退

- **worker 失败**：`prepareTask` 捕获后回退主线程同步执行同样的 `extractText` + `buildSegments` + `emitIntermediate`（`taskRunner.ts:311-323`）。
- **词典/分词不可用**：`getDefaultDictionary`（`phonetic.ts:46`）失败时记一次 warning 并原样返回文本；jieba 初始化失败时 `cutWords` 逐字回退。
- **SSE 无音频**：`extractSseAudio` 在无 `data:` 时原样返回响应体（兼容非流式），有 `data:` 但无 `speech.audio.delta` 时抛错。

## 6. Python CLI 对照

CLI（`clone-voice-v6.py`）走另一套等价实现，逻辑与上述一致：

| 阶段       | WebApp（TS）                            | CLI（Python）                                            |
| ---------- | --------------------------------------- | -------------------------------------------------------- |
| 抽取调度   | `services/documentService.ts`         | `lib/document_loader.py`（`_load_epub_segments` 等） |
| EPUB 解析  | `services/extract/epub.ts`            | `lib/document_loader.py:152+`（ebooklib / zip 回退）   |
| HTML→文本 | `services/extract/html.ts`            | `lib/html_tag_filter.py`                               |
| 文本归一   | `services/extract/cleanText.ts`       | `lib/document_loader.py` `_clean_text`               |
| 分段       | `services/segmenter.ts` `splitText` | `lib/document_loader.py` `_split_document_text`      |
| 注音       | `services/phonetic.ts` `xmlize`     | `lib/phonetic_converter.py`                            |

## 7. 修改指引（改哪里）

| 想改什么                              | 改哪里                                                                       |
| ------------------------------------- | ---------------------------------------------------------------------------- |
| EPUB 选章规则 / 顺序                  | `extract/epub.ts`（`extractEpub`、`sliceRange`）                       |
| HTML 噪声过滤（脚注、角标、块级标签） | `extract/html.ts`（`htmlToText`）                                        |
| 空白/换行归一                         | `extract/cleanText.ts`（`cleanText`）                                    |
| 分段长度与合并/切分策略               | `services/segmenter.ts`（`splitText` / `forceSplit` / `needsComma`） |
| 注音对齐规则 | `services/phonetic.ts`（`xmlize`）+ `services/jieba.ts` |
| 分段文本增强（专有名词 / 正则插入 / 分词间隔 / 感叹词前缀）与选项解析 | `services/textEnhance.ts`（`TextEnhancer` / `enhanceText` / `enhanceOptionsFromParams`）+ 前端 `TaskForm.tsx` 文档页签 |
| 专有名词标注（表结构 / 导入 / 增删改 / 全局替换） | `db/database.ts`（`named_entities` 表 + 导入）+ `services/namedEntityService.ts` + `routes/namedEntities.ts` + 前端 `components/NamedEntityTable.tsx` |
| 感叹词表 / 插杠规则 | `services/textEnhance.ts`（`INTERJECTIONS` / `enhanceText` / `TextEnhancer`） |
| TTS 参数映射与情感/流式规则           | `services/ttsParams.ts` + `services/ttsClient.ts`（`buildPayload`）    |
| 中间文件结构                          | `services/segmentBuilder.ts`（`buildIntermediateBody`）                  |

> 注意：分段与注音规则同时存在于 TS 与 Python 两套实现中，行为必须保持一致；修改任一侧都应在对应测试中锁定（TS：`services/phonetic.test.ts`、`services/textEnhance.test.ts`、`services/taskRunner.test.ts`、`routes/tasks.test.ts`）。
