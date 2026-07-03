/**
 * Trace 视图渲染模块
 * 负责 trace 条目列表和详情弹窗的主要渲染逻辑
 * 
 * 核心功能：
 * 1. 渲染 trace 列表表格（含分页）
 * 2. 渲染详情弹窗（含完整的 entry 数据）
 * 3. 支持图片灯箱预览
 * 4. 支持可展开的长内容区域
 * 5. 支持下载单条 entry 为 JSON 文件
 */

import { html, nothing } from "lit";
import type {
  TraceEntry,
  TraceSummary,
  TraceStage,
  TraceToolDef,
} from "./types.js";

// ── 类型定义 ───────────────────────────────────────────────────────

export interface TraceProps {
  loading: boolean;
  error: string | null;
  file: string | null;
  summaries: TraceSummary[];
  page: number;
  pageSize: number;
  totalPages: number;
  totalLines: number;
  detailEntry: TraceEntry | null;
  detailLoading: boolean;
  focusSection: string | null;
  compareEntry: TraceEntry | null;
  compareOldEntry: TraceEntry | null;
  onRefresh: () => void;
  onPageChange: (page: number) => void;
  onViewDetail: (summary: TraceSummary, focusSection?: string) => void;
  onCloseDetail: () => void;
  onCompare: (summary: TraceSummary) => void;
  onCloseCompare: () => void;
}

/** 单条差异描述 */
interface DiffItem {
  label: string;
  oldValue: string | null;
  newValue: string | null;
}

// ── 工具函数 ───────────────────────────────────────────────────────

/**
 * 打开图片灯箱预览
 * 支持点击遮罩或按 Esc 键关闭
 */
function openImageLightbox(dataUrl: string, mimeType: string) {
  const existing = document.getElementById("trace-image-lightbox");
  if (existing) {
    existing.remove();
  }

  const overlay = document.createElement("div");
  overlay.id = "trace-image-lightbox";
  overlay.className = "trace-lightbox-overlay";
  overlay.innerHTML = `
    <div class="trace-lightbox-content">
      <div class="trace-lightbox-header">
        <span class="trace-lightbox-label">Image (${mimeType})</span>
        <button class="trace-lightbox-close" title="Close">✕</button>
      </div>
      <div class="trace-lightbox-body">
        <img class="trace-lightbox-image" src="${dataUrl}" alt="Full size image" />
      </div>
    </div>
  `;

  // 点击遮罩关闭
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) {
      overlay.remove();
    }
  });

  // 点击关闭按钮
  const closeBtn = overlay.querySelector(".trace-lightbox-close");
  closeBtn?.addEventListener("click", () => overlay.remove());

  // 按 Esc 键关闭
  const handleKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      overlay.remove();
      document.removeEventListener("keydown", handleKeydown);
    }
  };
  document.addEventListener("keydown", handleKeydown);

  document.body.appendChild(overlay);
}

/**
 * 格式化时间戳显示
 * 支持 ISO 格式和其他常见格式
 */
function formatTime(value?: string | null) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

/**
 * 根据 stage 类型返回对应的 badge CSS 类名
 * 用于不同阶段显示不同颜色
 */
function stageBadgeClass(stage?: TraceStage): string {
  if (!stage) {
    return "";
  }
  if (stage.startsWith("session:")) {
    return "info";
  }
  if (stage.startsWith("prompt:")) {
    return "warn";
  }
  if (stage.startsWith("stream:")) {
    return "success";
  }
  return "";
}

/**
 * 判断字符串是否为 base64 编码的图片
 * 通过检测图片格式的魔数（magic number）来识别
 */
function isBase64Image(str: string): boolean {
  if (str.length < 100) {
    return false;
  }
  return /^\/9j\/|^iVBOR|^R0lGOD|^UklGR|^Qk1Q/i.test(str);
}

/**
 * 截断过长的 base64 字符串，避免渲染性能问题
 */
function truncateBase64(str: string, maxLen = 50): string {
  if (str.length <= maxLen) {
    return str;
  }
  return `${str.slice(0, maxLen)}...`;
}

/**
 * 渲染多行文本内容，保留换行符
 */
function renderTextContent(content: string) {
  const lines = content.split("\n");
  return html`${lines.map((line, i) =>
    i < lines.length - 1 ? html`${line}<br />` : html`${line}`,
  )}`;
}

// ── 消息内容渲染 ───────────────────────────────────────────────────

/**
 * 递归渲染消息内容
 * 支持多种类型：字符串、数组、图片、文本块、思考内容、工具调用等
 */
