// Auto-Rename Plugin for OpenClaw
// 自动检测新对话并在首次回复后生成会话名
// v2.2 - 新增：Reset检测 + 名称守卫（防回退）
// - Reset检测：会话重置后清除旧名称和tracker，等待新对话重命名
// - 名称守卫：gateway覆盖displayName时自动恢复
import { definePluginEntry, createSubsystemLogger } from "openclaw/plugin-sdk/core";
import fs from "node:fs";
import path from "node:path";

const log = createSubsystemLogger("auto-rename");

// === Singleton guard ===
let _registered = false;

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

// === Extract a clean Chinese title from LLM output ===
function extractTitleFromLLMOutput(text, maxLen = 10) {
  if (!text) return null;
  let cleaned = text
    .replace(/^(我们|需要|要求|需用|根据|用户|让我们).*?(标题|概括|可以).{0,10}?[：:]/s, "")
    .replace(/^(所以|因此|最终|直接|最).{0,5}?[：:]/s, "")
    .replace(/^[「『""]/, "")
    .replace(/[」』""]$/, "")
    .trim();

  const chineseWords = cleaned.match(/[\u4e00-\u9fff]{2,6}/g);
  if (chineseWords && chineseWords.length > 0) {
    const last = chineseWords[chineseWords.length - 1];
    if (last.length >= 2 && last.length <= maxLen) return last;
    if (chineseWords.length >= 2) {
      const prev = chineseWords[chineseWords.length - 2];
      if (prev.length >= 2 && prev.length <= maxLen) return prev;
    }
    if (last.length > maxLen) return last.slice(0, maxLen);
  }

  const first = cleaned.replace(/[^\u4e00-\u9fff]/g, "").trim();
  if (first.length >= 2) return first.slice(0, maxLen);

  const justText = cleaned.replace(/[，。！？、；：""「」『』【】\[\](){}<>《》\n\r\s]+/g, "").trim();
  if (justText.length >= 2) return justText.slice(0, maxLen);

  return null;
}

// === Generate title via LLM ===
async function generateTitleViaLLM(firstUserMsg, firstAssistantMsg, config) {
  let apiKey = config.llmApiKey || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || "";
  let endpoint = config.llmEndpoint || "http://localhost:8081/v1/chat/completions";
  let model = config.llmModel || "Qwen3VL-2B-Instruct-Q4_K_M.gguf";

  const isLocal = endpoint.includes("localhost") || endpoint.includes("127.0.0.1");
  if (!apiKey && !isLocal) {
    log.warn("No API key for LLM title generation, using extract fallback");
    return null;
  }

  const userMsg = (firstUserMsg || "").slice(0, 150);
  const assistantMsg = (firstAssistantMsg || "").slice(0, 150);
  const prompt = `生成3-10字中文标题概括对话主题。\n用户说：${userMsg}\n${assistantMsg ? `助手说：${assistantMsg}\n` : ""}\n[TITLE]`;

  try {
    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const resp = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: model.includes("/") ? model.split("/").pop() : model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 80,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      log.warn(`LLM API ${resp.status}`);
      return null;
    }

    const result = await resp.json();
    const msg = result?.choices?.[0]?.message || {};
    const content = (msg.content || "").trim();
    const reasoning = (msg.reasoning_content || "").trim();

    let text = content || reasoning;
    if (!text) return null;

    const pureChinese = text.replace(/[^\u4e00-\u9fff]/g, "");
    if (pureChinese.length >= 2 && pureChinese.length <= (config.titleMaxLen || 10)) {
      return pureChinese;
    }

    return extractTitleFromLLMOutput(text, config.titleMaxLen || 10);
  } catch (err) {
    log.warn(`LLM call: ${err.message}`);
    return null;
  }
}

