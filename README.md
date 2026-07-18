# OpenClaw Auto-Rename Plugin

> ⚠️ **已弃用 / Deprecated**
>
> OpenClaw 2026.7.x 已内置 dashboard 会话标题自动生成功能（通过 `agents.defaults.utilityModel` 配置），新版本无需此插件。
>
> 内置功能在对话完成后由 gateway 直接调用模型生成标题，比本插件的轮询方案更快、更可靠。如果你在用较新版本的 OpenClaw，建议直接配置 `utilityModel` 而非安装此插件。
>
> 本仓库保留作为存档和参考。

## 这是什么

一个 [OpenClaw](https://github.com/openclaw/openclaw) 插件，用于在新对话首次回复后自动生成 3-10 字中文会话标题，并写入 `sessions.json` 的 `displayName` 字段。

## 功能

- **自动重命名**：检测新会话的首条用户消息和助手回复，通过 LLM 生成简短中文标题
- **LLM 模式**：调用本地或远程 LLM API 生成摘要标题（默认使用本地 llama-server）
- **Extract 模式**：LLM 不可用时回退到从首条消息提取关键词
- **Reset 检测**：会话被 reset 后清除旧标题，等待新对话重新命名
- **名称守卫**：防止 gateway 覆盖已设置的 displayName（防回退）

## 配置项

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 启用/禁用插件 |
| `pollIntervalMs` | integer | `8000` | 轮询间隔（毫秒） |
| `titleMaxLen` | integer | `10` | 标题最大字数 |
| `mode` | string | `"llm"` | 标题生成模式：`llm` 或 `extract` |
| `llmEndpoint` | string | `http://localhost:8081/v1/chat/completions` | LLM API 端点 |
| `llmModel` | string | `Qwen3VL-2B-Instruct-Q4_K_M.gguf` | LLM 模型名 |
| `llmApiKey` | string | `""` | LLM API 密钥（留空则自动读取环境变量） |

## 安装

将 `auto-rename` 文件夹放入 `~/.openclaw/plugins/` 目录下，重启 OpenClaw gateway 即可自动加载。

```bash
cp -r auto-rename ~/.openclaw/plugins/
openclaw gateway restart
```

## 工作原理

1. 插件启动后定期轮询 `sessions.json`（默认每 8 秒）
2. 发现没有 `displayName` 的新会话 → 读取会话 JSONL 文件提取首条用户消息和助手回复
3. 调用 LLM 或从消息中提取 3-10 字中文标题
4. 写入 `sessions.json` 的 `displayName` 字段
5. 同时记录到 `.auto-rename-tracker.json` 持久化跟踪

## 为什么弃用

OpenClaw 新版本（2026.7.x）在 gateway 层面内置了会话标题生成：

- 内置功能在对话完成的**瞬间**即时触发，无需轮询
- 通过 `utilityModel` 配置可指定专用低成本模型
- 不存在与本插件的竞态问题

本插件的 8 秒轮询机制在新版本中会被 gateway 内置逻辑抢先设置 `displayName`，导致插件检测到已有标题后直接跳过，实际不再生效。

## 文件结构

```
auto-rename/
├── openclaw.plugin.json   # 插件清单（配置 schema）
└── index.js               # 插件主逻辑（v2.2）
```

## License

MIT