function renderMessageContent(content: unknown): ReturnType<typeof html> {
  // null/undefined
  if (content == null) {
    return html`<span class="muted">null</span>`;
  }

  // 字符串类型（可能是 base64 图片或普通文本）
  if (typeof content === "string") {
    if (isBase64Image(content)) {
      return html`<span class="trace-base64">${truncateBase64(content)}</span>`;
    }
    return html`<div class="trace-content-block trace-text-content">${renderTextContent(content)}</div>`;
  }

  // 数组类型（多模态内容）
  if (Array.isArray(content)) {
    return html`
      <div class="trace-array">
        ${content.map(
          (item, idx) => html`
            <div class="trace-array-item">
              <span class="trace-array-index">[${idx}]</span>
              ${renderMessageContent(item)}
            </div>
          `,
        )}
      </div>
    `;
  }

  // 对象类型（结构化内容）
  if (typeof content === "object") {
    const obj = content as Record<string, unknown>;

    // 图片类型（多模态）
    if (obj.type === "image" && typeof obj.data === "string") {
      const mimeType = (obj.mimeType as string) || "image/jpeg";
      const dataUrl = `data:${mimeType};base64,${obj.data}`;
      return html`
        <div class="trace-image-container">
          <div class="trace-image-label">Image (${mimeType}) - Click to view full size</div>
          <img
            class="trace-image trace-image-clickable"
            src="${dataUrl}"
            alt="Message image"
            loading="lazy"
            @click=${() => openImageLightbox(dataUrl, mimeType)}
          />
        </div>
      `;
    }

    // 文本类型
    if (obj.type === "text" && typeof obj.text === "string") {
      return html`
        <div class="trace-text-block trace-content-block">
          <span class="trace-content-type">[text]</span>
          <div class="trace-text-content">${renderTextContent(obj.text)}</div>
        </div>
      `;
    }

    // 思考内容类型
    if (obj.type === "thinking" && typeof obj.thinking === "string") {
      return html`
        <div class="trace-thinking-block trace-content-block trace-content-block--thinking">
          <span class="trace-content-type">[thinking]</span>
          <div class="trace-text-content">${renderTextContent(obj.thinking)}</div>
        </div>
      `;
    }

    // 工具使用类型（tool_use）
    if (obj.type === "tool_use") {
      return html`
        <div class="trace-tool-block trace-content-block trace-content-block--tool">
          <span class="trace-content-type">[${obj.type}: ${obj.name || "unknown"}]</span>
          <pre class="trace-tool-args">${JSON.stringify(obj.input, null, 2)}</pre>
        </div>
      `;
    }

    // 工具调用类型（toolCall）
    if (obj.type === "toolCall") {
      return html`
        <div class="trace-tool-block trace-content-block trace-content-block--tool">
          <span class="trace-content-type">[${obj.type}: ${obj.name || "unknown"}]</span>
          <pre class="trace-tool-args">${JSON.stringify(obj.arguments, null, 2)}</pre>
        </div>
      `;
    }

    // 其他对象类型：递归渲染每个字段
    return html`
      <div class="trace-object">
        ${Object.entries(obj).map(([key, value]) => {
          if (key === "data" && typeof value === "string" && isBase64Image(value)) {
            return html`
              <div class="trace-field">
                <span class="trace-key">${key}:</span>
                <span class="trace-base64">${truncateBase64(value)}</span>
              </div>
            `;
          }
          return html`
            <div class="trace-field">
              <span class="trace-key">${key}:</span>
              ${renderMessageContent(value)}
            </div>
          `;
        })}
      </div>
    `;
  }

  // 默认：序列化为字符串
  const stringValue = JSON.stringify(content);
  return html`<span class="trace-value">${stringValue}</span>`;
}

// ── 可展开区域控制 ─────────────────────────────────────────────────

/**
 * 切换可展开区域的展开/收起状态
 */
function toggleExpand(e: Event) {
  const btn = e.target as HTMLElement;
  const container = btn.closest(".trace-expandable-container");
  if (!container) {
    return;
  }

  const content = container.querySelector(".trace-expandable-content") as HTMLElement;
  if (!content) {
    return;
  }

  const isExpanded = container.classList.contains("expanded");
  if (isExpanded) {
    container.classList.remove("expanded");
    btn.textContent = "Show more \u2193";
  } else {
    container.classList.add("expanded");
    btn.textContent = "Show less \u2191";
  }
}

/**
 * 切换整个 section 的显示/隐藏状态
 */
function toggleSection(e: Event) {
  const section = (e.target as HTMLElement).closest(".trace-flat-section");
  if (!section) {
    return;
  }

  const content = section.querySelector(".trace-flat-content") as HTMLElement;
  if (!content) {
    return;
  }

  const isCollapsed = section.classList.contains("collapsed");
  const toggleBtn = section.querySelector(".trace-section-toggle");

  if (isCollapsed) {
    content.style.maxHeight = `${content.scrollHeight}px`;
    section.classList.remove("collapsed");
    if (toggleBtn) {
      toggleBtn.textContent = "\u25BC";
      toggleBtn.setAttribute("title", "Collapse");
    }
  } else {
    content.style.maxHeight = `${content.scrollHeight}px`;
    requestAnimationFrame(() => {
      content.style.maxHeight = "0";
    });
    section.classList.add("collapsed");
    if (toggleBtn) {
      toggleBtn.textContent = "\u25B6";
      toggleBtn.setAttribute("title", "Expand");
    }
  }
}

/**
 * 检查内容是否溢出，决定是否显示展开按钮
 */
function checkOverflow(container: Element) {
  const content = container.querySelector(".trace-expandable-content") as HTMLElement;
  if (!content) {
    return;
  }
  if (content.scrollHeight > 350) {
    container.classList.add("overflowing");
  } else {
    container.classList.remove("overflowing");
  }
}

/**
 * 设置溢出检测
 * 在渲染完成后（requestAnimationFrame）检查所有可展开区域
 */
export function setupOverflowDetection(root?: Document | DocumentFragment | ShadowRoot | Element) {
  requestAnimationFrame(() => {
    const searchRoot = root || document;
    const containers = searchRoot.querySelectorAll(
      ".trace-expandable-container:not(.overflow-checked)",
    );
    containers.forEach((container) => {
      container.classList.add("overflow-checked");
      checkOverflow(container);
    });

    const sections = searchRoot.querySelectorAll(".trace-flat-section");
    sections.forEach((section) => {
      if (!section.classList.contains("collapsed")) {
        const content = section.querySelector(".trace-flat-content") as HTMLElement;
        if (content) {
          content.style.maxHeight = `${content.scrollHeight}px`;
        }
      }
    });
  });
}

// ── JSON Schema 属性渲染 ───────────────────────────────────────────

/**
 * 递归渲染 JSON Schema 的 properties
 * 用于展示工具参数的结构定义
 */