// === Simple title extraction (fallback) ===
function extractTitle(text, maxLen = 10) {
  if (!text || text.length === 0) return "新对话";
  let cleaned = text
    .replace(/^(你好|嗨|hi|hello|hey|请问|帮我|我想|我要|能不能|可以|来|给我|开始)\s*/i, "")
    .trim();
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
    if (_registered) { log.info("Singleton guard prevented duplicate"); return; }
    _registered = true;

    const config = api.pluginConfig || {};
    if (config.enabled === false) { log.info("Plugin disabled"); return; }

    const pollIntervalMs = config.pollIntervalMs || 8000;
    const titleMaxLen = config.titleMaxLen || 10;
    const mode = config.mode || "llm";

    log.info(`v2.2 started (interval=${pollIntervalMs}ms, mode=${mode})`);

    const renamedSessions = new Set();
    const waitingSessions = new Set();

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
    // 当一个会话被 reset，OpenClaw 会创建  sessionId.jsonl.reset.TIMESTAMP 文件
    // 此时应清除旧的 displayName 和 tracker 条目，让新对话可以重命名
    function detectAndHandleResets(sessionsDir, sessions, files) {
      const tracker = loadTracker(sessionsDir);
      let trackerChanged = false;
      let sessionsChanged = false;

      for (const [sessionKey, sessionData] of Object.entries(sessions)) {
        const sessionId = sessionData.sessionId;
        if (!sessionId) continue;

        // 检查此 session 是否有 .reset. 文件
        const hasResetFile = files.some(f => f.startsWith(sessionId) && f.includes(".reset."));
        if (!hasResetFile) continue;

        // 如果之前重命名过，清除
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
    // 长时间不用的会话再对话时，gateway 可能恢复默认标题
    // 定期检查 tracker 中的会话，如果 displayName 被改掉就重新写入
    function guardNames(sessionsDir, sessions, files) {
      const tracker = loadTracker(sessionsDir);
      let changed = false;

      for (const [sessionKey, meta] of Object.entries(tracker)) {
        const sessionData = sessions[sessionKey];
        if (!sessionData) continue;

        // 跳过仍有 reset 文件的会话（已通过 detectAndHandleResets 处理）
        const sessionId = sessionData.sessionId;
        if (sessionId && files.some(f => f.startsWith(sessionId) && f.includes(".reset."))) {
          continue;
        }

        const currentName = sessionData.displayName || sessionData.display_name || "";
        if (currentName !== meta.title) {
          sessionData.displayName = meta.title;
          changed = true;
          log.info(`🛡 Guarded name "${meta.title}" → ${sessionKey.slice(0, 48)}...`);
        }
      }

      return changed;
    }

    // ─── 主轮询逻辑 ────────────────────────────────────
    async function poll() {
      try {
        const sessionsDir = getSessionsDir();
        if (!fs.existsSync(sessionsDir)) return;

        // 读取 files + sessions.json（一次性）
        const files = fs.readdirSync(sessionsDir);
        const result = readSessionsJson(sessionsDir);
        if (!result) return;
        const { data: sessions, filePath: sessionsFilePath } = result;

        let anyChange = false;

        // Phase 1: 处理 Reset 会话
        anyChange = detectAndHandleResets(sessionsDir, sessions, files) || anyChange;

        // Phase 2: 名称守卫（反回退）
        anyChange = guardNames(sessionsDir, sessions, files) || anyChange;

        // Phase 3: 新会话重命名
        for (const [sessionKey, sessionData] of Object.entries(sessions)) {
          if (renamedSessions.has(sessionKey)) continue;
          if (sessionData.displayName || sessionData.display_name) {
            renamedSessions.add(sessionKey);
            continue;
          }

          const sessionId = sessionData.sessionId;
          if (!sessionId) continue;

          // 找活跃的 jsonl 文件（排除 .reset. / .deleted / .trajectory）
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
          }
          if (!title) {
            title = extractTitle(firstUserMsg, titleMaxLen);
          }
          if (!title || title.length < 2) title = "新对话";

          if (sessions[sessionKey]) {
            sessions[sessionKey].displayName = title;
            renamedSessions.add(sessionKey);
            saveTrackerEntry(sessionsDir, sessionKey, title);
            anyChange = true;
            log.info(`✅ Renamed → "${title}" (${sessionKey.slice(0, 48)}...)`);
          }
        }

        // 一次性写入 sessions.json（减少磁盘写入，防竞态）
        if (anyChange) writeSessionsJson(sessionsFilePath, sessions);

      } catch (err) {
        const msg = (err && typeof err === 'object' ? (err.message || String(err)) : String(err)) || 'unknown';
        if (msg.includes("abort") || (err && err.code === "ABORT_ERR")) return;
        log.warn(`Poll: ${msg.slice(0, 200)}`);
      }
    }

    // 独立的 saveTrackerEntry（供 Phase 3 用，不依赖内部 trackers 变量）
    function saveTrackerEntry(sessionsDir, sessionKey, title) {
      try {
        const tracker = loadTracker(sessionsDir);
        tracker[sessionKey] = { title, renamedAt: Date.now() };
        writeTracker(sessionsDir, tracker);
      } catch (e) { log.warn(`Tracker write: ${e.message}`); }
    }

    // Init
    const sessionsDir = getSessionsDir();
    if (fs.existsSync(sessionsDir)) syncTrackers(sessionsDir);

    const intervalId = setInterval(poll, pollIntervalMs);
    setTimeout(() => poll(), 2000);

    try {
      if (typeof api.runtime?.lifecycle?.onCleanup === 'function') {
        api.runtime.lifecycle.onCleanup(() => {
          clearInterval(intervalId);
          _registered = false;
          log.info("Stopped");
        });
      }
    } catch {}
  },
});
