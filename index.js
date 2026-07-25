// Auto-Rename Plugin for OpenClaw
// 自动检测新对话并在首次回复后生成会话名
// v2.8 - 极简：代码侧零限制，标题质量完全由模型提示词决定
// - 不校验字符数、不删词、不压缩、不拒绝任何非空输出
// - 插件唯一工作：调模型 → 拿到输出 → 写入 displayName
import { definePluginEntry, createSubsystemLogger } from "openclaw/plugin-sdk/core";
import fs from "node:fs";
import path from "node:path";

const log = createSubsystemLogger("auto-rename");

// 插件生命周期由 OpenClaw 管理；不要使用模块级单例锁，避免热重载后显示 enabled 但轮询器未启动。

// === Persistent tracker ===
function getTrackerPath(sessionsDir) {
  return path.join(sessionsDir, ".auto-rename-tracker.json");
}
function loadTracker(sessionsDir) {
  try { return JSON.parse(fs.readFileSync(getTrackerPath(sessionsDir), "utf-8")); }
  catch { return {}; }
}
function writeTracker(sessionsDir, tracker) {
  try {
    fs.writeFileSync(getTrackerPath(sessionsDir), JSON.stringify(tracker, null, 2), "utf-8");
  } catch (e) { log.warn(`Tracker write: ${e.message}`); }
}

// === Session file helpers ===

function readSessionsJson(sessionsDir) {
  const filePath = path.join(sessionsDir, "sessions.json");
  try {
    return { data: JSON.parse(fs.readFileSync(filePath, "utf-8")), filePath };
  } catch { return null; }
}

function writeSessionsJson(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
    return true;
  } catch (e) {
    log.warn(`Sessions write: ${e.message}`);
    return false;
  }
}

function extractFirstUserMessage(sessionFile) {
  try {
    for (const line of fs.readFileSync(sessionFile, "utf-8").split("\n").filter(Boolean)) {
      try {
        const entry = JSON.parse(line);
        if (entry.type !== "message") continue;
        const msg = entry.message || {};
        if (msg.role !== "user") continue;
        const content = msg.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block && block.type === "text" && typeof block.text === "string") {
              const t = block.text.trim();
              if (t && !t.startsWith("/")) return t;
            }
          }
        } else if (typeof content === "string" && !content.startsWith("/")) {
          return content.trim();
        }
      } catch {}
    }
  } catch {}
  return null;
}

function hasCompleteAssistantReply(sessionFile) {
  try {
    for (const line of fs.readFileSync(sessionFile, "utf-8").split("\n").filter(Boolean)) {
      try {
        const entry = JSON.parse(line);
        if (entry.type !== "message") continue;
        const msg = entry.message || {};
        if (msg.role !== "assistant") continue;
        const content = msg.content;
        if (Array.isArray(content)) {
          if (content.some(c => c && c.type === "text" && typeof c.text === "string" && c.text.trim().length > 0))
            return true;
        } else if (typeof content === "string" && content.trim().length > 0) {
          return true;
        }
      } catch {}
    }
  } catch {}
  return false;
}

function extractFirstAssistantReply(sessionFile) {
  try {
    for (const line of fs.readFileSync(sessionFile, "utf-8").split("\n").filter(Boolean)) {
      try {
        const entry = JSON.parse(line);
        if (entry.type !== "message") continue;
        const msg = entry.message || {};
        if (msg.role !== "assistant") continue;
        const content = msg.content;
        if (Array.isArray(content)) {
          const tb = content.find(c => c && c.type === "text" && typeof c.text === "string" && c.text.trim().length > 20);
          if (tb) return tb.text.trim().slice(0, 300);
        } else if (typeof content === "string" && content.trim().length > 20) {
          return content.trim().slice(0, 300);
        }
      } catch {}
    }
  } catch {}
  return "";
}