function renderJsonSchemaProperties(
  properties: Record<string, Record<string, unknown>>,
  required: string[] = [],
  depth = 0,
): ReturnType<typeof html> | typeof nothing {
  const entries = Object.entries(properties);
  if (entries.length === 0) {
    return nothing;
  }

  return html`
    <div class="trace-param-props" style="margin-left: ${depth > 0 ? 12 : 0}px">
      ${entries.map(([name, schema]) => {
        const isRequired = required.includes(name);
        const type = schema.type as string | undefined;
        const desc = schema.description as string | undefined;
        const enumValues = schema.enum as string[] | undefined;
        const items = schema.items as Record<string, unknown> | undefined;
        const nestedProps = schema.properties as
          | Record<string, Record<string, unknown>>
          | undefined;
        const nestedRequired = schema.required as string[] | undefined;

        return html`
          <div class="trace-param-item">
            <div class="trace-param-header">
              <span class="trace-param-name">${name}</span>
              ${type
                ? html`<span class="trace-param-type">${type}${type === "array" && items?.type ? `[${items.type}]` : ""}</span>`
                : nothing}
              ${isRequired
                ? html`<span class="trace-param-required">required</span>`
                : nothing}
              ${enumValues
                ? html`<span class="trace-param-enum">${enumValues.map((v) => `"${v}"`).join(" | ")}</span>`
                : nothing}
            </div>
            ${desc
              ? html`<div class="trace-param-desc">${desc}</div>`
              : nothing}
            ${nestedProps
              ? renderJsonSchemaProperties(nestedProps, nestedRequired ?? [], depth + 1)
              : nothing}
            ${items && items.properties
              ? html`
                  <div class="trace-param-items-label">items:</div>
                  ${renderJsonSchemaProperties(
                    items.properties as Record<string, Record<string, unknown>>,
                    (items.required as string[]) ?? [],
                    depth + 1,
                  )}
                `
              : nothing}
          </div>
        `;
      })}
    </div>
  `;
}

// ── 工具定义渲染 ───────────────────────────────────────────────────

/**
 * 渲染单个工具定义（名称、描述、参数）
 * 支持折叠/展开
 */
function renderToolDef(tool: TraceToolDef, index: number) {
  const params = tool.parameters as Record<string, unknown> | undefined;
  const properties = params?.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  const required = params?.required as string[] | undefined;

  return html`
    <div class="trace-tool-def">
      <div class="trace-tool-def-header" @click=${toggleToolDef}>
        <button class="trace-tool-def-toggle" title="Collapse">▼</button>
        <span class="trace-tool-def-index">#${index + 1}</span>
        <span class="trace-tool-name">${tool.name}</span>
        ${tool.description
          ? html`<span class="trace-tool-def-desc-preview">${tool.description.slice(0, 60)}${tool.description.length > 60 ? "..." : ""}</span>`
          : nothing}
      </div>
      <div class="trace-tool-def-body">
        ${tool.description
          ? html`<div class="trace-tool-description">${tool.description}</div>`
          : nothing}
        ${properties
          ? html`
              <div class="trace-tool-params">
                <div class="trace-tool-params-title">Parameters</div>
                ${renderJsonSchemaProperties(properties, required ?? [])}
              </div>
            `
          : nothing}
      </div>
    </div>
  `;
}

/**
 * 切换单个工具定义的折叠/展开
 */
function toggleToolDef(e: Event) {
  const header = (e.target as HTMLElement).closest(".trace-tool-def-header");
  if (!header) return;
  const toolDef = header.closest(".trace-tool-def") as HTMLElement;
  if (!toolDef) return;

  const body = toolDef.querySelector(".trace-tool-def-body") as HTMLElement;
  if (!body) return;

  const isCollapsed = toolDef.classList.contains("collapsed");
  const toggleBtn = toolDef.querySelector(".trace-tool-def-toggle");

  if (isCollapsed) {
    toolDef.classList.remove("collapsed");
    body.style.maxHeight = `${body.scrollHeight}px`;
    if (toggleBtn) {
      toggleBtn.textContent = "\u25BC";
      toggleBtn.setAttribute("title", "Collapse");
    }
  } else {
    body.style.maxHeight = `${body.scrollHeight}px`;
    requestAnimationFrame(() => {
      body.style.maxHeight = "0";
    });
    toolDef.classList.add("collapsed");
    if (toggleBtn) {
      toggleBtn.textContent = "\u25B6";
      toggleBtn.setAttribute("title", "Expand");
    }
  }
}

// ── 消息渲染 ───────────────────────────────────────────────────────

/**
 * 渲染单条消息（包含角色、索引、时间戳、内容、工具调用）
 */
function renderMessage(message: unknown, index: number) {
  const msg = message as Record<string, unknown>;
  const role = (msg.role as string) || "unknown";
  const content = msg.content;
  const timestamp = msg.timestamp
    ? formatTime(new Date(msg.timestamp as number).toISOString())
    : null;

  return html`
    <div class="trace-message">
      <div class="trace-message-header" @click=${toggleMessage}>
        <button class="trace-message-toggle" title="Collapse message">▼</button>
        <span class="trace-message-role ${role}">${role}</span>
        <span class="trace-message-index">#${index + 1}</span>
        ${timestamp ? html`<span class="trace-message-time mono">${timestamp}</span>` : nothing}
        ${msg.model ? html`<span class="trace-message-model mono">${msg.model}</span>` : nothing}
      </div>
      <div class="trace-message-body trace-expandable-container">
        <div class="trace-expandable-content">
          ${renderMessageContent(content)}
          ${renderToolCalls(msg.tool_calls)}
        </div>
        <button class="trace-expand-btn" @click=${toggleExpand}>Show more ↓</button>
      </div>
    </div>
  `;
}

