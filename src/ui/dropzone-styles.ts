/**
 * Styles for the file drop zone
 */

export const traceDropZoneStyles = `
  .dropzone {
    border: 2px dashed var(--border-color);
    border-radius: var(--radius-lg);
    padding: 60px 40px;
    text-align: center;
    transition: all 0.25s ease;
    background: var(--bg-surface);
    cursor: default;
  }

  .dropzone--active {
    border-color: var(--accent);
    background: var(--accent-light);
    box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.15);
  }

  .dropzone-content {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
  }

  .dropzone-icon {
    color: var(--text-muted);
    margin-bottom: 4px;
  }

  .dropzone--active .dropzone-icon {
    color: var(--accent);
  }

  .dropzone-text {
    font-size: 1.05em;
    font-weight: 500;
    color: var(--text);
  }

  .dropzone-sub {
    font-size: 0.88em;
    color: var(--text-muted);
  }

  /* Quick reload actions */
  .quick-actions {
    margin-top: 20px;
    padding: 16px 20px;
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    border-radius: var(--radius);
    text-align: center;
  }

  .quick-actions-title {
    font-size: 0.8em;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 10px;
  }

  .quick-actions-row {
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: center;
  }

  /* Default path hint */
  .default-path-hint {
    margin-top: 16px;
    padding: 10px 16px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-sm);
    text-align: center;
    font-size: 0.78em;
    color: var(--text-muted);
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, monospace;
    word-break: break-all;
  }
`;
