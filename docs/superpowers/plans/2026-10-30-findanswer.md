# FindAnswer 实施计划

> **供自动化执行代理使用：** 必须配合 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 技能，逐项执行本计划。各步骤使用复选框（`- [ ]`）跟踪进度。

**目标：** 构建一个本地运行的第一版 RAG 学习网站，通过 API 完成向量化和回答生成，提供真实引用、明确的无答案拒答，以及克制、带过渡动画的灰白色工作台。

**架构：** FastAPI 负责文件、SQLite 元数据、Chroma 向量、模型服务调用和引用映射。React 负责嵌套工作台页面与过渡动画；浏览器不会接触 API 密钥。

**技术栈：** Python、FastAPI、Chroma、SQLite、httpx、pypdf、pytest、React、TypeScript、Vite、React Router、Framer Motion。

**设计说明：** `docs/superpowers/specs/2026-10-30-findanswer-design.md`

## 全局约束

- 仅支持 TXT、Markdown 和文字型 PDF；上传文件最大为 20 MB。
- 没有检索依据时不得调用 DeepSeek。
- 引用必须映射到已存储的分块 ID，绝不能使用模型编造的文件名。
- API 密钥只能保存在后端环境变量中。
- 工作台使用嵌套路由和克制的灰白色视觉样式。

---

### 任务 1：项目脚手架

**文件：**
- 新建：`backend/requirements.txt`、`backend/app/__init__.py`、`backend/.env.example`
- 新建：`frontend/package.json`、`frontend/index.html`、`frontend/tsconfig.json`、`frontend/vite.config.ts`、`frontend/src/main.tsx`

**接口与产物：**
- 产出：Vite 开发服务器运行在 5173 端口，将 `/api` 代理到 8000 端口；Python 依赖可通过一个 requirements 文件统一安装。

- [ ] 编写前端 `dev`、`build` 和 `preview` 脚本，并引入 React、React Router 和 Framer Motion。
- [ ] 声明 FastAPI、chromadb、httpx、pypdf、python-multipart、python-dotenv、pytest 和 pytest-asyncio 依赖。
- [ ] 在 `.env.example` 中说明 `SILICONFLOW_API_KEY`、`SILICONFLOW_EMBEDDING_MODEL`、`DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL`、`FINDANSWER_RETRIEVAL_THRESHOLD` 和 `FINDANSWER_DATA_DIR`，不得写入真实密钥。
- [ ] 安装依赖并验证初始 Vite 入口可以编译。

### 任务 2：解析、分块与模型服务客户端

**文件：**
- 新建：`backend/app/chunking.py`、`backend/app/providers.py`、`backend/app/config.py`
- 测试：`backend/tests/test_chunking.py`

**接口与产物：**
- 产出：`extract_pages(path: Path) -> list[PageText]`、`chunk_pages(pages: list[PageText], max_chars=600, overlap=80) -> list[Chunk]`。
- 产出：异步模型服务方法 `embed(texts: list[str]) -> list[list[float]]` 和 `complete(system: str, user: str) -> str`。

- [ ] 编写预期失败的测试，验证中文文本的段落顺序、稳定的分块索引、页码元数据和非空输出。
- [ ] 运行 `pytest backend/tests/test_chunking.py -v`，确认初始阶段因无法导入而失败。
- [ ] 实现 UTF-8 文本与 Markdown 解析、基于 pypdf 的逐页解析，以及长度受限的重叠分块。
- [ ] 实现 SiliconFlow `/embeddings` 和 DeepSeek `/chat/completions` HTTP 调用，设置超时，并对 `ProviderError` 信息进行脱敏。
- [ ] 重新运行分块测试并确认通过。

### 任务 3：持久化与 RAG 行为

**文件：**
- 新建：`backend/app/storage.py`、`backend/app/rag.py`
- 测试：`backend/tests/test_rag.py`

**接口与产物：**
- 使用：任务 2 的向量化和回答生成方法。
- 产出：`RAGService.search(question, top_k=5)` 和 `RAGService.ask(question, top_k=5)`；回答包含 `status`、`answer`、`citations` 和 `retrieval` 字段。

