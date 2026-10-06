# VoiceCloner Web

> 本说明仅针对 **`webapp/`**（VoiceCloner 的 Web 工作台），不涉及仓库其它部分。

把文档（`txt/html/epub/pdf/docx`）转成可**逐段编辑、注音、试听、导出**的语音：中文优先的 Web 界面，
通过 OpenAI 风格的 TTS 接口（`/v1/audio/speech`，支持 SSE 流式）调用任意兼容的语音服务。

- 技术栈：前端 React + Vite + Ant Design；后端 Node + TypeScript + Express + 内置 `node:sqlite`。
- 界面使用：[user-guide.md](user-guide.md) · 架构：[webapp/ARCHITECTURE.md](webapp/ARCHITECTURE.md)

## 依赖

- **Node.js ≥ 24**（后端使用内置 `node:sqlite`；22.5+ 需 `--experimental-sqlite`）
- 可选：`ffmpeg`（导出 mp3 / 合并异构音频）

## 本地开发

```bash
cd webapp
npm run install:all        # 安装 server 与 client 依赖
npm run dev:server         # 后端 http://localhost:3000
npm run dev:client         # 前端 http://localhost:5173（/api 代理到 3000）
```

默认账号：**`admin` / `StanislawLem`**（首次启动自动创建，请尽快修改）。

没有真实 TTS 时可用内置 mock：

```bash
cd webapp/server && npm run mock:tts    # 127.0.0.1:20900
```

然后在界面「资源 → TTS 模型」中把 `api_url` 指向 `http://127.0.0.1:20900`、`api_path` 设为 `/v1/audio/speech`。

## 打包

```bash
cd webapp
npm run build              # 构建后端与前端
docker compose build       # 或：构建 Docker 镜像
```

**打包产出物**

| 产出             | 内容                                                              | 说明                                                                                                                                                                                                                                                |
| ---------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/dist/` | 后端编译产物（CommonJS，TypeScript → JS，无 sourcemap/类型声明） | 入口`dist/main.js`；分层子目录 `routes/ services/ db/ auth/ shared/` 与 `app.js / config.js / logger.js`（含 `mockTtsServer.js`）。**不含 `node_modules`**，部署时需另行 `cd server && npm ci --omit=dev`（或直接用 Docker 镜像） |
| `client/dist/` | 前端静态站点                                                      | `index.html` + `assets/`（JS/CSS 分块、自托管字体 woff2/woff）+ `country_flag/`（国旗）。由后端 `express.static` 托管                                                                                                                       |
| Docker 镜像      | `node:24-slim` + `ffmpeg`                                     | 容器名`voicecloner-web`；镜像内已含后端 `dist` + `node_modules` + 前端 `client/dist`，无需额外安装运行时依赖（Node 已内置）                                                                                                                 |

**运行产物所需**

- Node ≥ 24（`node:sqlite`）；若用非 Docker 部署并需导出 mp3，另装 `ffmpeg`。
- 可写目录 `DATA_DIR`（默认 `webapp/data`）与 `LOG_DIR`（默认 `webapp/log`）会被自动创建；Docker 中对应卷 `/app/data`、`/app/log`。
- 后端默认 `express.static(CLIENT_DIST)` 托管 `client/dist`，因此单进程即可同时提供 API 与前端。

## 部署

**方式一：单进程运行（后端同时托管前端）**

```bash
cd webapp
npm run build
npm start                  # node dist/main.js，监听 3000
```

**方式二：Docker**

```bash
cd webapp
docker compose up -d --build
# 访问 http://localhost:3000
```

常用环境变量（均有默认值）：

| 变量            | 默认                                  | 说明                                          |
| --------------- | ------------------------------------- | --------------------------------------------- |
| `PORT`        | `3000`                              | HTTP 端口                                     |
| `DATA_DIR`    | `webapp/data`                       | 数据目录（SQLite、任务、声音样本）            |
| `LOG_DIR`     | `webapp/log`                        | 日志目录                                      |
| `CLIENT_DIST` | `webapp/client/dist`                | 前端产物目录（Docker 为`/app/client/dist`） |
| `CEDICT_PATH` | `data/cedict_1_0_ts_utf-8_mdbg.txt` | CC-CEDICT 词典                                |
| `JWT_SECRET`  | 开发默认值                            | **生产必须改为强随机值**                |

TTS 模型在界面「资源 → TTS 模型」中配置（`api_url` / `api_path` / `api_key` / 参数 Schema），无需改配置文件。

## 一键打包与 Docker 部署（pack.py / deploy.py）

**打包**（脚本位于 `tools/`，在仓库根目录执行）：基于已有的 `server/dist` 与 `client/dist`，打包出只含部署所需内容的压缩包。**产物统一输出到仓库的 `dist/` 目录。**

```bash
python tools/pack.py                    # 自动构建；输出 dist/<app>_yyyymmdd_HHMMSS.zip 与 .tar.gz
python tools/pack.py -o release         # dist/release.zip + dist/release.tar.gz
python tools/pack.py -o release.tar.gz  # 文件名含明确压缩后缀 → 只输出 dist/release.tar.gz
python tools/pack.py --no-build         # 不自动构建（要求已存在 dist/）
python tools/pack.py --source           # 源码包：dist/<app>_src_yyyymmdd_HHMMSS.zip 与 .tar.gz（不含 dist）
python tools/pack.py --source -o release # dist/release_src.zip + dist/release_src.tar.gz
```

- 默认**同时输出 `.zip` 与 `.tar.gz`**；用 `-o` 指定文件名时，若含明确压缩后缀（`zip`/`tar.gz`/`tgz`/`tar`/`xz`/`bz2`…）则**只输出该文件**，否则视为基名并自动补全两种后缀；相对名一律落在 `dist/` 下（绝对路径则按该路径输出）。
- `--source`：打包 **webapp 源码**（不含 `dist`/`node_modules`/日志/运行数据），并附带 `data/`、`tools/`、`README.md`；**包名含 `src` 标记**（`-o` 名字不含 `src` 时自动补 `_src`）。解压后 `webapp/` 即源码，可 `cd webapp && npm run install:all && npm run build` 自行构建；约 1MB。
- **包内结构**（解压后同根）：`webapp/`（`Dockerfile`、`server/dist`、`server/package*.json`、`client/dist`、`data/cedict_*.txt`、`data/named_entities.json`）+ `tools/pack.py`、`tools/deploy.py` + `README.md`。
- 不含源码、`node_modules`、日志与运行数据；压缩包约 40MB。

**Docker 部署**（在仓库根目录执行）：接受上面的包，解压后构建镜像并以指定端口运行。

```bash
python tools/deploy.py <包文件>                    # 交互确认端口（默认 3000）
python tools/deploy.py <包文件> --port 8080
python tools/deploy.py <包文件> --port 8080 --name my-vc --force
```

- 未指定 `--port` 时会提示确认默认端口（3000）或输入；**端口无效或被占用会要求重新输入**。
- 需已安装并启动 Docker。容器名默认 `voicecloner-web`，数据/日志使用命名卷 `voicecloner-data`、`voicecloner-log`，容器内固定 `3000`，对外映射为所选端口。