/**
 * 切换单条消息的折叠/展开状态
 */
function toggleMessage(e: Event) {
  const btn = e.target as HTMLElement;
  const message = btn.closest(".trace-message");
  if (!message) {
    return;
  }

  const body = message.querySelector(".trace-message-body") as HTMLElement;
  if (!body) {
    return;
  }

  const isCollapsed = message.classList.contains("collapsed");
  const toggleBtn = message.querySelector(".trace-message-toggle");

  if (isCollapsed) {
    message.classList.remove("collapsed");
    body.style.maxHeight = `${body.scrollHeight}px`;
    if (toggleBtn) {
      toggleBtn.textContent = "\u25BC";
      toggleBtn.setAttribute("title", "Collapse message");
    }
  } else {
    body.style.maxHeight = `${body.scrollHeight}px`;
    requestAnimationFrame(() => {
      body.style.maxHeight = "0";
    });
    message.classList.add("collapsed");
    if (toggleBtn) {
      toggleBtn.textContent = "\u25B6";
      toggleBtn.setAttribute("title", "Expand message");
    }
  }
}

/**
 * 渲染 assistant 消息中的 tool_calls 字段
 * 格式：[{ id, type, function: { name, arguments } }]
 */
function renderToolCalls(toolCalls: unknown): ReturnType<typeof html> | typeof nothing {
  if (!toolCalls || !Array.isArray(toolCalls)) {
    return nothing;
  }

  if (toolCalls.length === 0) {
    return nothing;
  }

  return html`
    <div class="trace-tool-calls">
      <div class="trace-tool-calls-title">Tool Calls (${toolCalls.length})</div>
      ${toolCalls.map((tc, idx) => {
        const call = tc as Record<string, unknown>;
        const func = call.function as Record<string, unknown> | undefined;
        const name = func?.name as string | undefined;
        const args = func?.arguments;

        let argsDisplay = "";
        if (typeof args === "string") {
          try {
            argsDisplay = JSON.stringify(JSON.parse(args), null, 2);
          } catch {
            argsDisplay = args;
          }
        } else if (args) {
          argsDisplay = JSON.stringify(args, null, 2);
        }

        return html`
          <div class="trace-tool-call">
            <div class="trace-tool-call-header">
              <span class="trace-tool-call-index">#${idx + 1}</span>
              <span class="trace-tool-call-name">${name || "unknown"}</span>
              ${call.id ? html`<span class="trace-tool-call-id mono">${call.id}</span>` : nothing}
            </div>
            <pre class="trace-tool-call-args">${argsDisplay}</pre>
          </div>
        `;
      })}
    </div>
  `;
}

// ── 差异对比 ───────────────────────────────────────────────────────

/** 将 undefined / null / 空字符串统一为 null，避免空值差异被当作有效变更 */
function normalizeValue(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "string" && v.trim() === "") return null;
  return typeof v === "string" ? v : JSON.stringify(v, null, 2);
}

/**
 * 对比两个 TraceEntry 的差异，返回差异项列表
 * 用于"和上一轮对比"功能
 */
function diffEntries(oldEntry: TraceEntry | null, newEntry: TraceEntry): DiffItem[] {
  const diffs: DiffItem[] = [];

  if (!oldEntry) {
    diffs.push({ label: "状态", oldValue: null, newValue: "这是第一条记录，没有上一轮" });
    return diffs;
  }

  // 对比 stage
  if (normalizeValue(oldEntry.stage) !== normalizeValue(newEntry.stage)) {
    diffs.push({
      label: "Stage",
      oldValue: normalizeValue(oldEntry.stage),
      newValue: normalizeValue(newEntry.stage),
    });
  }

  // 对比 provider
  if (normalizeValue(oldEntry.provider) !== normalizeValue(newEntry.provider)) {
    diffs.push({
      label: "Provider",
      oldValue: normalizeValue(oldEntry.provider),
      newValue: normalizeValue(newEntry.provider),
    });
  }

  // 对比 model
  const oldModel = normalizeValue(oldEntry.modelId || oldEntry.modelApi);
  const newModel = normalizeValue(newEntry.modelId || newEntry.modelApi);
  if (oldModel !== newModel) {
    diffs.push({
      label: "Model",
      oldValue: oldModel,
      newValue: newModel,
    });
  }

  // 对比 system
  const oldSystem = normalizeValue(
    typeof oldEntry.system === "string" ? oldEntry.system : JSON.stringify(oldEntry.system, null, 2)
  );
  const newSystem = normalizeValue(
    typeof newEntry.system === "string" ? newEntry.system : JSON.stringify(newEntry.system, null, 2)
  );
  if (oldSystem !== newSystem) {
    diffs.push({
      label: "System Prompt",
      oldValue: oldSystem,
      newValue: newSystem,
    });
  }

  // 对比 prompt
  const oldPrompt = normalizeValue(oldEntry.prompt);
  const newPrompt = normalizeValue(newEntry.prompt);
  if (oldPrompt !== newPrompt) {
    diffs.push({
      label: "Prompt",
      oldValue: oldPrompt,
      newValue: newPrompt,
    });
  }

  // 对比消息数量
  const oldMsgCount = oldEntry.messages?.length ?? 0;
  const newMsgCount = newEntry.messages?.length ?? 0;
  if (oldMsgCount !== newMsgCount) {
    diffs.push({
      label: "Message Count",
      oldValue: String(oldMsgCount),
      newValue: String(newMsgCount),
    });
  }

  // 对比 tool_calls 数量
  const oldToolCalls = countToolCalls(oldEntry);
  const newToolCalls = countToolCalls(newEntry);
  if (oldToolCalls !== newToolCalls) {
    diffs.push({
      label: "Tool Calls",
      oldValue: String(oldToolCalls),
      newValue: String(newToolCalls),
    });
  }

  // 对比工具定义
  const oldTools = (oldEntry.tools ?? []) as TraceToolDef[];
  const newTools = (newEntry.tools ?? []) as TraceToolDef[];
  const oldToolNames = oldTools.map((t) => t.name);
  const newToolNames = newTools.map((t) => t.name);
  const added = newToolNames.filter((n) => !oldToolNames.includes(n));
  const removed = oldToolNames.filter((n) => !newToolNames.includes(n));

  if (added.length > 0) {
    diffs.push({
      label: "Tools Added",
      oldValue: null,
      newValue: added.join(", "),
    });
  }
  if (removed.length > 0) {
    diffs.push({
      label: "Tools Removed",
      oldValue: removed.join(", "),
      newValue: null,
    });
  }

  // 对比 options
  const oldOptions = normalizeValue(oldEntry.options);
  const newOptions = normalizeValue(newEntry.options);
  if (oldOptions !== newOptions) {
    diffs.push({
      label: "Options",
      oldValue: oldOptions,
      newValue: newOptions,
    });
  }

  // 对比 note
  const oldNote = normalizeValue(oldEntry.note);
  const newNote = normalizeValue(newEntry.note);
  if (oldNote !== newNote) {
    diffs.push({
      label: "Note",
      oldValue: oldNote,
      newValue: newNote,
    });
  }

  return diffs;
}

