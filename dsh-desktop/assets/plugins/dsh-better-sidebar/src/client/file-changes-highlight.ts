/**
 * Inline agent-diff highlight for the sidebar editor (K28).
 *
 * Reads the session-scoped agent changes published by dsh-client-file-changes
 * on `window.__dshFileChanges` (see that plugin's client bundle) and returns
 * the per-line highlight for one file. The heavy lifting — the three-category
 * line diff (green add / red delete / yellow modify) and the path-indexed
 * query — lives in dsh-client-file-changes; this module only bridges the
 * window global into the CodeMirror editor, so the two plugins share data
 * with zero host-service coupling and zero projection duplication.
 *
 * Everything here is DOM-free/CodeMirror-free except `ensureDiffHighlightCss`,
 * so the query face can be exercised in a Node test without a browser.
 */

/** A file's resolved inline highlight (`present` = this path had agent changes). */
export interface FileHighlight {
  present: boolean
  op?: string
  seq?: number
  time?: number
  path?: string
  count?: number
  /** 'ctx' | 'add' | 'mod', aligned one-to-one with the current file's lines. */
  kinds?: Array<'ctx' | 'add' | 'mod'>
  /** Counts of outright deleted / added / changed lines (red / green / yellow). */
  removed?: number
  added?: number
  changed?: number
}

/** The window-global store shape published by dsh-client-file-changes. */
export interface FileChangesStore {
  queryFileHighlight(sessionId: string, path: string): FileHighlight | { present: false }
  subscribe(fn: () => void): () => void
  get(sessionId: string): { changes: Array<unknown>; truncated: boolean }
}

/** Read the store singleton (null when dsh-client-file-changes is absent). */
export function readFileChangesStore(): FileChangesStore | null {
  if (typeof window === 'undefined') return null
  const store = (window as unknown as { __dshFileChanges?: FileChangesStore }).__dshFileChanges
  return store !== null && typeof store === 'object' && typeof store.queryFileHighlight === 'function'
    ? store
    : null
}

/** Resolve the inline highlight for one session + path (null when no store or no changes). */
export function readFileHighlight(sessionId: string, path: string): FileHighlight | null {
  const store = readFileChangesStore()
  if (store === null) return null
  try {
    const result = store.queryFileHighlight(sessionId, path)
    return result !== null && typeof result === 'object' && (result as FileHighlight).present === true
      ? (result as FileHighlight)
      : null
  } catch {
    return null
  }
}

/** Raw CSS class suffix for a highlight kind (only add/mod are rendered). */
export function highlightKindClass(kind: 'add' | 'mod'): string {
  return kind === 'add' ? 'dsh-editor-diff-add' : 'dsh-editor-diff-mod'
}

const HIGHLIGHT_CSS_TAG = '@deepseek-ai/dsh-better-sidebar/editor-diff-highlight.css'

/**
 * Inject the two line-decoration classes once (idempotent, DSH color tokens).
 * CodeMirror line decorations use raw class names (not the CSS-module hash),
 * so these live in a dedicated style tag rather than sidebar.module.css.
 */
export function ensureDiffHighlightCss(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(HIGHLIGHT_CSS_TAG)}]`)) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-better-sidebar'
  tag.dataset.pluginCss = HIGHLIGHT_CSS_TAG
  tag.textContent = [
    '.dsh-editor-diff-add{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent);box-shadow:inset 3px 0 0 var(--dsw-alias-state-success-primary)}',
    '.dsh-editor-diff-mod{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 14%,transparent);box-shadow:inset 3px 0 0 var(--dsw-alias-state-warn-primary)}',
  ].join('')
  document.head.appendChild(tag)
}
