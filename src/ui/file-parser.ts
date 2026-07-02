/**
 * Local File Parser
 * Parses trace files entirely in the browser.
 * Supports JSONL format and nginx access log format (with request_body field).
 */

import type { TraceEntry, TraceSummary } from "./types.js";

// ── Summary generation ─────────────────────────────────────────────

function toSummary(entry: TraceEntry): TraceSummary {
  const systemPreview =
    typeof entry.system === "string"
      ? entry.system.slice(0, 120)
      : entry.system != null
        ? JSON.stringify(entry.system).slice(0, 120)
        : undefined;

  const promptPreview = entry.prompt?.slice(0, 120);

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
    note: entry.note,
    error: entry.error,
    systemPreview,
    promptPreview,
    hasSystem: entry.system != null,
    hasPrompt: entry.prompt != null && entry.prompt.length > 0,
    hasMessages: entry.messages != null && entry.messages.length > 0,
    hasTools: entry.tools != null && entry.tools.length > 0,
  };
}

// ── Result types ───────────────────────────────────────────────────

export interface ParseResult {
  entries: TraceEntry[];
  summaries: TraceSummary[];
  error?: string;
}

// ── Nginx access log parser ────────────────────────────────────────

/**
 * Extract the request_body JSON from a nginx access log line.
 * The format is: ... "request_body:{...JSON...}" "upstream_response_time:..." ...
 *
 * Uses brace counting to find the end of the JSON object.
 */
function extractNginxRequestBody(line: string): string | null {
  const marker = '"request_body:';
  const idx = line.indexOf(marker);
  if (idx === -1) return null;

  const jsonStart = idx + marker.length;

  // Use brace counting to find matching closing brace
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
        // Found the matching closing brace
        return line.substring(jsonStart, i + 1);
      }
    }
  }

  return null;
}

/**
 * Extract timestamp from nginx log line.
 * Format: [30/Jun/2026:20:39:33 +0800]
 */
function extractNginxTimestamp(line: string): string | null {
  const match = line.match(/\[(\d{2}\/[A-Z][a-z]{2}\/\d{4}:\d{2}:\d{2}:\d{2}\s[+-]\d{4})\]/);
  if (!match) return null;

  // Parse nginx date format to ISO
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
  // Format as ISO 8601
  const tzSign = tz[0];
  const tzHours = tz.slice(1, 3);
  const tzMins = tz.slice(3, 5);
  return `${year}-${month}-${day}T${hour}:${min}:${sec}${tzSign}${tzHours}:${tzMins}`;
}

/**
 * Convert a chat completion request body into a TraceEntry.
 */
function requestBodyToEntry(body: Record<string, unknown>, ts: string, seq: number): TraceEntry {
  const messages = body.messages as unknown[] | undefined;
  const tools = body.tools as Record<string, unknown>[] | undefined;

  // Extract system prompt from messages array
  let system: unknown = undefined;
  let prompt: string | undefined;

  if (messages && messages.length > 0) {
    const sysMsg = messages.find(
      (m) => (m as Record<string, unknown>).role === "system",
    );
    if (sysMsg) {
      system = (sysMsg as Record<string, unknown>).content;
    }

    // Get last user message as prompt preview
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i] as Record<string, unknown>;
      if (msg.role === "user") {
        const content = msg.content;
        if (typeof content === "string") {
          prompt = content.slice(0, 500);
        } else if (Array.isArray(content)) {
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

  // Normalize tool definitions
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

function extractProvider(modelId?: string): string | undefined {
  if (!modelId) return undefined;
  if (modelId.startsWith("qwen")) return "qwen";
  if (modelId.startsWith("gpt") || modelId.startsWith("o1") || modelId.startsWith("o3")) return "openai";
  if (modelId.startsWith("claude")) return "anthropic";
  return undefined;
}

function parseNginxLog(content: string): ParseResult {
  const lines = content.split("\n");
  const entries: TraceEntry[] = [];
  let skipped = 0;
  let seq = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Skip lines that don't look like chat completion requests
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

// ── JSONL parser ───────────────────────────────────────────────────

function parseJSONL(content: string): ParseResult {
  const lines = content.split("\n");
  const entries: TraceEntry[] = [];
  let skipped = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    try {
      const entry = JSON.parse(line) as TraceEntry;
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

// ── Auto-detect & parse ────────────────────────────────────────────

/**
 * Parse file content, auto-detecting the format.
 * Supports:
 * - JSONL: each line is a JSON object
 * - Nginx access log: lines contain "request_body:" with embedded JSON
 */
export function parseFile(content: string): ParseResult {
  // Try nginx format first if it contains the marker
  if (content.includes('"request_body:')) {
    const result = parseNginxLog(content);
    if (result.entries.length > 0) return result;
  }

  // Fall back to JSONL
  return parseJSONL(content);
}

// ── Pagination ─────────────────────────────────────────────────────

export interface PageResult {
  summaries: TraceSummary[];
  page: number;
  pageSize: number;
  totalLines: number;
  totalPages: number;
}

export function getPage(
  summaries: TraceSummary[],
  page: number,
  pageSize: number,
): PageResult {
  const totalLines = summaries.length;
  const totalPages = Math.max(1, Math.ceil(totalLines / pageSize));
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

export function getEntryBySeq(entries: TraceEntry[], seq: number): TraceEntry | null {
  return entries.find((e) => e.seq === seq) ?? null;
}

// ── File reading ───────────────────────────────────────────────────

export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`));
    reader.readAsText(file);
  });
}