/** 统计 entry 中的 tool_calls 总数 */
function countToolCalls(entry: TraceEntry): number {
  let count = 0;
  if (entry.messages) {
    for (const msg of entry.messages) {
      const m = msg as Record<string, unknown>;
      const calls = m.tool_calls;
      if (calls && Array.isArray(calls)) {
        count += calls.length;
      }
    }
  }
  return count;
}

// ── 下载功能 ───────────────────────────────────────────────────────

/**
 * 将单条 TraceEntry 下载为 JSON 文件
 * 使用 Blob + URL.createObjectURL 实现客户端下载
 */
function downloadEntryAsJson(entry: TraceEntry) {
  const formatted = JSON.stringify(entry, null, 2);
  const blob = new Blob([formatted], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const timestamp = entry.ts ? new Date(entry.ts).toISOString().replace(/[:.]/g, "-") : "unknown";
  const filename = `trace-${entry.stage || "entry"}-${timestamp}.json`;

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── 详情弹窗渲染 ───────────────────────────────────────────────────

/**
 * 渲染详情弹窗
 * 包含：元信息、系统提示词、用户提示词、消息列表、工具列表、错误信息
 */
function renderDetailModal(entry: TraceEntry, loading: boolean, onClose: () => void, focusSection?: string) {
  // 格式化系统提示词（字符串或对象）
  const systemContent =
    typeof entry.system === "string"
      ? entry.system
      : entry.system != null
        ? JSON.stringify(entry.system, null, 2)
        : null;

  // 非加载状态时设置溢出检测
  if (!loading) {
    setupOverflowDetection();
  }

  // 下载按钮点击处理（阻止事件冒泡）
  const handleDownload = (e: Event) => {
    e.stopPropagation();
    downloadEntryAsJson(entry);
  };

  // 展开所有 section
  const handleExpandAll = (e: Event) => {
    e.stopPropagation();
    const modal = (e.target as HTMLElement).closest(".trace-modal");
    if (!modal) return;
    const sections = modal.querySelectorAll(".trace-flat-section");
    sections.forEach((section) => {
      section.classList.remove("collapsed");
      const content = section.querySelector(".trace-flat-content") as HTMLElement;
      if (content) {
        content.style.maxHeight = `${content.scrollHeight}px`;
      }
      const toggleBtn = section.querySelector(".trace-section-toggle");
      if (toggleBtn) {
        toggleBtn.textContent = "\u25BC";
        toggleBtn.setAttribute("title", "Collapse");
      }
    });
  };

  // 关闭所有 section
  const handleCollapseAll = (e: Event) => {
    e.stopPropagation();
    const modal = (e.target as HTMLElement).closest(".trace-modal");
    if (!modal) return;
    const sections = modal.querySelectorAll(".trace-flat-section");
    sections.forEach((section) => {
      const content = section.querySelector(".trace-flat-content") as HTMLElement;
      if (content) {
        content.style.maxHeight = `${content.scrollHeight}px`;
      }
      requestAnimationFrame(() => {
        section.classList.add("collapsed");
        const c = section.querySelector(".trace-flat-content") as HTMLElement;
        if (c) {
          c.style.maxHeight = "0";
        }
      });
      const toggleBtn = section.querySelector(".trace-section-toggle");
      if (toggleBtn) {
        toggleBtn.textContent = "\u25B6";
        toggleBtn.setAttribute("title", "Expand");
      }
    });
  };

  return html`
    <div class="trace-modal-overlay" @click=${onClose}>
      <div class="trace-modal" @click=${(e: Event) => e.stopPropagation()}>
        <div class="trace-modal-header">
          <div class="trace-modal-title">
            <div class="trace-modal-title-row">
              <span class="trace-seq-badge mono">#${entry.seq}</span>
              ${entry.sessionKey
                ? html`<span class="trace-session-badge mono" title="${entry.sessionKey}"
                    >${entry.sessionKey}</span
                  >`
                : nothing}
              <span class="trace-stage badge ${stageBadgeClass(entry.stage)}">${entry.stage}</span>
            </div>
            <span class="trace-modal-title-time mono">${formatTime(entry.ts)}</span>
          </div>
          <div class="trace-modal-actions">
            <button
              class="btn btn--small btn--ghost"
              @click=${handleExpandAll}
              title="Expand all sections"
            >
              Expand All
            </button>
            <button
              class="btn btn--small btn--ghost"
              @click=${handleCollapseAll}
              title="Collapse all sections"
            >
              Collapse All
            </button>
            <button
              class="btn btn--small btn--primary"
              @click=${handleDownload}
              title="Download as JSON"
            >
              Download
            </button>
            <button class="btn btn--small" @click=${onClose}>Close</button>
          </div>
        </div>

        <div class="trace-modal-body">
          ${loading
            ? html`<div class="trace-loading">Loading details...</div>`
            : html`
                <!-- 元信息区域 -->
                <div class="trace-meta-section">
                  <div class="trace-meta-row">
                    <div class="trace-meta-item">
                      <span class="trace-meta-label">Seq</span>
                      <span class="mono">#${entry.seq}</span>
                    </div>
                    <div class="trace-meta-item">
                      <span class="trace-meta-label">Time</span>
                      <span class="mono">${formatTime(entry.ts)}</span>
                    </div>
                  </div>
                  <div class="trace-meta-row">
                    ${entry.sessionKey
                      ? html`<div class="trace-meta-item">
                          <span class="trace-meta-label">Session</span>
                          <span class="mono" title="${entry.sessionKey}">${entry.sessionKey}</span>
                        </div>`
                      : nothing}
                    ${entry.runId
                      ? html`<div class="trace-meta-item">
                          <span class="trace-meta-label">Run ID</span>
                          <span class="mono trace-meta-truncate" title="${entry.runId}"
                            >${entry.runId}</span
                          >
                        </div>`
                      : nothing}
                  </div>
                  <div class="trace-meta-row">
                    ${entry.provider
                      ? html`<div class="trace-meta-item">
                          <span class="trace-meta-label">Provider</span>
                          <span class="mono" title="${entry.provider}">${entry.provider}</span>
                        </div>`
                      : nothing}
                    ${entry.modelId
                      ? html`<div class="trace-meta-item">
                          <span class="trace-meta-label">Model</span>
                          <span class="mono" title="${entry.modelId}">${entry.modelId}</span>
                        </div>`
                      : nothing}
                  </div>
                  ${entry.note
                    ? html`<div class="trace-meta-row">
                        <div class="trace-meta-item trace-meta-full">
                          <span class="trace-meta-label">Note</span>
                          <span title="${entry.note}">${entry.note}</span>
                        </div>
                      </div>`
                    : nothing}
                </div>

                <!-- 系统提示词 -->
                ${systemContent
                  ? html`
                      <div class="trace-flat-section ${focusSection ? "collapsed" : ""}">
                        <h3 class="trace-flat-title" @click=${toggleSection}>
                          <button class="trace-section-toggle" title="${focusSection ? "Expand" : "Collapse"}">
                            ${focusSection ? "▶" : "▼"}
                          </button>
                          System Prompt
                        </h3>
                        <div class="trace-flat-content">
                          <div class="trace-expandable-container">
                            <pre class="trace-content-block trace-expandable-content">
${systemContent}</pre
                            >
                            <button class="trace-expand-btn" @click=${toggleExpand}>
                              Show more ↓
                            </button>
                          </div>
                        </div>
                      </div>
                    `
                  : nothing}

                <!-- 用户提示词 -->
                ${entry.prompt
                  ? html`
                      <div class="trace-flat-section ${focusSection ? "collapsed" : ""}">
                        <h3 class="trace-flat-title" @click=${toggleSection}>
                          <button class="trace-section-toggle" title="${focusSection ? "Expand" : "Collapse"}">
                            ${focusSection ? "▶" : "▼"}
                          </button>
                          Prompt
                        </h3>
                        <div class="trace-flat-content">
                          <div class="trace-expandable-container">
                            <pre class="trace-content-block trace-expandable-content">
${entry.prompt}</pre
                            >
                            <button class="trace-expand-btn" @click=${toggleExpand}>
                              Show more ↓
                            </button>
                          </div>
                        </div>
                      </div>
                    `
                  : nothing}

                <!-- 消息列表 -->
                ${entry.messages && entry.messages.length > 0
                  ? html`
                      <div class="trace-flat-section ${focusSection ? "collapsed" : ""}">
                        <h3 class="trace-flat-title" @click=${toggleSection}>
                          <button class="trace-section-toggle" title="${focusSection ? "Expand" : "Collapse"}">
                            ${focusSection ? "▶" : "▼"}
                          </button>
                          Messages
                          <span class="trace-count">(${entry.messages.length})</span>
                        </h3>
                        <div class="trace-flat-content">
                          <div class="trace-messages-list">
                            ${entry.messages.map((msg: unknown, idx: number) =>
                              renderMessage(msg, idx),
                            )}
                          </div>
                        </div>
                      </div>
                    `
                  : nothing}

                <!-- 工具列表 -->
                ${entry.tools && entry.tools.length > 0
                  ? html`
                      <div class="trace-flat-section ${focusSection && focusSection !== "tools" ? "collapsed" : ""}">
                        <h3 class="trace-flat-title" @click=${toggleSection}>
                          <button class="trace-section-toggle" title="${focusSection && focusSection !== "tools" ? "Expand" : "Collapse"}">
                            ${focusSection && focusSection !== "tools" ? "▶" : "▼"}
                          </button>
                          Tools
                          <span class="trace-count">(${entry.tools.length})</span>
                        </h3>
                        <div class="trace-flat-content">
                          <div class="trace-expandable-container">
                            <div class="trace-tools-list trace-expandable-content">
                              ${entry.tools.map((tool: TraceToolDef, idx: number) => renderToolDef(tool, idx))}
                            </div>
                            <button class="trace-expand-btn" @click=${toggleExpand}>
                              Show more ↓
                            </button>
                          </div>
                        </div>
                      </div>
                    `
                  : nothing}

                <!-- 错误信息 -->
                ${entry.error
                  ? html`
                      <div class="trace-flat-section">
                        <h3 class="trace-flat-title trace-flat-title--danger">Error</h3>
                        <div class="trace-content-block trace-content-block--error">${entry.error}</div>
                      </div>
                    `
                  : nothing}
              `}
        </div>
      </div>
    </div>
  `;
}

// ── 对比弹窗 ───────────────────────────────────────────────────────

/**
 * 渲染"和上一轮对比"弹窗
 * 对比当前 trace 和上一轮的差异
 */
function renderCompareModal(
  newEntry: TraceEntry,
  oldEntry: TraceEntry | null,
  onClose: () => void,
) {
  const diffs = diffEntries(oldEntry, newEntry);
  const oldLabel = oldEntry ? `#${oldEntry.seq}` : "N/A";
  const newLabel = `#${newEntry.seq}`;

  return html`
    <div class="trace-modal-overlay" @click=${onClose}>
      <div class="trace-modal trace-compare-modal" @click=${(e: Event) => e.stopPropagation()}>
        <div class="trace-modal-header">
          <div class="trace-modal-title">
            <span class="trace-seq-badge mono">Compare</span>
            <span class="mono">${oldLabel} → ${newLabel}</span>
          </div>
          <div class="trace-modal-actions">
            <button class="btn btn--small" @click=${onClose}>Close</button>
          </div>
        </div>

        <div class="trace-modal-body">
          ${oldEntry
            ? diffs.length === 0
              ? html`<div class="trace-compare-empty">没有差异 — 两次请求完全相同</div>`
              : html`
                  <div class="trace-compare-table">
                    <div class="trace-compare-header">
                      <div class="trace-compare-cell trace-compare-label">Field</div>
                      <div class="trace-compare-cell trace-compare-old">Previous (#${oldEntry.seq})</div>
                      <div class="trace-compare-cell trace-compare-new">Current (#${newEntry.seq})</div>
                    </div>
                    ${diffs.map(
                      (diff) => html`
                        <div class="trace-compare-row">
                          <div class="trace-compare-cell trace-compare-label">${diff.label}</div>
                          <div class="trace-compare-cell trace-compare-old ${diff.oldValue === null ? "trace-compare-empty-cell" : ""}">
                            ${diff.oldValue !== null
                              ? html`<pre class="trace-compare-value">${diff.oldValue}</pre>`
                              : html`<span class="muted">—</span>`}
                          </div>
                          <div class="trace-compare-cell trace-compare-new ${diff.newValue === null ? "trace-compare-empty-cell" : ""}">
                            ${diff.newValue !== null
                              ? html`<pre class="trace-compare-value">${diff.newValue}</pre>`
                              : html`<span class="muted">—</span>`}
                          </div>
                        </div>
                      `,
                    )}
                  </div>
                `
            : html`<div class="trace-compare-empty">这是第一条记录，无法对比</div>`}
        </div>
      </div>
    </div>
  `;
}

// ── 列表行渲染 ─────────────────────────────────────────────────────

/**
 * 渲染列表中的单行记录
 * 显示：序号/时间、会话/阶段、模型、消息数、工具数、预览内容
 */
function renderSummaryRow(
  summary: TraceSummary,
  onViewDetail: (s: TraceSummary, focusSection?: string) => void,
  onCompare: (s: TraceSummary) => void,
) {
  const preview = summary.systemPreview || summary.promptPreview || "";
  const hasContent =
    summary.hasSystem || summary.hasPrompt || summary.hasMessages || summary.hasTools;

  return html`
    <tr class="trace-row" @click=${(e: Event) => {
      if ((e.target as HTMLElement).closest(".trace-tool-count, .trace-tool-call-count")) {
        onViewDetail(summary, "tools");
      } else {
        onViewDetail(summary);
      }
    }}>
      <td class="trace-cell trace-cell-time">
        <div class="trace-cell-stacked">
          <span class="trace-seq mono">#${summary.seq}</span>
          <span class="mono">${formatTime(summary.ts)}</span>
        </div>
      </td>
      <td class="trace-cell trace-cell-session-stage">
        <div class="trace-cell-stacked">
          ${summary.sessionKey
            ? html`<span class="trace-session-key mono" title="${summary.sessionKey}"
                >${summary.sessionKey}</span
              >`
            : nothing}
          <span class="trace-stage badge ${stageBadgeClass(summary.stage)}">${summary.stage}</span>
        </div>
      </td>
      <td class="trace-cell trace-cell-model">
        <div class="trace-cell-stacked">
          ${summary.provider
            ? html`<span class="trace-provider">${summary.provider}</span>`
            : nothing}
          ${summary.modelId
            ? html`<span class="trace-model mono">${summary.modelId}</span>`
            : nothing}
        </div>
      </td>
      <td class="trace-cell trace-cell-messages">
        ${summary.messageCount != null && summary.messageCount > 0
          ? html`<span class="trace-msg-count">${summary.messageCount} msgs</span>`
          : html`<span class="muted">-</span>`}
      </td>
      <td class="trace-cell trace-cell-tools">
        <div class="trace-cell-stacked" style="gap: 2px;">
          ${summary.toolCount != null && summary.toolCount > 0
            ? html`<span class="trace-tool-count" style="cursor: pointer;" title="Click to view tools only">${summary.toolCount} tools</span>`
            : nothing}
          ${summary.toolCallCount != null && summary.toolCallCount > 0
            ? html`<span class="trace-tool-call-count" style="cursor: pointer;" title="Click to view tools only">${summary.toolCallCount} calls</span>`
            : nothing}
          ${(summary.toolCount == null || summary.toolCount === 0) && (summary.toolCallCount == null || summary.toolCallCount === 0)
            ? html`<span class="muted">-</span>`
            : nothing}
        </div>
      </td>
      <td class="trace-cell trace-cell-preview">
        ${preview
          ? html`<span class="trace-preview-text"
              >${preview.slice(0, 80)}${preview.length > 80 ? "..." : ""}</span
            >`
          : hasContent
            ? html`<span class="muted">[has content]</span>`
            : html`<span class="muted">-</span>`}
      </td>
      <td class="trace-cell trace-cell-compare">
        <button
          class="btn btn--small btn--ghost trace-compare-btn"
          @click=${(e: Event) => {
            e.stopPropagation();
            onCompare(summary);
          }}
          title="Compare with previous entry"
        >
          Compare
        </button>
      </td>
    </tr>
  `;
}

// ── 分页组件渲染 ───────────────────────────────────────────────────

/**
 * 渲染分页控件
 * 包含：总条目数、首页、上一页、页码列表、下一页、末页
 */
function renderPagination(
  page: number,
  totalPages: number,
  totalLines: number,
  onPageChange: (p: number) => void,
) {
  // 只有一页时只显示条目数
  if (totalPages <= 1) {
    return html`
      <div class="trace-pagination">
        <span class="trace-pagination-info">${totalLines} entries</span>
      </div>
    `;
  }

  // 计算可见页码范围（最多显示 7 个页码）
  const pages: number[] = [];
  const maxVisible = 7;
  let start = Math.max(1, page - Math.floor(maxVisible / 2));
  const end = Math.min(totalPages, start + maxVisible - 1);
  if (end - start + 1 < maxVisible) {
    start = Math.max(1, end - maxVisible + 1);
  }
  for (let i = start; i <= end; i++) {
    pages.push(i);
  }

  return html`
    <div class="trace-pagination">
      <span class="trace-pagination-info">${totalLines} entries</span>
      <div class="trace-pagination-controls">
        <button
          class="btn btn--small"
          ?disabled=${page <= 1}
          @click=${() => onPageChange(1)}
          title="First page"
        >
          First
        </button>
        <button
          class="btn btn--small"
          ?disabled=${page <= 1}
          @click=${() => onPageChange(page - 1)}
          title="Previous page"
        >
          Prev
        </button>
        ${start > 1 ? html`<span class="trace-pagination-ellipsis">...</span>` : nothing}
        ${pages.map(
          (p) => html`
            <button
              class="btn btn--small ${p === page ? "btn--active" : ""}"
              @click=${() => onPageChange(p)}
            >
              ${p}
            </button>
          `,
        )}
        ${end < totalPages ? html`<span class="trace-pagination-ellipsis">...</span>` : nothing}
        <button
          class="btn btn--small"
          ?disabled=${page >= totalPages}
          @click=${() => onPageChange(page + 1)}
          title="Next page"
        >
          Next
        </button>
        <button
          class="btn btn--small"
          ?disabled=${page >= totalPages}
          @click=${() => onPageChange(totalPages)}
          title="Last page"
        >
          Last
        </button>
      </div>
    </div>
  `;
}

// ── 主渲染函数 ─────────────────────────────────────────────────────

/**
 * 主渲染函数
 * 渲染完整的 trace 视图，包含：标题、刷新按钮、文件信息、错误提示、分页、表格、详情弹窗
 */
export function renderTrace(props: TraceProps) {
  return html`
    <section class="trace-view">
      <div class="card">
        <div class="row" style="justify-content: space-between;">
          <div>
            <div class="card-title">LLM Trace Viewer</div>
            <div class="card-sub">
              View LLM request context and parameters. Click a row to view details.
            </div>
          </div>
          <div class="row" style="gap: 8px;">
            <button class="btn btn--primary" ?disabled=${props.loading} @click=${props.onRefresh}>
              ${props.loading ? "Loading..." : "Refresh"}
            </button>
          </div>
        </div>

        ${props.file
          ? html`<div class="muted" style="margin-top: 10px;">File: ${props.file}</div>`
          : nothing}
        ${props.error
          ? html`<div class="callout danger" style="margin-top: 10px;">${props.error}</div>`
          : nothing}
      </div>

      <!-- 顶部分页 -->
      ${renderPagination(props.page, props.totalPages, props.totalLines, props.onPageChange)}

      <!-- 表格容器 -->
      <div class="trace-table-container card">
        ${props.summaries.length === 0
          ? html`<div class="muted" style="padding: 20px">No trace entries.</div>`
          : html`
              <table class="trace-table">
                <thead>
                  <tr>
                    <th>Seq / Time</th>
                    <th>Session / Stage</th>
                    <th>Model</th>
                    <th>Msgs</th>
                    <th>Tools</th>
                    <th>Preview</th>
                    <th>Compare</th>
                  </tr>
                </thead>
                <tbody>
                  ${props.summaries.map((s) => renderSummaryRow(s, props.onViewDetail, props.onCompare))}
                </tbody>
              </table>
            `}
      </div>

      <!-- 底部分页 -->
      ${renderPagination(props.page, props.totalPages, props.totalLines, props.onPageChange)}

      <!-- 详情弹窗 -->
      ${props.detailEntry
        ? renderDetailModal(props.detailEntry, props.detailLoading, props.onCloseDetail, props.focusSection ?? undefined)
        : nothing}

      <!-- 对比弹窗 -->
      ${props.compareEntry
        ? renderCompareModal(props.compareEntry, props.compareOldEntry, props.onCloseCompare)
        : nothing}
    </section>
  `;
}