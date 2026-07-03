/**
 * 文件解析器（浏览器端）
 * 在浏览器中解析 trace 文件，支持两种格式：
 * 1. JSONL 格式：每行一个 JSON 对象
 * 2. Nginx 访问日志格式：包含 request_body 字段的嵌入式 JSON
 */

import type { TraceEntry, TraceSummary } from "./types.js";

// ── 摘要生成 ─────────────────────────────────────────────────────────

/**
 * 将完整的 TraceEntry 转换为 TraceSummary（用于列表展示）
 * 提取关键信息并生成预览内容，减少内存占用
 */
function toSummary(entry: TraceEntry): TraceSummary {
  // 系统提示词预览：截取前 120 个字符，对象类型则 JSON 序列化后截取
  const systemPreview =
    typeof entry.system === "string"
      ? entry.system.slice(0, 120)
      : entry.system != null
        ? JSON.stringify(entry.system).slice(0, 120)
        : undefined;

  // 用户提示词预览：截取前 120 个字符
  const promptPreview = entry.prompt?.slice(0, 120);

  // 统计 messages 中所有 tool_calls 的数量
  let toolCallCount = 0;
  if (entry.messages) {
    for (const msg of entry.messages) {
      const m = msg as Record<string, unknown>;
      const calls = m.tool_calls;
      if (calls && Array.isArray(calls)) {
        toolCallCount += calls.length;
      }
    }
  }

  return {
    ts: entry.ts,
    seq: entry.seq,
    stage: entry.stage,
    runId: entry.runId,
    sessionId: entry.sessionId,
    sessionKey: entry.sessionKey,
    provider: entry.provider,
    modelId: entry.modelId,
    modelApi: entry.modelApi,
    messageCount: entry.messageCount ?? entry.messages?.length,
    toolCount: entry.toolCount ?? entry.tools?.length,
    toolCallCount,
    note: entry.note,
    error: entry.error,
    systemPreview,
    promptPreview,
    hasSystem: entry.system != null,
    hasPrompt: entry.prompt != null && entry.prompt.length > 0,
    hasMessages: entry.messages != null && entry.messages.length > 0,
    hasTools: entry.tools != null && entry.tools.length > 0,
    hasToolCalls: toolCallCount > 0,
  };
}

// ── 结果类型 ─────────────────────────────────────────────────────────

export interface ParseResult {
  entries: TraceEntry[];
  summaries: TraceSummary[];
  error?: string;
}

// ── Nginx 访问日志解析器 ────────────────────────────────────────────

/**
 * 从 Nginx 访问日志行中提取 request_body JSON
 * 日志格式示例：... "request_body:{...JSON...}" "upstream_response_time:..." ...
 *
 * 使用括号计数法找到 JSON 对象的结束位置，支持嵌套对象
 */
function extractNginxRequestBody(line: string): string | null {
  const marker = '"request_body:';
  const idx = line.indexOf(marker);
  if (idx === -1) return null;

  const jsonStart = idx + marker.length;

  // 使用括号计数法找到匹配的闭合括号
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = jsonStart; i < line.length; i++) {
    const ch = line[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (ch === '"' && !escaped) {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        // 找到匹配的闭合括号
        return line.substring(jsonStart, i + 1);
      }
    }
  }

  return null;
}

/**
 * 从 Nginx 日志行中提取时间戳
 * 格式：[30/Jun/2026:20:39:33 +0800]
 */
function extractNginxTimestamp(line: string): string | null {
  const match = line.match(/\[(\d{2}\/[A-Z][a-z]{2}\/\d{4}:\d{2}:\d{2}:\d{2}\s[+-]\d{4})\]/);
  if (!match) return null;

  // 将 Nginx 日期格式解析为 ISO 格式
  const parts = match[1].match(
    /(\d{2})\/([A-Z][a-z]{2})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})\s([+-]\d{4})/,
  );
  if (!parts) return match[1];

  const months: Record<string, string> = {
    Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
    Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
  };
  const month = months[parts[2]];
  if (!month) return match[1];

  const [, day, , year, hour, min, sec, tz] = parts;
  // 格式化为 ISO 8601
  const tzSign = tz[0];
  const tzHours = tz.slice(1, 3);
  const tzMins = tz.slice(3, 5);
  return `${year}-${month}-${day}T${hour}:${min}:${sec}${tzSign}${tzHours}:${tzMins}`;
}

/**
 * 将 chat completion 请求体转换为 TraceEntry
 * 从请求体中提取 system prompt、user prompt、messages、tools 等信息
 */