// === Generate title via LLM ===
// 代码不对模型输出做任何校验或清洗。质量由提示词控制。
async function generateTitleViaLLM(firstUserMsg, firstAssistantMsg, config) {
  let apiKey = config.llmApiKey || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || "";
  let endpoint = config.llmEndpoint || "http://localhost:8081/v1/chat/completions";
  let model = config.llmModel || "Qwen3VL-2B-Instruct-Q4_K_M.gguf";

  const isLocal = endpoint.includes("localhost") || endpoint.includes("127.0.0.1");
  if (!apiKey && !isLocal) {
    log.warn("No API key for LLM title generation, using extract fallback");
    return null;
  }

  const userMsg = (firstUserMsg || "").slice(0, 300);
  const prompt = `根据用户消息生成一个简洁清晰的中文会话标题。

要求：
- 用"核心对象 + 具体意图"概括，不要照抄原句
- 英文产品名、技术名词、型号和数字按需保留
- 优先简练，但信息完整比刻意短更重要
- 只输出标题，不要解释、前缀、引号、换行

用户消息：${userMsg}
标题：`;

  try {
    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const resp = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: model.includes("/") ? model.split("/").pop() : model,
        messages: [
          { role: "system", content: "你是会话标题生成器。根据对话主题输出简洁清晰的中文标题。保留核心对象和意图，保留英文产品名和数字。只输出标题，不要解释。" },
          { role: "user", content: prompt }
        ],
        max_tokens: 48,
        temperature: 0.2,
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!resp.ok) {
      log.warn(`LLM API ${resp.status}`);
      return null;
    }

    const result = await resp.json();
    const content = (result?.choices?.[0]?.message?.content || "").trim();
    return content || null;
  } catch (err) {
    log.warn(`LLM call: ${err.message}`);
    return null;
  }
}

