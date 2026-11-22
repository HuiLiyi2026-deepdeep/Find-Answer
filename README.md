# FindAnswer

[![CI](https://github.com/HuiLiyi2026-deepdeep/Find-Answer/actions/workflows/ci.yml/badge.svg)](https://github.com/HuiLiyi2026-deepdeep/Find-Answer/actions/workflows/ci.yml)

> 从资料里，找到确切答案。

一个本地优先的严格 RAG 资料问答工具：答案只来自你上传的资料，每条结论都能回到原文；资料不足时直接拒答，不用模型常识补答。

[English](README.en.md) | 简体中文

线上体验：<https://findanswer-o0xytkkkwm9.qoder.zone>（匿名临时资料库，请勿上传隐私或机密文件）

## 为什么做 FindAnswer

通用聊天模型很容易把“不知道”说成“知道”。FindAnswer 把回答限制在检索到的资料片段内，并让每条引用都能点开核对原文。它更适合查规范、读文档、复习课程资料这类“答错比不答更糟”的场景。

## 核心保证

- **有据可查**：回答附带真实文件名、页码或分块号以及原文片段。
- **无据拒答**：检索结果低于相似度阈值时直接返回统一拒答，不调用聊天模型。
- **引用校验**：缺失、越界、格式错误或有效/无效混合的引用会导致整条回答被拒绝。
- **密钥不回显**：密钥不会出现在健康检查、日志、前端持久化或浏览器存储中。
- **不保存问答历史**：本地版和公开版都不记录问答对话。

## 功能

- 支持 TXT、Markdown、文字型 PDF（单文件上限 20 MiB）。
- 单文件上传与文件夹递归上传；本地版每批最多 100 个合格文件，公开版每批 50 个。
- 上传按 SHA-256 去重，文件夹上传串行调度，单个文件失败不中断整批。
- 问答页展示回答或拒答状态、检索片段与可展开的来源引用。
- 资料页支持上传、删除、索引状态与分块预览。
- 模型连接页分别保存并测试硅基流动与 DeepSeek 密钥。
- Windows 便携包使用原生 WebView2 窗口，无需终端和外部浏览器。
- 公开版为每位访客提供独立的临时资料库：20 份资料 / 200 个片段，结束体验或会话过期后清理。

## 架构

```text
本地版
React + Vite ──HTTP──> FastAPI ──> SQLite（资料、分块元数据）
                            ├────> Chroma（本地向量索引）
                            └────> 硅基流动 Embedding / DeepSeek Chat

公开版（Qoder Sites）
React ──> Sites Function ──> Sites Database（会话、资料、分块、向量）
                        ├──> Sites Storage（原始文件）
                        └──> 硅基流动 / DeepSeek（服务端 Secrets）
```

检索使用余弦相似度、Top-K 与可配置阈值；有有效片段时才把编号片段发送给 DeepSeek。公开版为了保证隔离与配额，会在会话范围内完成检索与配额预留。

## 快速开始

### Windows 便携包

1. 在 [Releases](https://github.com/HuiLiyi2026-deepdeep/Find-Answer/releases) 下载 `FindAnswer-win11-x64.zip` 并解压。
2. 双击 `FindAnswer.exe`，程序窗口会直接打开，不显示终端，也不启动外部浏览器。
3. 首次使用请在“模型连接”页填写两个 API 密钥；保存前会做真实连接测试。

运行数据保存在 `%LOCALAPPDATA%\FindAnswer\data`，日志位于 `%LOCALAPPDATA%\FindAnswer\logs\desktop.log`。关闭窗口即退出程序。Windows 11 通常自带 WebView2；若提示缺失，请安装 Microsoft Edge WebView2 Evergreen Runtime。便携包未做代码签名，SmartScreen 可能显示提示。

### 本地开发

需要 Python 3.12（已在 3.12.10 验证）和 Node.js 20.19+。

```bash
# 后端
cd backend
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --reload --port 8000

# 前端（另一个终端）
cd frontend
npm install
npm run dev
```

打开 <http://127.0.0.1:5173>，在“模型连接”页保存密钥。也可以双击 `start-dev.bat` 同时启动两端；`FindAnswer.lnk` 会隐藏窗口启动，并复用已经运行的服务。

### 配置

普通使用不需要创建 `.env`。以下环境变量用于高级配置，且优先于已保存的凭据：

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `SILICONFLOW_API_KEY` | 空 | 硅基流动密钥 |
| `DEEPSEEK_API_KEY` | 空 | DeepSeek 密钥 |
| `SILICONFLOW_EMBEDDING_MODEL` | `BAAI/bge-m3` | 向量模型 |
| `DEEPSEEK_MODEL` | `deepseek-chat` | 问答模型 |
| `FINDANSWER_DATA_DIR` | `backend/data` | 本地数据目录 |
| `FINDANSWER_RETRIEVAL_THRESHOLD` | `0.25` | 检索相似度阈值 |
| `DEFAULT_TOP_K` | `5` | 默认检索条数 |
| `CHUNK_SIZE` | `600` | 分块长度 |
| `CHUNK_OVERLAP` | `80` | 分块重叠长度 |

## 测试

```bash
# 后端（58 项）
cd backend && python -m pytest

# 前端（26 项）
cd frontend && npm test

# 公开版 Function Harness（121 项）
node --test public-harness/tests/*.test.mjs

# 启动器脚本测试
powershell -ExecutionPolicy Bypass -File scripts/tests/StartFindAnswer.Tests.ps1

# 评测：离线契约检查（无需 Key，CI 会跑）
python eval/run_eval.py --mode offline

# 评测：真实质量基线（需要本地 Key）
python eval/run_eval.py --mode live --report eval/report-live.json
```

评测集结构与指标门槛见 [eval/README.md](eval/README.md)。CI 在 push 与 PR 时运行后端测试、离线评测、前端测试与构建、公开版 Harness。

## 打包 Windows 版本

```powershell
powershell -ExecutionPolicy Bypass -File packaging/build.ps1
```

脚本会构建本地模式前端、准备独立构建环境、使用 PyInstaller 生成窗口版程序，并输出 `packaging/out/FindAnswer-win11-x64.zip`。打包产物不进入 git 历史，请通过 Releases 分发。

## 目录结构

```text
backend/            FastAPI 本地后端、SQLite/Chroma、桌面入口
frontend/           React + Vite 工作台（本地与公开两种模式）
functions/          Qoder Sites Function（公开版服务端）
deploy/schema.sql   公开版数据库结构
public-harness/     公开版 Function 的本地测试与服务模拟
eval/               检索与拒答评测集、离线契约与真实基线
packaging/          PyInstaller 配置、构建脚本与使用说明
scripts/            启动脚本与启动器测试
docs/               设计文档与实施计划
```

## 设计边界

- 仅支持文字型 PDF，不做 OCR、表格理解或图片描述。
- 检索是单路向量召回加固定阈值，没有重排、混合检索或查询改写。
- 公开版在会话范围内计算余弦相似度，受 200 片段上限约束；本地版使用 Chroma。
- 公开版是匿名临时资料库，没有账号体系；清理依赖结束按钮和会话过期。
- 尚无自动化评测集来衡量召回率、引用准确率与拒答准确率。

## 隐私与安全

- 上传文本会发送到硅基流动生成向量；命中片段与问题会发送到 DeepSeek 生成回答。
- 本地密钥保存在当前 Windows 用户的凭据管理器中；公开版密钥保存在服务端 Secrets。
- 前端不会回显密钥，也不会把密钥写入 `localStorage`、`sessionStorage` 或日志。
- 请勿上传隐私、机密或无权公开的资料。

## 后续计划

- 建立 RAG 评测集，覆盖召回、引用准确率与拒答准确率。
- 增加 CI（测试、类型检查、构建）与更细的运行时观测。
- 评估重排、混合检索与查询改写对引用质量的影响。
- 按需增加 OCR 与更多文档格式。