# OpenClaw Auto-Rename Plugin

[English](#english) | [中文](#中文)

> OpenClaw 2026.7.1 includes built-in session-title generation, but this plugin remains useful when you want a local model, a customizable prompt, stricter title formatting, retry behavior, and full control over naming quality.
>
> OpenClaw 2026.7.1 已内置会话标题生成，但如果你希望使用本地模型、自定义提示词、严格控制标题格式、支持失败重试，并获得更自由的命名效果，本插件仍然有价值。

---

## English

### Overview

An OpenClaw plugin that generates a concise Chinese title for a new conversation after the first assistant reply and writes it to the session's `displayName`.

Unlike OpenClaw's built-in title generator, this plugin can call any OpenAI-compatible local or remote endpoint. It defaults to a local `llama-server`, so title generation can stay private and avoid cloud-model costs.

### Why use this instead of the built-in generator?

OpenClaw 2026.7.1 added built-in dashboard session-title generation through `agents.defaults.utilityModel`. The built-in implementation is convenient, but its prompt and output handling are fixed. In practice, some models may return a full answer instead of a short title.

This plugin provides:

- A fully customizable local or remote LLM endpoint
- A stricter Chinese title prompt
- Configurable title length
- Validation and cleanup of model output
- Retry behavior when the local model is still starting
- Deterministic extraction fallback after repeated failures
- Session reset detection and automatic re-naming
- A name guard that restores plugin-managed titles if overwritten
- No required cloud LLM calls when used with a local server

### Important: disable OpenClaw's built-in title generator

Both implementations write `displayName`. OpenClaw's built-in generator usually runs first, causing this plugin to see an existing title and skip the session.

OpenClaw 2026.7.1 does not currently expose a dedicated disable switch. Setting `utilityModel` to the string `"none"` is **not** a disable flag; it is parsed as a model reference.

A practical workaround is to configure an intentionally unavailable full model reference:

```json
{
  "agents": {
    "defaults": {
      "utilityModel": "disabled/none"
    }
  }
}
```

This makes built-in utility-model title generation return no result without falling back to the primary model. It also disables other `utilityModel` tasks, such as generated Telegram topic titles and Discord auto-thread titles.

### Features

- **Automatic naming** after the first complete assistant reply
- **LLM mode** using an OpenAI-compatible Chat Completions endpoint
- **Extract mode** for deterministic naming without an LLM
- **Local-model retries** before permanent fallback
- **Output cleanup** for quotes, prefixes, Markdown wrappers, and generic suffixes
- **Reset detection** to clear an old title after a session reset
- **Name guard** to restore plugin-managed titles
- **Persistent tracker** stored in `.auto-rename-tracker.json`

### What's new in v2.3

- Retry local LLM failures instead of permanently accepting a poor fallback immediately
- Fix title parsing that could turn `自动重命名插件更新说明` into `件更新说明`
- Improve the title prompt and add a dedicated system message
- Remove generic suffixes such as `更新说明` when appropriate
- Reduce completion budget from 80 to 32 tokens
- Remove the module-level singleton guard that could break plugin hot reload

### Installation

Clone or download the repository into the OpenClaw plugin directory:

```bash
git clone https://github.com/MCwasd/openclaw-auto-rename-plugin.git \
  ~/.openclaw/plugins/auto-rename
```

Add the plugin path and configuration to `~/.openclaw/openclaw.json`:

```json
{
  "agents": {
    "defaults": {
      "utilityModel": "disabled/none"
    }
  },
  "plugins": {
    "entries": {
      "auto-rename": {
        "enabled": true,
        "config": {
          "llmEndpoint": "http://localhost:8081/v1/chat/completions",
          "llmModel": "Qwen3VL-2B-Instruct-Q4_K_M.gguf",
          "llmApiKey": "",
          "retryMaxAttempts": 30
        }
      }
    },
    "load": {
      "paths": [
        "~/.openclaw/plugins/auto-rename/"
      ]
    }
  }
}
```

Restart the Gateway after installing or updating plugin source files:

```bash
openclaw gateway restart
```

OpenClaw may hot-reload plugin configuration, but Node.js module caching can keep old plugin source active. A restart is recommended after source-code updates.

### Configuration

| Field | Type | Default | Description |
|---|---|---:|---|
| `enabled` | boolean | `true` | Enable the plugin |
| `pollIntervalMs` | integer | `8000` | Session polling interval in milliseconds |
| `titleMaxLen` | integer | `10` | Maximum title length |
| `mode` | string | `llm` | `llm` or deterministic `extract` mode |
| `retryMaxAttempts` | integer | `30` | Failed LLM polls before extraction fallback |
| `llmEndpoint` | string | `http://localhost:8081/v1/chat/completions` | OpenAI-compatible endpoint |
| `llmModel` | string | `Qwen3VL-2B-Instruct-Q4_K_M.gguf` | Model name sent to the endpoint |
| `llmApiKey` | string | empty | Optional Bearer token; local endpoints need no key |

With the default 8-second polling interval and 30 attempts, the plugin waits for approximately four minutes before using extraction fallback.

### How it works

1. Polls the agent session store.
2. Finds sessions without an explicit `displayName`.
3. Waits for the first complete assistant reply.
4. Extracts the first user message and assistant reply.
5. Requests a short Chinese title from the configured model.
6. Retries temporary LLM failures.
7. Cleans and truncates the model output.
8. Writes the title to `sessions.json` and records it in `.auto-rename-tracker.json`.
9. Periodically restores tracked titles if another process overwrites them.

### Local llama-server example

```bash
llama-server \
  --host 0.0.0.0 \
  --port 8081 \
  -m /path/to/model.gguf \
  -c 8192
```

Any OpenAI-compatible `/v1/chat/completions` server can be used.

---

## 中文

### 简介

这是一个 OpenClaw 会话自动重命名插件。新会话完成首次助手回复后，插件会根据首条用户消息和助手回复生成简洁的中文标题，并写入会话的 `displayName`。

与 OpenClaw 内置功能相比，本插件可以连接任意兼容 OpenAI Chat Completions API 的本地或远程模型。默认使用本地 `llama-server`，因此可以避免云端标题调用费用，并让会话内容留在本机。

### 为什么新版 OpenClaw 仍可能需要这个插件？

OpenClaw 2026.7.1 已通过 `agents.defaults.utilityModel` 内置 Dashboard 会话标题生成。但内置功能的提示词和输出处理逻辑是固定的，部分模型可能不按要求返回短标题，而是直接回答用户问题，产生很长、质量较差的标题。

本插件提供：

- 可自由指定本地或远程 LLM 端点
- 更严格的中文标题提示词
- 可配置的标题长度
- 模型输出校验与清洗
- 本地模型启动较慢时自动重试
- 多次失败后才使用确定性文本回退
- 会话 Reset 检测和重新命名
- 标题守卫，防止插件生成的标题被覆盖
- 配合本地模型使用时不产生云端 LLM 调用

### 重要：禁用 OpenClaw 内置标题生成

内置功能和本插件都会写入 `displayName`。内置功能通常先执行，导致插件检测到已有标题后跳过该会话。

OpenClaw 2026.7.1 暂时没有提供专门的关闭开关。将 `utilityModel` 设置为字符串 `"none"` **并不表示禁用**，它仍会被当作模型引用解析。

目前可使用一个明确不存在的完整模型引用：

```json
{
  "agents": {
    "defaults": {
      "utilityModel": "disabled/none"
    }
  }
}
```

这样内置 utility model 在准备阶段就会返回空结果，不再回退到主模型。注意：这也会同时禁用 Telegram Topic 标题、Discord 自动线程标题等其他 `utilityModel` 任务。

### 功能

- **自动重命名**：首次助手回复完成后生成标题
- **LLM 模式**：调用兼容 OpenAI 的 Chat Completions API
- **Extract 模式**：无需 LLM 的确定性标题提取
- **本地模型重试**：模型尚未启动时不会立即永久回退
- **输出清洗**：处理引号、Markdown、标题前缀和空泛后缀
- **Reset 检测**：会话重置后清除旧标题并重新命名
- **名称守卫**：恢复被其他进程覆盖的插件标题
- **持久化追踪**：记录在 `.auto-rename-tracker.json`

### v2.3 更新内容

- 本地 LLM 暂时不可用时自动重试，不再立即留下劣质回退标题
- 修复将“自动重命名插件更新说明”错误解析成“件更新说明”的问题
- 强化中文标题提示词，并加入独立 system message
- 适当移除“更新说明”等信息量较低的尾缀
- 将最大生成量从 80 tokens 降至 32 tokens
- 移除可能导致插件热重载失效的模块级单例锁

### 安装

将仓库克隆到 OpenClaw 插件目录：

```bash
git clone https://github.com/MCwasd/openclaw-auto-rename-plugin.git \
  ~/.openclaw/plugins/auto-rename
```

在 `~/.openclaw/openclaw.json` 中加入：

```json
{
  "agents": {
    "defaults": {
      "utilityModel": "disabled/none"
    }
  },
  "plugins": {
    "entries": {
      "auto-rename": {
        "enabled": true,
        "config": {
          "llmEndpoint": "http://localhost:8081/v1/chat/completions",
          "llmModel": "Qwen3VL-2B-Instruct-Q4_K_M.gguf",
          "llmApiKey": "",
          "retryMaxAttempts": 30
        }
      }
    },
    "load": {
      "paths": [
        "~/.openclaw/plugins/auto-rename/"
      ]
    }
  }
}
```

安装或更新插件源码后重启 Gateway：

```bash
openclaw gateway restart
```

OpenClaw 可以热加载插件配置，但 Node.js 模块缓存可能继续运行旧源码，因此修改插件源码后建议重启。

### 配置项

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---:|---|
| `enabled` | boolean | `true` | 是否启用插件 |
| `pollIntervalMs` | integer | `8000` | 会话轮询间隔，单位毫秒 |
| `titleMaxLen` | integer | `10` | 标题最大长度 |
| `mode` | string | `llm` | `llm` 或确定性的 `extract` 模式 |
| `retryMaxAttempts` | integer | `30` | LLM 连续失败多少次后使用文本回退 |
| `llmEndpoint` | string | `http://localhost:8081/v1/chat/completions` | OpenAI 兼容 API 端点 |
| `llmModel` | string | `Qwen3VL-2B-Instruct-Q4_K_M.gguf` | 请求中发送的模型名 |
| `llmApiKey` | string | 空 | 可选 Bearer Token；本地端点无需填写 |

默认每 8 秒轮询一次、最多重试 30 次，因此会等待本地模型约 4 分钟，再使用文本提取回退。

### 工作原理

1. 定期读取 Agent 会话存储。
2. 找出尚未设置 `displayName` 的会话。
3. 等待首次助手回复完整结束。
4. 提取首条用户消息和助手回复。
5. 请求配置的模型生成简短中文标题。
6. 本地模型暂时不可用时继续重试。
7. 清洗并截断模型输出。
8. 将标题写入 `sessions.json`，并记录到 `.auto-rename-tracker.json`。
9. 定期检查标题是否被覆盖，必要时自动恢复。

### 本地 llama-server 示例

```bash
llama-server \
  --host 0.0.0.0 \
  --port 8081 \
  -m /path/to/model.gguf \
  -c 8192
```

也可以使用其他兼容 OpenAI `/v1/chat/completions` 接口的服务。

## License

MIT
