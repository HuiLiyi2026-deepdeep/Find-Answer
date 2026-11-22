# 评测集

`dataset.json` 是 FindAnswer 的检索与拒答基线，只包含虚构资料，不含真实业务文档或密钥。

## 结构

```json
{
  "version": 1,
  "documents": [
    { "id": "leave", "name": "leave-policy.md", "text": "文档全文……" }
  ],
  "cases": [
    {
      "id": "leave-annual",
      "kind": "answerable",
      "question": "正式员工每年有多少天年假？",
      "expected_documents": ["leave"],
      "expected_terms": ["10天"]
    },
    {
      "id": "refuse-canteen",
      "kind": "unanswerable",
      "question": "食堂几点开饭？",
      "expected_documents": []
    }
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `documents[].id` | 稳定标识，入库时作为 `document_id` |
| `documents[].name` | 文件名，决定解析方式（`.txt` / `.md` / `.pdf`） |
| `documents[].text` | 文档全文，评测时按 600/80 切块 |
| `cases[].kind` | `answerable` 必须有 `expected_documents` 与 `expected_terms`；`unanswerable` 必须为空数组 |
| `expected_terms` | 答案中必须出现的字面量，比较时忽略空白与大小写 |

## 两种运行模式

```bash
# 离线契约检查：确定性哈希向量 + 脚本化模型，不联网、不需要 Key
python eval/run_eval.py --mode offline

# 真实质量基线：bge-m3 检索 + DeepSeek 作答，需要 Key
python eval/run_eval.py --mode live --report eval/report-live.json
```

Key 只从 `SILICONFLOW_API_KEY`、`DEEPSEEK_API_KEY` 环境变量或 `backend/.env` 读取，不会被打印或写入报告。

## 指标与门槛

| 指标 | 含义 | 默认门槛 |
| --- | --- | --- |
| `retrieval_recall` | Top-5 命中任一期望文档的可答用例占比 | 0.80 |
| `citation_validity` | 引用片段确实存在、且来自期望文档 | 0.80 |
| `refusal_rate` | 无依据问题被完整拒答的占比 | 1.00 |
| `no_evidence_no_chat` | 检索为空时未调用模型 | 1.00 |
| `answer_terms` | 答案包含期望字面量（仅 live） | 0.80 |

不达标时退出码为 1，可用 `--min-recall` 等参数调整单次运行门槛。

## 如何解读

- `offline` 只证明入库、检索、引用映射、拒答链路是通的；哈希向量不是语义模型，不能当作检索质量结论。
- `live` 才反映真实模型表现。首次运行先记录基线，再改动阈值、提示词或分块策略；比较时保持同一份 `dataset.json`。
- 阈值 `0.23`（offline）是按当前合成集校准的，换资料或换哈希维度需要重新校准，不要直接套用到线上 `0.25`。
- 扩充评测集时优先加“近似但未命中”的干扰文档和跨文档问题，它们比单纯增加同义问句更能暴露检索缺陷。