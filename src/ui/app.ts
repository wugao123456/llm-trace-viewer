/**
 * 主应用组件
 * 管理状态并渲染 trace 视图
 */

import { LitElement, html, css, unsafeCSS, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { traceStyles } from "./styles.js";
import { traceDropZoneStyles } from "./dropzone-styles.js";
import { renderTrace, setupOverflowDetection } from "./trace-view.js";
import {
  parseFile,
  getPage,
  getEntryBySeq,
  readFileAsText,
} from "./file-parser.js";
import {
  saveFileHandle,
  loadFileHandle,
  readFileFromHandle,
  removeFileHandle,
} from "./file-store.js";
import type { TraceEntry, TraceSummary } from "./types.js";

// IndexedDB 中存储文件句柄的键名
const HANDLE_KEY = "last-file";

@customElement("trace-app")
export class TraceApp extends LitElement {
  static styles = css`
    ${unsafeCSS(traceStyles)}
    ${unsafeCSS(traceDropZoneStyles)}
    :host {
      display: block;
    }
  `;

  // ── 状态管理 ───────────────────────────────────────────────────────

  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private fileName: string | null = null;
  @state() private allEntries: TraceEntry[] = [];
  @state() private allSummaries: TraceSummary[] = [];
  @state() private summaries: TraceSummary[] = [];
  @state() private page = 1;
  @state() private pageSize = 50;
  @state() private totalPages = 0;
  @state() private totalLines = 0;
  @state() private detailEntry: TraceEntry | null = null;
  @state() private detailLoading = false;
  @state() private theme: "light" | "dark" = "light";
  @state() private dragOver = false;
  @state() private savedFileName: string | null = null;
  @state() private focusSection: string | null = null;
  @state() private compareEntry: TraceEntry | null = null;
  @state() private compareOldEntry: TraceEntry | null = null;

  // ── 生命周期 ───────────────────────────────────────────────────────

  /**
   * 组件挂载时触发
   * 1. 初始化主题
   * 2. 检查是否有保存的文件句柄（用于快速重新加载）
   */
  connectedCallback() {
    super.connectedCallback();
    this.initTheme();
    this.checkSavedFile();
  }

  // ── 主题管理 ───────────────────────────────────────────────────────

  /**
   * 初始化主题设置
   * 优先级：用户本地存储 > 系统偏好设置 > 默认浅色
   */
  private initTheme() {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const stored = localStorage.getItem("llm-trace-viewer-theme");
    this.theme = (stored as "light" | "dark") || (prefersDark ? "dark" : "light");
    this.applyTheme();

    // 监听系统主题变化（仅当用户未手动设置时生效）
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
      if (!localStorage.getItem("llm-trace-viewer-theme")) {
        this.theme = e.matches ? "dark" : "light";
        this.applyTheme();
      }
    });
  }

  /**
   * 应用主题到 DOM
   * 通过 data-theme 属性控制 CSS 变量
   */
  private applyTheme() {
    document.documentElement.setAttribute("data-theme", this.theme);
    this.setAttribute("data-theme", this.theme);
  }

  /**
   * 切换明暗主题
   * 同时保存到 localStorage 持久化
   */
  private toggleTheme() {
    this.theme = this.theme === "light" ? "dark" : "light";
    localStorage.setItem("llm-trace-viewer-theme", this.theme);
    this.applyTheme();
  }

  // ── 文件句柄持久化（IndexedDB）─────────────────────────────────────

  /**
   * 检查 IndexedDB 中是否保存了上次打开的文件句柄
   * 如果有，显示快速重新加载按钮
   */
  private async checkSavedFile() {
    try {
      const handle = await loadFileHandle(HANDLE_KEY);
      if (handle) {
        this.savedFileName = handle.name;
      }
    } catch {
      // IndexedDB 不可用，忽略错误
    }
  }

  // ── 核心文件处理流程 ───────────────────────────────────────────────

  /**
   * 处理用户选择的文件（核心入口）
   * 流程：读取文件 → 解析内容 → 更新状态 → 应用分页
   */
  private async handleFile(file: File) {
    this.loading = true;
    this.error = null;

    try {
      // 1. 读取文件内容为文本
      const content = await readFileAsText(file);
      // 2. 解析 JSONL 文件，提取 entries 和 summaries
      const result = parseFile(content);

      // 解析失败时显示错误信息
      if (result.error) {
        this.error = result.error;
        return;
      }

      // 3. 更新状态：文件名、所有条目、所有摘要
      this.fileName = file.name;
      this.allEntries = result.entries;
      this.allSummaries = result.summaries;
      // 4. 重置页码并应用分页
      this.page = 1;
      this.applyPagination();
    } catch (err) {
      // 捕获并显示任何异常
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.loading = false;
    }
  }

  /**
   * 重新加载已保存的文件
   * 使用 File System Access API 直接读取上次保存的文件句柄
   * 流程：加载句柄 → 检查权限 → 读取文件 → 处理文件
   */
  private async reloadSavedFile() {
    this.loading = true;
    this.error = null;

    try {
      // 1. 从 IndexedDB 加载保存的文件句柄
      const handle = await loadFileHandle(HANDLE_KEY);
      if (!handle) {
        this.error = "No saved file found. Please choose a file.";
        return;
      }

      // 2. 检查文件读取权限，若无权限则请求
      const opts: FileSystemHandlePermissionDescriptor = { mode: "read" };
      if ((await handle.queryPermission(opts)) !== "granted") {
        await handle.requestPermission(opts);
      }

      // 3. 通过句柄读取文件并处理
      const file = await readFileFromHandle(handle);
      await this.handleFile(file);
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.loading = false;
    }
  }

  // ── 分页逻辑 ───────────────────────────────────────────────────────

  /**
   * 应用分页逻辑
   * 根据当前页码和每页大小，从所有摘要中截取当前页数据
   */
  private applyPagination() {
    const pageResult = getPage(this.allSummaries, this.page, this.pageSize);
    this.summaries = pageResult.summaries;
    this.totalLines = pageResult.totalLines;
    this.totalPages = pageResult.totalPages;
    this.page = pageResult.page;
  }

  /**
   * 刷新当前页（重新应用分页）
   */
  private handleRefresh() {
    this.applyPagination();
  }

  /**
   * 处理页码变化
   */
  private handlePageChange(newPage: number) {
    this.page = newPage;
    this.applyPagination();
  }

  // ── 详情视图 ───────────────────────────────────────────────────────

  /**
   * 查看单条记录的详细信息
   * 流程：设置加载状态 → 根据 seq 查找完整条目 → 更新详情 → 初始化溢出检测
   * @param focusSection - 可选，指定聚焦的 section（如 "tools"），只展开该 section
   */
  private handleViewDetail(summary: TraceSummary, focusSection?: string) {
    this.detailLoading = true;
    // 先用 summary 作为临时详情（防止空白）
    this.detailEntry = summary as unknown as TraceEntry;
    this.focusSection = focusSection || null;

    // 根据序列号查找完整的条目（包含更多字段）
    const entry = getEntryBySeq(this.allEntries, summary.seq);
    if (entry) {
      this.detailEntry = entry;
    }

    this.detailLoading = false;

    // 渲染完成后设置溢出检测（用于长内容的滚动提示）
    void this.updateComplete.then(() => setupOverflowDetection(this.renderRoot));
  }

  /**
   * 关闭详情面板
   */
  private handleCloseDetail() {
    this.detailEntry = null;
    this.detailLoading = false;
  }

  /**
   * 对比当前条目和上一轮
   */
  private handleCompare(summary: TraceSummary) {
    const newEntry = getEntryBySeq(this.allEntries, summary.seq);
    if (!newEntry) return;

    // 在 allEntries 中找到当前条目的位置，上一轮就是前一个条目
    const currentIdx = this.allEntries.findIndex((e) => e.seq === summary.seq);
    const oldEntry = currentIdx > 0 ? this.allEntries[currentIdx - 1] : null;
    this.compareEntry = newEntry;
    this.compareOldEntry = oldEntry;
  }

  /**
   * 关闭对比弹窗
   */
  private handleCloseCompare() {
    this.compareEntry = null;
    this.compareOldEntry = null;
  }

  // ── 文件输入处理（拖拽 + 点击）─────────────────────────────────────

  /**
   * 处理传统文件输入框的选择事件
   */
  private handleFileInputChange(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) {
      void this.handleFile(file);
    }
  }

  /**
   * 拖拽进入时的处理
   */
  private handleDragOver(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    this.dragOver = true;
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = "copy";
    }
  }

  /**
   * 拖拽离开时的处理
   */
  private handleDragLeave(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    this.dragOver = false;
  }

  /**
   * 处理文件拖放
   */
  private handleDrop(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    this.dragOver = false;

    const file = e.dataTransfer?.files?.[0];
    if (file) {
      void this.handleFile(file);
    }
  }

  /**
   * 触发隐藏的文件输入框点击
   */
  private handleOpenFilePicker() {
    const input = this.renderRoot.querySelector<HTMLInputElement>("#file-input");
    input?.click();
  }

  /**
   * 使用 File System Access API 选择文件并持久化句柄
   * 优先使用现代 API，不支持时回退到传统 input 方式
   * 流程：选择文件 → 保存句柄 → 读取并处理文件
   */
  private async handlePickAndSave() {
    try {
      // 检查浏览器是否支持 File System Access API
      if ("showOpenFilePicker" in window) {
        // 1. 使用现代 API 选择文件
        const [handle] = await window.showOpenFilePicker({
          types: [
            {
              description: "Trace Logs",
              accept: {
                "application/json": [".jsonl", ".json", ".log", ".txt"],
              },
            },
          ],
        });
        // 2. 将文件句柄保存到 IndexedDB（下次可快速加载）
        await saveFileHandle(HANDLE_KEY, handle);
        this.savedFileName = handle.name;

        // 3. 通过句柄读取文件并处理
        const file = await readFileFromHandle(handle);
        await this.handleFile(file);
      } else {
        // 回退到传统文件选择方式
        this.handleOpenFilePicker();
      }
    } catch (err) {
      // 用户取消选择时忽略
      if ((err as DOMException)?.name === "AbortError") return;
      // 其他错误时回退到传统方式
      this.handleOpenFilePicker();
    }
  }

  /**
   * 清除已保存的文件句柄
   */
  private async handleClearSavedFile() {
    await removeFileHandle(HANDLE_KEY);
    this.savedFileName = null;
  }

  // ── 渲染函数 ───────────────────────────────────────────────────────

  /**
   * 渲染文件拖放区域（初始状态）
   * 包含：标题、主题切换、拖放区域、快速重新加载按钮、错误提示
   */
  private renderDropZone() {
    return html`
      <div class="container">
        <div class="header">
          <div class="header-title">LLM Trace Viewer</div>
          <div class="header-actions">
            <button class="btn btn--small" @click=${() => this.toggleTheme()}>
              ${this.theme === "light" ? "Dark" : "Light"}
            </button>
          </div>
        </div>
        <div
          class="dropzone ${this.dragOver ? "dropzone--active" : ""}"
          @dragover=${this.handleDragOver}
          @dragleave=${this.handleDragLeave}
          @drop=${this.handleDrop}
        >
          <div class="dropzone-content">
            <div class="dropzone-icon">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
                <line x1="12" y1="18" x2="12" y2="12"/>
                <line x1="9" y1="15" x2="12" y2="12"/>
                <line x1="15" y1="15" x2="12" y2="12"/>
              </svg>
            </div>
            <div class="dropzone-text">
              ${this.loading
                ? "Loading file..."
                : "Drag & drop a JSONL trace file here"}
            </div>
            <div class="dropzone-sub">
              or
            </div>
            <button
              class="btn btn--primary"
              ?disabled=${this.loading}
              @click=${this.handlePickAndSave}
            >
              Choose File
            </button>
            <input
              id="file-input"
              type="file"
              accept=".jsonl,.json,.txt,.log"
              style="display:none"
              @change=${this.handleFileInputChange}
            />
          </div>
        </div>

        ${this.savedFileName
          ? html`
              <div class="quick-actions">
                <div class="quick-actions-title">Quick Reload</div>
                <div class="quick-actions-row">
                  <button
                    class="btn btn--primary btn--small"
                    ?disabled=${this.loading}
                    @click=${this.reloadSavedFile}
                  >
                    Reload ${this.savedFileName}
                  </button>
                  <button
                    class="btn btn--small btn--ghost"
                    @click=${this.handleClearSavedFile}
                    title="Remove saved file"
                  >
                    Clear
                  </button>
                </div>
              </div>
            `
          : nothing}

        ${this.error
          ? html`<div class="callout danger" style="margin-top: 16px;">${this.error}</div>`
          : nothing}
      </div>
    `;
  }

  /**
   * 主渲染函数
   * 根据是否已选择文件，渲染不同的视图：
   * 1. 未选择文件 → 显示拖放区域
   * 2. 已选择文件 → 显示 trace 列表和详情面板
   */
  render() {
    // 未选择文件时显示拖放区域
    if (!this.fileName) {
      return this.renderDropZone();
    }

    // 已选择文件时渲染 trace 视图
    return html`
      <div class="container">
        <div class="header">
          <div class="header-title">LLM Trace Viewer</div>
          <div class="header-actions">
            ${this.savedFileName
              ? html`
                  <button
                    class="btn btn--small btn--ghost"
                    ?disabled=${this.loading}
                    @click=${this.reloadSavedFile}
                    title="Reload ${this.savedFileName}"
                  >
                    Reload
                  </button>
                `
              : nothing}
            <button class="btn btn--small btn--ghost" @click=${() => this.handleOpenFilePicker()}>
              Open File
            </button>
            <button class="btn btn--small" @click=${() => this.toggleTheme()}>
              ${this.theme === "light" ? "Dark" : "Light"}
            </button>
          </div>
        </div>

        <!-- 渲染 trace 列表和详情视图 -->
        ${renderTrace({
          loading: this.loading,
          error: this.error,
          file: this.fileName,
          summaries: this.summaries,
          page: this.page,
          pageSize: this.pageSize,
          totalPages: this.totalPages,
          totalLines: this.totalLines,
          detailEntry: this.detailEntry,
          detailLoading: this.detailLoading,
          focusSection: this.focusSection,
          compareEntry: this.compareEntry,
          compareOldEntry: this.compareOldEntry,
          onRefresh: () => this.handleRefresh(),
          onPageChange: (p) => this.handlePageChange(p),
          onViewDetail: (s, fs) => this.handleViewDetail(s, fs),
          onCloseDetail: () => this.handleCloseDetail(),
          onCompare: (s) => this.handleCompare(s),
          onCloseCompare: () => this.handleCloseCompare(),
        })}
      </div>
    `;
  }
}

// 扩展 HTMLElementTagNameMap，支持自定义元素的类型检查
declare global {
  interface HTMLElementTagNameMap {
    "trace-app": TraceApp;
  }
}