// === Simple title extraction (fallback) ===
function extractTitle(text, maxLen = 12) {
  if (!text || text.length === 0) return "新对话";
  let cleaned = text
    .replace(/openclaw/gi, "OC")
    .replace(/^(目前|现在|当前)\s*/, "")
    .replace(/^(你好|嗨|hi|hello|hey|请问|帮我|我想|我要|能不能|可以|来|给我|开始)\s*/i, "")
    .trim();

  const channelQuery = cleaned.match(/^(OC).*?(?:配置|支持).*?频道/i);
  if (channelQuery) return "OC频道配置查询";

  const sentences = cleaned.split(/[，。！？\n;；,]/).filter(Boolean);
  const firstSeg = sentences[0] || cleaned;
  let title = firstSeg.slice(0, maxLen).trim();
  if (title.length < 2) title = text.slice(0, maxLen).trim();
  title = title.replace(/[，。！？\s,;；\/@#\$%^&*]+$/, "").trim();
  return title || "新对话";
}

// === Plugin entry ===
export default definePluginEntry({
  id: "auto-rename",
  name: "自动会话重命名",
  description: "新对话首次回复后自动根据上下文生成会话名",
  register(api) {
    const config = api.pluginConfig || {};
    if (config.enabled === false) { log.info("Plugin disabled"); return; }

    const pollIntervalMs = config.pollIntervalMs || 8000;
    const mode = config.mode || "llm";

    log.info(`v2.8 started (interval=${pollIntervalMs}ms, mode=${mode})`);

    const renamedSessions = new Set();
    const waitingSessions = new Set();
    const llmFailureCounts = new Map();

    function getSessionsDir() {
      const homeDir = process.env.HOME || process.env.USERPROFILE || "/tmp";
      const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(homeDir, ".openclaw");
      return path.join(stateDir, "agents", "main", "sessions");
    }

    function syncTrackers(sessionsDir) {
      for (const key of Object.keys(loadTracker(sessionsDir))) renamedSessions.add(key);
      const result = readSessionsJson(sessionsDir);
      if (result) {
        for (const [key, val] of Object.entries(result.data)) {
          if (val.displayName || val.display_name) renamedSessions.add(key);
        }
      }
    }

    // ─── 检测 & 处理 reset 会话 ──────────────────────────
    function detectAndHandleResets(sessionsDir, sessions, files) {
      const tracker = loadTracker(sessionsDir);
      let trackerChanged = false;
      let sessionsChanged = false;

      for (const [sessionKey, sessionData] of Object.entries(sessions)) {
        const sessionId = sessionData.sessionId;
        if (!sessionId) continue;

        const hasResetFile = files.some(f => f.startsWith(sessionId) && f.includes(".reset."));
        if (!hasResetFile) continue;

        if (tracker[sessionKey] || renamedSessions.has(sessionKey)) {
          delete tracker[sessionKey];
          renamedSessions.delete(sessionKey);
          trackerChanged = true;

          if (sessionData.displayName !== undefined) {
            delete sessionData.displayName;
            sessionsChanged = true;
          }
          if (sessionData.display_name !== undefined) {
            delete sessionData.display_name;
            sessionsChanged = true;
          }

          log.info(`🔄 Reset detected → cleared "${sessionKey.slice(0, 48)}..."`);
        }
      }

      if (trackerChanged) writeTracker(sessionsDir, tracker);
      return sessionsChanged;
    }

    // ─── 名称守卫：防止 gateway 覆盖 displayName ─────────
    function guardNames(sessionsDir, sessions, files) {
      const tracker = loadTracker(sessionsDir);
      let changed = false;

      for (const [sessionKey, meta] of Object.entries(tracker)) {
        const sessionData = sessions[sessionKey];
        if (!sessionData) continue;

        const sessionId = sessionData.sessionId;
        if (sessionId && files.some(f => f.startsWith(sessionId) && f.includes(".reset."))) {
          continue;
        }

        const currentName = sessionData.displayName || sessionData.display_name || "";
        if (currentName !== meta.title) {
          sessionData.displayName = meta.title;
          changed = true;
          log.info(`🛡 Guarded name → "${meta.title}" (${sessionKey.slice(0, 48)}...)`);
        }
      }

      return changed;
    }

    // ─── 主轮询逻辑 ────────────────────────────────────
    async function poll() {
      try {
        const sessionsDir = getSessionsDir();
        if (!fs.existsSync(sessionsDir)) return;

        const files = fs.readdirSync(sessionsDir);
        const result = readSessionsJson(sessionsDir);
        if (!result) return;
        const { data: sessions, filePath: sessionsFilePath } = result;

        let anyChange = false;

        anyChange = detectAndHandleResets(sessionsDir, sessions, files) || anyChange;
        anyChange = guardNames(sessionsDir, sessions, files) || anyChange;

        for (const [sessionKey, sessionData] of Object.entries(sessions)) {
          if (renamedSessions.has(sessionKey)) continue;
          if (sessionData.displayName || sessionData.display_name) {
            renamedSessions.add(sessionKey);
            continue;
          }

          const sessionId = sessionData.sessionId;
          if (!sessionId) continue;

          let sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);
          if (!fs.existsSync(sessionFile)) {
            try {
              const match = files.find(
                f => f.startsWith(sessionId) && f.endsWith(".jsonl") &&
                  !f.includes(".reset.") && !f.includes(".trajectory") && !f.includes(".deleted")
              );
              if (match) sessionFile = path.join(sessionsDir, match);
              else continue;
            } catch { continue; }
          }

          if (!hasCompleteAssistantReply(sessionFile)) {
            if (extractFirstUserMessage(sessionFile)) waitingSessions.add(sessionKey);
            continue;
          }

          const firstUserMsg = extractFirstUserMessage(sessionFile);
          if (!firstUserMsg) continue;
          const firstAssistantMsg = extractFirstAssistantReply(sessionFile);

          let title = null;
          if (mode === "llm") {
            title = await generateTitleViaLLM(firstUserMsg, firstAssistantMsg, config);
            if (!title) {
              const failures = (llmFailureCounts.get(sessionKey) || 0) + 1;
              llmFailureCounts.set(sessionKey, failures);
              const retryMaxAttempts = config.retryMaxAttempts || 5;
              if (failures < retryMaxAttempts) {
                log.info(`⏳ LLM unavailable; retry ${failures}/${retryMaxAttempts} → ${sessionKey.slice(0, 48)}...`);
                continue;
              }
              log.warn(`LLM failed ${failures} times; using extract fallback → ${sessionKey.slice(0, 48)}...`);
            } else {
              llmFailureCounts.delete(sessionKey);
            }
          }
          if (!title) {
            title = extractTitle(firstUserMsg);
          }
          if (!title) title = "新对话";

          if (sessions[sessionKey]) {
            sessions[sessionKey].displayName = title;
            renamedSessions.add(sessionKey);
            saveTrackerEntry(sessionsDir, sessionKey, title);
            anyChange = true;
            log.info(`✅ Renamed → "${title}" (${sessionKey.slice(0, 48)}...)`);
          }
        }

        if (anyChange) writeSessionsJson(sessionsFilePath, sessions);

      } catch (err) {
        const msg = (err && typeof err === 'object' ? (err.message || String(err)) : String(err)) || 'unknown';
        if (msg.includes("abort") || (err && err.code === "ABORT_ERR")) return;
        log.warn(`Poll: ${msg.slice(0, 200)}`);
      }
    }

    function saveTrackerEntry(sessionsDir, sessionKey, title) {
      try {
        const tracker = loadTracker(sessionsDir);
        tracker[sessionKey] = { title, renamedAt: Date.now() };
        writeTracker(sessionsDir, tracker);
      } catch (e) { log.warn(`Tracker write: ${e.message}`); }
    }

    const sessionsDir = getSessionsDir();
    if (fs.existsSync(sessionsDir)) syncTrackers(sessionsDir);

    const intervalId = setInterval(poll, pollIntervalMs);
    setTimeout(() => poll(), 2000);

    try {
      if (typeof api.runtime?.lifecycle?.onCleanup === 'function') {
        api.runtime.lifecycle.onCleanup(() => {
          clearInterval(intervalId);
          log.info("Stopped");
        });
      }
    } catch {}
  },
});
