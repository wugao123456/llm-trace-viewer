/**
 * Main Application Component
 * Manages state and renders the trace view
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

/** IndexedDB key for stored file handle */
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

  connectedCallback() {
    super.connectedCallback();
    this.initTheme();
    this.checkSavedFile();
  }

  private initTheme() {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const stored = localStorage.getItem("llm-trace-viewer-theme");
    this.theme = (stored as "light" | "dark") || (prefersDark ? "dark" : "light");
    this.applyTheme();

    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
      if (!localStorage.getItem("llm-trace-viewer-theme")) {
        this.theme = e.matches ? "dark" : "light";
        this.applyTheme();
      }
    });
  }

  private applyTheme() {
    document.documentElement.setAttribute("data-theme", this.theme);
    this.setAttribute("data-theme", this.theme);
  }

  private toggleTheme() {
    this.theme = this.theme === "light" ? "dark" : "light";
    localStorage.setItem("llm-trace-viewer-theme", this.theme);
    this.applyTheme();
  }

  private async checkSavedFile() {
    try {
      const handle = await loadFileHandle(HANDLE_KEY);
      if (handle) {
        this.savedFileName = handle.name;
      }
    } catch {
      // IndexedDB not available, ignore
    }
  }

  private async handleFile(file: File) {
    this.loading = true;
    this.error = null;

    try {
      const content = await readFileAsText(file);
      const result = parseFile(content);

      if (result.error) {
        this.error = result.error;
        return;
      }

      this.fileName = file.name;
      this.allEntries = result.entries;
      this.allSummaries = result.summaries;
      this.page = 1;
      this.applyPagination();
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.loading = false;
    }
  }

  private async reloadSavedFile() {
    this.loading = true;
    this.error = null;

    try {
      const handle = await loadFileHandle(HANDLE_KEY);
      if (!handle) {
        this.error = "No saved file found. Please choose a file.";
        return;
      }

      // Check permission
      const opts: FileSystemHandlePermissionDescriptor = { mode: "read" };
      if ((await handle.queryPermission(opts)) !== "granted") {
        await handle.requestPermission(opts);
      }

      const file = await readFileFromHandle(handle);
      await this.handleFile(file);
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.loading = false;
    }
  }

  private applyPagination() {
    const pageResult = getPage(this.allSummaries, this.page, this.pageSize);
    this.summaries = pageResult.summaries;
    this.totalLines = pageResult.totalLines;
    this.totalPages = pageResult.totalPages;
    this.page = pageResult.page;
  }

  private handleRefresh() {
    this.applyPagination();
  }

  private handlePageChange(newPage: number) {
    this.page = newPage;
    this.applyPagination();
  }

  private handleViewDetail(summary: TraceSummary) {
    this.detailLoading = true;
    this.detailEntry = summary as unknown as TraceEntry;

    const entry = getEntryBySeq(this.allEntries, summary.seq);
    if (entry) {
      this.detailEntry = entry;
    }

    this.detailLoading = false;

    void this.updateComplete.then(() => setupOverflowDetection(this.renderRoot));
  }

  private handleCloseDetail() {
    this.detailEntry = null;
    this.detailLoading = false;
  }

  // ── File input handlers ──────────────────────────────────────────

  private handleFileInputChange(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) {
      void this.handleFile(file);
    }
  }

  private handleDragOver(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    this.dragOver = true;
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = "copy";
    }
  }

  private handleDragLeave(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    this.dragOver = false;
  }

  private handleDrop(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    this.dragOver = false;

    const file = e.dataTransfer?.files?.[0];
    if (file) {
      void this.handleFile(file);
    }
  }

  private handleOpenFilePicker() {
    const input = this.renderRoot.querySelector<HTMLInputElement>("#file-input");
    input?.click();
  }

  /**
   * Use File System Access API to pick a file and persist its handle.
   * Falls back to <input type="file"> if API is unavailable.
   */
  private async handlePickAndSave() {
    try {
      if ("showOpenFilePicker" in window) {
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
        // Save handle for quick reload
        await saveFileHandle(HANDLE_KEY, handle);
        this.savedFileName = handle.name;

        const file = await readFileFromHandle(handle);
        await this.handleFile(file);
      } else {
        this.handleOpenFilePicker();
      }
    } catch (err) {
      // User cancelled the picker
      if ((err as DOMException)?.name === "AbortError") return;
      this.handleOpenFilePicker();
    }
  }

  private async handleClearSavedFile() {
    await removeFileHandle(HANDLE_KEY);
    this.savedFileName = null;
  }

  // ── Render ───────────────────────────────────────────────────────

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

  render() {
    if (!this.fileName) {
      return this.renderDropZone();
    }

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
          onRefresh: () => this.handleRefresh(),
          onPageChange: (p) => this.handlePageChange(p),
          onViewDetail: (s) => this.handleViewDetail(s),
          onCloseDetail: () => this.handleCloseDetail(),
        })}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "trace-app": TraceApp;
  }
}