function requestBodyToEntry(body: Record<string, unknown>, ts: string, seq: number): TraceEntry {
  const messages = body.messages as unknown[] | undefined;
  const tools = body.tools as Record<string, unknown>[] | undefined;

  // 从 messages 数组中提取系统提示词
  let system: unknown = undefined;
  let prompt: string | undefined;

  if (messages && messages.length > 0) {
    const sysMsg = messages.find(
      (m) => (m as Record<string, unknown>).role === "system",
    );
    if (sysMsg) {
      system = (sysMsg as Record<string, unknown>).content;
    }

    // 获取最后一条用户消息作为提示词预览
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i] as Record<string, unknown>;
      if (msg.role === "user") {
        const content = msg.content;
        if (typeof content === "string") {
          prompt = content.slice(0, 500);
        } else if (Array.isArray(content)) {
          // 处理多模态内容，提取所有 text 类型部分
          const textParts = content
            .filter((p: Record<string, unknown>) => p.type === "text")
            .map((p: Record<string, unknown>) => p.text as string)
            .join("\n");
          prompt = textParts.slice(0, 500);
        }
        break;
      }
    }
  }

  // 标准化工具定义格式
  const normalizedTools = tools?.map((t) => {
    const func = (t.function || t) as Record<string, unknown>;
    return {
      name: func.name as string,
      description: func.description as string,
      parameters: func.parameters as Record<string, unknown>,
    };
  });

  return {
    ts,
    seq,
    stage: "chat.completion",
    modelId: body.model as string,
    modelApi: body.model as string,
    system,
    prompt,
    messages,
    tools: normalizedTools as TraceEntry["tools"],
    messageCount: messages?.length,
    toolCount: normalizedTools?.length,
    provider: extractProvider(body.model as string),
  };
}

/**
 * 根据模型 ID 提取服务商信息
 */
function extractProvider(modelId?: string): string | undefined {
  if (!modelId) return undefined;
  if (modelId.startsWith("qwen")) return "qwen";
  if (modelId.startsWith("gpt") || modelId.startsWith("o1") || modelId.startsWith("o3")) return "openai";
  if (modelId.startsWith("claude")) return "anthropic";
  return undefined;
}

/**
 * 解析 Nginx 访问日志格式
 * 流程：逐行扫描 → 提取 request_body → 解析 JSON → 转换为 TraceEntry
 */
function parseNginxLog(content: string): ParseResult {
  const lines = content.split("\n");
  const entries: TraceEntry[] = [];
  let skipped = 0;
  let seq = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // 跳过不像是 chat completion 请求的行
    if (!line.includes("chat/completions") && !line.includes("request_body:")) {
      continue;
    }

    const jsonStr = extractNginxRequestBody(line);
    if (!jsonStr) {
      skipped++;
      continue;
    }

    try {
      const body = JSON.parse(jsonStr) as Record<string, unknown>;
      const ts = extractNginxTimestamp(line) || new Date().toISOString();
      seq++;
      entries.push(requestBodyToEntry(body, ts, seq));
    } catch {
      skipped++;
    }
  }

  if (skipped > 0) {
    console.warn(`Skipped ${skipped} unparseable nginx log line(s)`);
  }

  const summaries = entries.map(toSummary);
  return { entries, summaries };
}

// ── JSONL 解析器 ────────────────────────────────────────────────────

/**
 * 解析 JSONL 格式
 * 流程：逐行扫描 → 解析 JSON → 补充 seq（如缺失）→ 转换为 TraceEntry
 */
function parseJSONL(content: string): ParseResult {
  const lines = content.split("\n");
  const entries: TraceEntry[] = [];
  let skipped = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    try {
      const entry = JSON.parse(line) as TraceEntry;
      // 如果没有 seq，使用行号作为序号
      if (entry.seq == null) {
        entry.seq = i + 1;
      }
      entries.push(entry);
    } catch {
      skipped++;
    }
  }

  if (skipped > 0) {
    console.warn(`Skipped ${skipped} invalid JSONL line(s)`);
  }

  const summaries = entries.map(toSummary);
  return { entries, summaries };
}

// ── 自动检测与解析入口 ──────────────────────────────────────────────

/**
 * 解析文件内容，自动检测格式
 * 支持：
 * - JSONL：每行一个 JSON 对象
 * - Nginx 访问日志：行中包含 "request_body:" 及嵌入式 JSON
 */
export function parseFile(content: string): ParseResult {
  // 如果包含 Nginx 格式标记，优先尝试 Nginx 格式解析
  if (content.includes('"request_body:')) {
    const result = parseNginxLog(content);
    if (result.entries.length > 0) return result;
  }

  // 回退到 JSONL 格式解析
  return parseJSONL(content);
}

// ── 分页逻辑 ───────────────────────────────────────────────────────

export interface PageResult {
  summaries: TraceSummary[];
  page: number;
  pageSize: number;
  totalLines: number;
  totalPages: number;
}

/**
 * 根据页码和每页大小获取分页数据
 * 自动处理边界情况（页码超出范围时自动调整）
 */
export function getPage(
  summaries: TraceSummary[],
  page: number,
  pageSize: number,
): PageResult {
  const totalLines = summaries.length;
  const totalPages = Math.max(1, Math.ceil(totalLines / pageSize));
  // 确保页码在有效范围内
  const safePage = Math.max(1, Math.min(page, totalPages));
  const start = (safePage - 1) * pageSize;
  const slice = summaries.slice(start, start + pageSize);

  return {
    summaries: slice,
    page: safePage,
    pageSize,
    totalLines,
    totalPages,
  };
}

/**
 * 根据序列号查找完整的 TraceEntry
 */
export function getEntryBySeq(entries: TraceEntry[], seq: number): TraceEntry | null {
  return entries.find((e) => e.seq === seq) ?? null;
}

// ── 文件读取 ───────────────────────────────────────────────────────

/**
 * 使用 FileReader 将 File 对象读取为文本
 */
export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`));
    reader.readAsText(file);
  });
}