- [ ] 使用模拟模型服务编写预期失败的测试：无命中结果时返回 `no_answer`；低分命中时返回 `no_answer`；两种路径均不得调用回答模型。
- [ ] 编写预期失败的测试，验证返回的引用包含已存储的分块 ID、文件名和原文，并验证证据不足时的 `NO_ANSWER` 标记会转换为标准中文拒答。
- [ ] 运行 `pytest backend/tests/test_rag.py -v`，确认实现前测试失败。
- [ ] 实现 Chroma 余弦相似度检索、分数过滤、带编号证据的提示词、标记处理和后端主导的引用映射。
- [ ] 实现 SQLite 文件记录，以及 Chroma 分块的新增、列表、检索和删除。
- [ ] 重新运行 RAG 测试并确认通过。

### 任务 4：HTTP API

**文件：**
- 新建：`backend/app/main.py`
- 测试：`backend/tests/test_api.py`

**接口与产物：**
- 产出：`GET /api/health`、`GET/POST /api/documents`、`GET /api/documents/{id}/chunks`、`DELETE /api/documents/{id}`、`POST /api/search`、`POST /api/ask`。

- [ ] 编写预期失败的 API 测试，覆盖健康检查配置标记、空白问题的 422 响应，以及使用模拟服务时的无答案响应。
- [ ] 运行 `pytest backend/tests/test_api.py -v`，确认初始测试失败。
- [ ] 实现上传校验、重复检测、分批向量化、模型服务错误响应、文件接口、检索和问答路由。
- [ ] 将 CORS 限制为本地 Vite 来源，并确保模型服务客户端仅位于后端。
- [ ] 运行全部后端测试并确认通过。

### 任务 5：工作台外壳与视觉系统

**文件：**
- 新建：`frontend/src/App.tsx`、`frontend/src/types.ts`、`frontend/src/api.ts`、`frontend/src/components/AppShell.tsx`、`frontend/src/styles.css`

**接口与产物：**
- 产出：嵌套的 `/ask`、`/documents`、`/connections` 路由、共享 API 客户端和带类型的响应模型。

- [ ] 构建持久存在的父级外壳，包含导航、本地状态和带动画的 `Outlet`。
- [ ] 实现灰白色设计变量、边框、字体、焦点状态、响应式侧栏和减少动态效果支持。
- [ ] 使用 `AnimatePresence` 添加路由过渡，动画不得阻碍键盘或滚动操作。
- [ ] 运行 TypeScript 检查并修复所有类型错误。

### 任务 6：产品页面与交互

**文件：**
- 新建：`frontend/src/pages/AskPage.tsx`、`frontend/src/pages/DocumentsPage.tsx`、`frontend/src/pages/ConnectionsPage.tsx`

**接口与产物：**
- 使用：全部 API 路由和共享工作台类型。

- [ ] 实现问题提交、加载状态、明确的无答案面板、回答引用和可展开的检索依据。
- [ ] 实现拖拽/点击上传、进度和错误反馈、文件删除及分块预览。
- [ ] 实现模型服务连接卡片、已配置/未配置状态和本地环境配置指引。
- [ ] 处理空状态、加载状态和失败状态，不得编造回答或引用。
- [ ] 运行 `npm run build`，确认生产构建无错误。

### 任务 7：端到端验证

**文件：**
- 仅修改验证过程中发现缺陷的文件。

- [ ] 再次运行后端测试和前端构建。
- [ ] 启动 FastAPI 和 Vite，在浏览器中打开网站，验证全部三个嵌套路由。
- [ ] 使用受控的测试模型服务执行核心流程：上传文字资料、提出有答案的问题并检查引用，然后提出无答案的问题并验证明确拒答。
- [ ] 验证空白输入、API 失败提示、空文件库状态、路由过渡、来源展开和窄屏布局。
- [ ] 准确报告已验证内容，并注明真实模型服务调用需要用户的 API 密钥。
