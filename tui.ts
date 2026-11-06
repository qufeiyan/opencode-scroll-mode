import { spawn } from "node:child_process"
import { Plugin } from "@opencode/plugin/tui"

// Conversation scroll mode for the OpenCode TUI.
//
// - a toggle key (options.toggleKey, default ctrl+[) switches between edit
//   mode and scroll mode:
//   * edit mode (default): the composer keeps its readline keys
//     (ctrl+u delete-to-line-start, ctrl+d delete char, etc.).
//   * scroll mode: navigation keys move a persistent line/column cursor through
//     the transcript; j/k scroll the host only when the cursor hits a viewport
//     edge. Scrolling itself is still delegated to the built-in session.*
//     commands, and (optionally) vim keys + message search are enabled.
// - Implemented as a reactive keymap layer: the layer factory reads the
//   memory-store flag, so scroll/search bindings are registered only while
//   scroll mode is on. The rest of the time those keys reach the composer.
// - State lives in memory storage: it resets on every TUI launch and
//   survives plugin reloads.
//
// Options (plugins[].options in opencode.json):
//   vim          boolean  enable vim keys            (default true)
//   search       boolean  enable message search      (default true)
//   maxResults   number   max search results shown   (default 100)
//   searchScope  string   "all" | "user"             (default "all")
//   toggleKey    string   toggle key chord           (default "ctrl+[")
//
// Cursor and visual mode (per rendered line): scroll mode always has a real
// cursor at an absolute screen row + character column. j/k move it by line
// (scrolling at the viewport edges), h/l, w/b/e and 0/$ move the character
// end. v/V start a charwise/linewise selection at the cursor; j/k extend it,
// h/l etc. adjust the moving end. y copies the exact rendered text (including
// code blocks and soft-wrapped lines) to the system clipboard (OSC52, with
// pbcopy/xclip/wl-copy as fallback); in normal mode y copies the cursor line.
// Y copies every visible line. The line index is built from the render tree:
// TextBufferRenderable/CodeRenderable `lineInfo` maps each visual row back to
// its source line and wrap column, so code-block lines are first-class
// citizens. The host's native selection draws the row/range highlight; a
// post-process 1-cell bar marks the cursor's character cell.

// Cursor hiding must survive plugin reloads and prompt re-focus/remount.
// `showCursor` is an EditBufferRenderable option: blur() hides the native
// cursor, but a re-focused/remounted prompt can turn it back on. Pinning
// showCursor=false keeps it hidden until scroll mode exits.
const CURSOR_KEY = Symbol.for("opencode.scroll-mode.cursor")
type CursorBox = { saved: WeakMap<object, boolean> }
function cursorBox(): CursorBox {
  const g = globalThis as unknown as Record<symbol, CursorBox | undefined>
  let box = g[CURSOR_KEY]
  if (!box) box = g[CURSOR_KEY] = { saved: new WeakMap() }
  return box
}

// Built-in OpenCode commands we delegate to. Keeping the scrolling itself in
// the host means the transcript viewport stays authoritative and we never
// fight its pagination logic.
const CMD = {
  lineUp: "session.line.up",
  lineDown: "session.line.down",
  halfUp: "session.half.page.up",
  halfDown: "session.half.page.down",
  pageUp: "session.page.up",
  pageDown: "session.page.down",
  first: "session.first",
  last: "session.last",
  prevUser: "session.message.user.previous",
  nextUser: "session.message.user.next",
} as const

type Options = {
  vim: boolean
  search: boolean
  maxResults: number
  searchScope: "all" | "user"
  toggleKey: string
  highlight: boolean
  cursorColor: string
  selectionColor: string
  barColor: string
}

function readOptions(raw: unknown): Options {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  const maxRaw = o.maxResults
  return {
    vim: o.vim !== false,
    search: o.search !== false,
    maxResults: typeof maxRaw === "number" && maxRaw > 0 ? Math.floor(maxRaw) : 100,
    searchScope: o.searchScope === "user" ? "user" : "all",
    toggleKey: typeof o.toggleKey === "string" && o.toggleKey ? o.toggleKey : "ctrl+[",
    highlight: o.highlight !== false,
    cursorColor: typeof o.cursorColor === "string" && o.cursorColor ? o.cursorColor : "#3d5a80",
    selectionColor:
      typeof o.selectionColor === "string" && o.selectionColor ? o.selectionColor : "#2f5d9e",
    barColor: typeof o.barColor === "string" && o.barColor ? o.barColor : "#7aa2f7",
  }
}

// ---- message helpers -------------------------------------------------------
// V2 messages inline their text; fall back to parts/content and summary for
// robustness across message kinds.

function isUser(m: any): boolean {
  return !!m && (m.type === "user" || m.role === "user")
}

function messageId(m: any): string | null {
  const id = m?.id ?? m?.messageID ?? m?.message_id
  return typeof id === "string" && id ? id : null
}

function messageText(m: any): string {
  if (!m || typeof m !== "object") return ""
  if (typeof m.text === "string" && m.text) return m.text
  const parts = Array.isArray(m.content) ? m.content : Array.isArray(m.parts) ? m.parts : []
  const buf: string[] = []
  for (const p of parts) {
    if (p && typeof p.text === "string" && p.text) buf.push(p.text)
  }
  if (buf.length) return buf.join(" ")
  const title = m.summary?.title
  return typeof title === "string" ? title : ""
}

function messageTime(m: any): number {
  const t = m?.time?.created ?? m?.time?.completed
  return typeof t === "number" ? t : 0
}

function hhmm(ts: number): string {
  if (!ts) return ""
  try {
    const d = new Date(ts)
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
  } catch {
    return ""
  }
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim()
  return one.length > n ? one.slice(0, n - 1) + "…" : one
}

// ---- display columns --------------------------------------------------------
// OpenTUI reports wrap boundaries in terminal cells, not UTF-16 code units, so
// a line containing wide CJK glyphs (or tabs) must be sliced by display width.
// Native selection remains the source of truth for yanks; this is used by the
// per-line index, word motions, and the fallback yank path.
const WIDE: Array<[number, number]> = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
]

function cellWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0
  if (cp === 0) return 0
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0
  if (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe20 && cp <= 0xfe2f)
  ) {
    return 0
  }
  for (const [lo, hi] of WIDE) if (cp >= lo && cp <= hi) return 2
  return 1
}

function textCols(s: string): number {
  let col = 0
  for (const ch of s) col += ch === "\t" ? 4 - (col % 4) : cellWidth(ch)
  return col
}

// Slice [start, start + width) in display columns. Tabs expand to the next
// 4-column stop, matching the TUI's default text measurement.
function sliceCols(s: string, start: number, width: number): string {
  let col = 0
  let out = ""
  for (const ch of s) {
    const w = ch === "\t" ? 4 - (col % 4) : cellWidth(ch)
    const next = col + w
    if (next > start && col < start + width) out += ch
    col = next
    if (col >= start + width) break
  }
  return out
}

function colToIndex(s: string, col: number): number {
  let c = 0
  let i = 0
  for (const ch of s) {
    if (c >= col) return i
    c += ch === "\t" ? 4 - (c % 4) : cellWidth(ch)
    i += ch.length
  }
  return s.length
}

function indexToCol(s: string, index: number): number {
  return textCols(s.slice(0, Math.max(0, Math.min(s.length, index))))
}

// ---- renderer-tree jump (best effort) --------------------------------------
// The public plugin API has no "scroll to message id" primitive. The host
// renders each loaded message with its id, so we locate that node and ask its
// ScrollBox ancestor to bring it into view. Messages outside the loaded window
// have no node; the caller then tells the user to scroll up and load them.
// Mirrors the technique used by the timeline plugin. All access is defensive.

type RNode = {
  id?: unknown
  y?: unknown
  parent?: unknown
  findDescendantById?: unknown
  getChildren?: unknown
  scrollChildIntoView?: unknown
  scrollBy?: unknown
  scrollTo?: unknown
  scrollTop?: unknown
  scrollHeight?: unknown
  content?: unknown
  viewport?: unknown
  wrapper?: unknown
}

function isScrollBox(n: RNode): boolean {
  return (
    typeof n.scrollChildIntoView === "function" ||
    typeof n.scrollBy === "function" ||
    typeof n.scrollTo === "function"
  )
}

function findScrollBoxAncestor(target: RNode): RNode | null {
  let cur: any = target.parent ?? null
  let hops = 0
  while (cur && typeof cur === "object" && hops < 64) {
    const node = cur as RNode
    if (isScrollBox(node)) return node
    cur = node.parent ?? null
    hops++
  }
  return null
}

function nodeContains(root: RNode, id: string): boolean {
  try {
    if (typeof root.findDescendantById === "function") {
      return (root.findDescendantById as any).call(root, id) != null
    }
  } catch {
    return false
  }
  return false
}

function collectScrollBoxes(root: RNode): RNode[] {
  const out: RNode[] = []
  const seen = new Set<object>()
  const stack: RNode[] = [root]
  let steps = 0
  while (stack.length > 0 && steps < 5000) {
    steps++
    const node = stack.pop()!
    if (!node || typeof node !== "object" || seen.has(node)) continue
    seen.add(node)
    if (isScrollBox(node)) out.push(node)
    try {
      const kids =
        typeof node.getChildren === "function" ? (node.getChildren as any).call(node) : null
      if (Array.isArray(kids)) {
        for (const k of kids) if (k && typeof k === "object") stack.push(k as RNode)
      }
      for (const key of ["content", "viewport", "wrapper"] as const) {
        const sub = (node as any)[key]
        if (sub && typeof sub === "object") stack.push(sub as RNode)
      }
    } catch {
      continue
    }
  }
  return out
}

function scrollTargetIntoView(box: RNode, target: RNode, id: string): boolean {
  try {
    if (typeof box.scrollChildIntoView === "function") {
      ;(box.scrollChildIntoView as any).call(box, id)
      return true
    }
    if (typeof box.scrollBy === "function") {
      const childY = (target as any).y
      const boxY = (box as any).y
      if (typeof childY === "number" && typeof boxY === "number") {
        ;(box.scrollBy as any).call(box, childY - boxY - 1)
        return true
      }
    }
  } catch {
    return false
  }
  return false
}

function jumpToMessage(ctx: any, id: string): boolean {
  try {
    const root = ctx.renderer?.root as RNode | undefined
    if (!root || typeof root.findDescendantById !== "function") return false
    const target = (root.findDescendantById as any).call(root, id) as RNode | null
    if (!target || typeof target !== "object") return false
    const ancestor = findScrollBoxAncestor(target)
    if (ancestor && scrollTargetIntoView(ancestor, target, id)) {
      try {
        ctx.renderer.requestRender()
      } catch {
        /* ignore */
      }
      return true
    }
    for (const box of collectScrollBoxes(root)) {
      try {
        if (!nodeContains(box, id)) continue
        if (scrollTargetIntoView(box, target, id)) {
          try {
            ctx.renderer.requestRender()
          } catch {
            /* ignore */
          }
          return true
        }
      } catch {
        continue
      }
    }
  } catch {
    /* ignore */
  }
  return false
}

// ---- visual mode helpers ---------------------------------------------------
// Selection granularity is the whole message: the transcript is rendered by
// the host, so there is no text-level caret to anchor a sub-message range.
// The anchor/mark are message ids; order comes from the session message list.

function messageNode(context: any, id: string): RNode | null {
  try {
    const root = context.renderer?.root as RNode | undefined
    if (!root || typeof root.findDescendantById !== "function") return null
    const node = (root.findDescendantById as any).call(root, id) as RNode | null
    return node && typeof node === "object" ? node : null
  } catch {
    return null
  }
}

// Vertical offset of a node inside its ScrollBox: sum the relative layout `y`
// walking from the node up to the box. Returns null when the chain breaks or
// the node does not live inside this box.
function offsetWithin(box: RNode, node: RNode): number | null {
  let y = 0
  let cur: any = node
  let hops = 0
  while (cur && typeof cur === "object" && hops < 64) {
    if (cur === box) return y
    const vy = (cur as RNode).y
    if (typeof vy !== "number") return null
    y += vy as number
    cur = (cur as RNode).parent ?? null
    hops++
  }
  return null
}

function visibleTopMessageId(
  context: any,
  box: RNode,
  msgs: any[],
  resolve?: (id: string) => RNode | null,
): string | null {
  const scrollTop = typeof (box as any).scrollTop === "number" ? (box as any).scrollTop : 0
  const boxH =
    typeof (box as any).height === "number" && (box as any).height > 0
      ? (box as any).height
      : typeof (box as any).viewport?.height === "number"
        ? (box as any).viewport.height
        : 40
  const find = resolve ?? ((id: string) => messageNode(context, id))
  type Cand = { id: string; y: number; h: number }
  const nodes: Cand[] = []
  for (const m of msgs) {
    const id = messageId(m)
    if (!id) continue
    const node = find(id)
    if (!node) continue
    const vy = (node as any).y
    if (typeof vy !== "number") continue
    const h = typeof node.height === "number" ? (node.height as number) : 1
    nodes.push({ id, y: vy, h })
  }
  if (nodes.length === 0) return null
  // Verified against the live TUI: node.y is the PAINTED viewport coordinate,
  // i.e. content y minus scrollTop (a partially visible message at the top
  // edge has a negative y). List order is display order, so the first node
  // that intrudes into [0, boxH) is the topmost visible message.
  for (const n of nodes) {
    if (n.y + n.h > 0.5 && n.y < boxH - 0.5) return n.id
  }
  // Fallback for a coordinate space that does not pre-apply the scroll offset
  // (raw content coordinates): same test with scrollTop added back.
  for (const n of nodes) {
    if (n.y + n.h > scrollTop + 0.5 && n.y < scrollTop + boxH - 0.5) return n.id
  }
  return null
}

// OSC52 first (works over ssh when the terminal allows it), then a native
// helper binary as fallback (pbcopy on macOS, wl-copy/xclip on Linux).
async function copyToSystemClipboard(context: any, text: string): Promise<boolean> {
  try {
    if (context.renderer?.copyToClipboardOSC52?.(text)) return true
  } catch {
    /* fall through */
  }
  try {
    const targets: Array<{ cmd: string; args: string[] }> = []
    if (process.platform === "darwin") targets.push({ cmd: "pbcopy", args: [] })
    if (process.platform === "linux") {
      targets.push({ cmd: "wl-copy", args: [] })
      targets.push({ cmd: "xclip", args: ["-selection", "clipboard"] })
    }
    for (const t of targets) {
      const ok = await new Promise<boolean>((resolve) => {
        try {
          const child = spawn(t.cmd, t.args, { stdio: ["pipe", "ignore", "ignore"] })
          child.on("error", () => resolve(false))
          child.stdin.on("error", () => resolve(false))
          child.stdin.end(text, () => resolve(true))
        } catch {
          resolve(false)
        }
      })
      if (ok) return true
    }
  } catch {
    /* ignore */
  }
  return false
}

// ---- plugin -----------------------------------------------------------------

export default Plugin.define({
  id: "scroll-mode.tui",
  setup(context: any) {
    const keymap = context.keymap
    const options = readOptions(context.options)

    const [state, setState] = context.storage.memory("scroll-mode", {
      initial: { active: false },
    })
    // Active search: ids are the matching message ids in display order,
    // index is the current match (-1 before the first jump).
    const [search, setSearch] = context.storage.memory("scroll-mode.search", {
      initial: { ids: [] as string[], index: -1, query: "" },
    })
    // Visual selection: a real line cursor over the rendered transcript. Rows
    // are ABSOLUTE screen rows (the coordinate space the host's selection API
    // uses); columns are display columns from the left edge of that line's
    // text node. The anchor row stays fixed while the cursor moves.
    const [visual, setVisual] = context.storage.memory("scroll-mode.visual", {
      initial: {
        active: false,
        linewise: false,
        anchorRow: 0,
        anchorCol: 0,
        cursorRow: 0,
        cursorCol: 0,
      },
    })
    // True while a widget other than the composer owns focus (the command
    // palette, search, selects, …). While true the scroll keymap is suspended
    // so typing in that dialog doesn't move the background cursor.
    const [focusState, setFocusState] = context.storage.memory("scroll-mode.focus", {
      initial: { foreign: false },
    })

    // ---- editor lock while scroll mode is on -------------------------------
    // Scroll mode owns the keyboard: the composer must not receive text, or
    // stray keys would be typed into the prompt while the user navigates.
    //
    // Two layers of protection:
    //   1. Blur the focused renderable (normally the composer) on entry and
    //      restore it on exit, so it stops accepting input and shows unfocused.
    //   2. A global keypress guard calls preventDefault() for every key while
    //      scroll mode is active. Global keymap listeners still run, so the
    //      scroll bindings keep working; only renderable handlers (the
    //      composer) are skipped.
    // If another widget takes focus (dialogs such as search, selects, or the
    // host's own prompts), the guard steps aside so that widget still receives
    // input.
    const renderer: any = context.renderer
    let savedFocus: any = null
    let detachGuard: (() => void) | undefined
    let detachCursorGuard: (() => void) | undefined
    let detachFocusGuard: (() => void) | undefined

    const focusedRenderable = (): any => {
      try {
        return renderer?.currentFocusedRenderable ?? null
      } catch {
        return null
      }
    }

    // Hide the editor cursor while scroll mode owns the keyboard. The prompt
    // may re-focus or remount after setup, so the original value is kept in a
    // process-wide WeakMap and the focused_editor listener re-applies the lock.
    const hideEditorCursor = (target: any) => {
      if (!target) return
      try {
        if (typeof target.showCursor === "boolean") {
          const box = cursorBox()
          if (!box.saved.has(target)) box.saved.set(target, target.showCursor)
          target.showCursor = false
        }
      } catch {
        /* ignore */
      }
    }

    const restoreEditorCursor = (target: any) => {
      if (!target) return
      try {
        const box = cursorBox()
        const previous = box.saved.get(target)
        if (previous !== undefined) {
          box.saved.delete(target)
          if (!target.isDestroyed) target.showCursor = previous
        }
      } catch {
        /* ignore */
      }
    }

    const enterScroll = () => {
      const target = focusedRenderable()
      savedFocus = target
      hideEditorCursor(target)
      // Cursor bar / selection tint need the viewport refreshed continuously.
      startPoll()
      try {
        if (target && typeof target.blur === "function") target.blur()
        else if (target && typeof renderer?.blurRenderable === "function") renderer.blurRenderable(target)
      } catch {
        /* ignore */
      }
      try {
        renderer?.requestRender?.()
      } catch {
        /* ignore */
      }
    }

    const exitScroll = () => {
      stopPoll()
      clearLineSelection()
      setFocusState((draft: any) => {
        if (draft.foreign) draft.foreign = false
      })
      const target = savedFocus
      savedFocus = null
      restoreEditorCursor(target)
      try {
        if (target && !target.isDestroyed) {
          if (typeof target.focus === "function") target.focus()
          else if (typeof renderer?.focusRenderable === "function") renderer.focusRenderable(target)
        }
      } catch {
        /* ignore */
      }
      try {
        renderer?.requestRender?.()
      } catch {
        /* ignore */
      }
    }

    // Suspend everything scroll mode paints, without leaving scroll mode.
    //
    // The user-visible bug: while a dialog (command palette, prompt, select)
    // owns focus, the transcript highlight could still be re-resolved against
    // the live layout and repaint a different line, which reads as "the
    // background cursor jumps". Exiting scroll mode entirely is not an option:
    // exitScroll() calls focus() on the saved composer and would steal focus
    // back from the dialog. So on dialog focus we tear down the visual layer
    // and stop the poll, and on focus return we rebuild it.
    //
    // This also covers our own dialogs (search prompt, selects): typing there
    // no longer has any chance of moving the transcript cursor.
    const applyFocusState = (foreign: boolean) => {
      if (!state.active) return
      const changed = focusState.foreign !== foreign
      if (changed) {
        setFocusState((draft: any) => {
          draft.foreign = foreign
        })
      }
      if (!changed) return
      if (foreign) {
        // Dialog took focus: no poll, no selection, no cursor bar.
        stopPoll()
        lastKey = null
        barPos = null
        clearLineSelection()
        try {
          renderer?.requestRender?.()
        } catch {
          /* ignore */
        }
      } else {
        // Dialog closed: rebuild the highlight from the current layout.
        lastKey = null
        startPoll()
      }
    }

    // Imperative focus check, read by each command's run() at execution time.
    // The layer's reactive suspension (focusState.foreign) does not reliably
    // re-evaluate on every host, so we do not trust a stored flag here: the
    // command itself re-reads the live focus the moment it fires. Returns true
    // when a dialog (or any widget other than the saved composer) owns focus.
    const dialogHasFocus = (): boolean => {
      if (!state.active) return false
      const focused = focusedRenderable()
      return !!focused && focused !== savedFocus
    }

    const onKey = (key: any) => {
      if (!state.active) return
      const focused = focusedRenderable()
      // A dialog or other widget has taken focus: suspend the scroll keymap and
      // let it receive input. Sync here too (not only via focused_renderable)
      // so the suspension is in place before the next keystroke reaches the
      // dispatcher, even if the host doesn't emit the focus event.
      const foreign = !!focused && focused !== savedFocus
      applyFocusState(foreign)
      if (foreign) return
      if (focused) hideEditorCursor(focused)
      try {
        key.preventDefault()
      } catch {
        /* ignore */
      }
    }

    // Slot/plugin updates can re-focus or remount the prompt after scroll mode
    // starts. Keep its cursor hidden, and adopt a remounted input so the
    // keypress guard above keeps applying to the new instance.
    const onFocusedEditor = (current: any) => {
      if (!state.active || !current || current.isDestroyed) return
      if (savedFocus && savedFocus.isDestroyed) savedFocus = current
      if (current !== savedFocus) return
      hideEditorCursor(current)
      try {
        renderer?.requestRender?.()
      } catch {
        /* ignore */
      }
    }

    // Track whether a widget other than the composer owns focus. While scroll
    // mode is active and a dialog (palette, search, select) has focus, the
    // scroll keymap is suspended so the dialog receives every key and the
    // background cursor doesn't jump while typing.
    const onFocusChange = (current: any) => {
      if (!state.active) return
      const foreign = !!current && current !== savedFocus
      applyFocusState(foreign)
    }

    const toast = (message: string, variant?: "info" | "success" | "warning" | "error") => {
      try {
        context.ui.toast.show(variant ? { message, variant } : { message })
      } catch {
        /* ignore */
      }
    }

    const currentSession = (): string | null => {
      try {
        const r = context.ui.router.current()
        if (r && typeof r === "object") {
          if (typeof r.sessionID === "string" && r.sessionID) return r.sessionID
          if (r.type === "session" && typeof r.sessionID === "string") return r.sessionID
          if (typeof r.session?.id === "string") return r.session.id
          if (typeof r.data?.sessionID === "string") return r.data.sessionID
        }
      } catch {
        /* ignore */
      }
      return null
    }

    const listMessages = (sid: string): any[] => {
      try {
        return context.data.session.message.list(sid) ?? []
      } catch {
        return []
      }
    }

    const runSearch = async (reverse: boolean) => {
      if (!options.search) {
        toast("Search is disabled in plugin options", "warning")
        return
      }
      const sid = currentSession()
      if (!sid) {
        toast("Open a session to search", "warning")
        return
      }
      const query = await context.ui.dialog.prompt({
        title: reverse ? "Search messages (backward)" : "Search messages",
        placeholder: "text to find",
      })
      if (!query || !query.trim()) return
      const needle = query.trim().toLowerCase()

      const hits: Array<{ id: string; text: string; ts: number; user: boolean }> = []
      for (const m of listMessages(sid)) {
        const user = isUser(m)
        if (options.searchScope === "user" && !user) continue
        const id = messageId(m)
        if (!id) continue
        const text = messageText(m)
        if (!text) continue
        if (!text.toLowerCase().includes(needle)) continue
        hits.push({ id, text, ts: messageTime(m), user })
      }

      if (hits.length === 0) {
        toast(`No matches for "${query.trim()}"`, "warning")
        return
      }

      const ordered = reverse ? hits.slice().reverse() : hits
      const shown = ordered.slice(0, options.maxResults)
      const ids = shown.map((h) => h.id)
      setSearch((draft: any) => {
        draft.ids = ids
        draft.index = -1
        draft.query = query.trim()
      })

      const more = hits.length > shown.length ? ` · showing ${shown.length}` : ""
      const choice = await context.ui.dialog.select({
        title: `${hits.length} match${hits.length === 1 ? "" : "es"} for "${query.trim()}"${more}`,
        options: shown.map((h, i) => ({
          title: clip(h.text, 72),
          value: h.id,
          description: `${h.user ? "user" : "assistant"}${h.ts ? " · " + hhmm(h.ts) : ""} · #${i + 1}`,
          category: h.user ? "user" : "assistant",
        })),
      })
      if (!choice) return

      const idx = shown.findIndex((h) => h.id === choice)
      setSearch((draft: any) => {
        draft.index = idx
      })
      if (jumpToMessage(context, choice)) {
        toast(`Match ${idx + 1}/${shown.length} — n/N to cycle`, "success")
      } else {
        toast(`Match ${idx + 1}/${shown.length} is outside the loaded view — scroll up to load it, then press n`, "warning")
      }
      syncCursorToEdge("top")
    }

    const stepSearch = (delta: number) => {
      const ids: string[] = search.ids ?? []
      if (ids.length === 0) {
        toast("No active search — press / to search", "warning")
        return
      }
      const start = typeof search.index === "number" ? search.index : -1
      let i = start + delta
      if (i < 0) i = ids.length - 1
      if (i >= ids.length) i = 0
      setSearch((draft: any) => {
        draft.index = i
      })
      if (jumpToMessage(context, ids[i])) {
        toast(`Match ${i + 1}/${ids.length}`, "success")
      } else {
        toast(`Match ${i + 1}/${ids.length} is outside the loaded view — scroll up to load it`, "warning")
      }
      syncCursorToEdge("top")
    }

    // ---- visual mode ---------------------------------------------------------
    // Cursor and selection rows are absolute screen rows; the cursor column is
    // a display column inside the rendered line.

    // id -> renderer node. findDescendantById is a tree search, and a session
    // can hold 150+ rendered messages; caching keeps the 150ms visual poll
    // cheap. Entries are dropped when the host destroys a node.
    const nodeCache = new Map<string, RNode>()
    const resolveNodeCached = (id: string): RNode | null => {
      const hit = nodeCache.get(id)
      if (hit) {
        if ((hit as any).isDestroyed) nodeCache.delete(id)
        else return hit
      }
      const node = messageNode(context, id)
      if (node) nodeCache.set(id, node)
      return node
    }

    let visualBox: RNode | undefined | null // undefined = unknown, null = lookup failed
    let visualBoxStamp = 0
    let visualBoxSession: string | null = null

    const ensureVisualBox = (msgs: any[]): RNode | null => {
      const sid = currentSession()
      if (
        visualBox &&
        ((visualBox as any).isDestroyed || (sid && visualBoxSession && visualBoxSession !== sid))
      ) {
        visualBox = undefined
        visualBoxSession = null
      }
      if (visualBox) return visualBox
      const now = Date.now()
      // Do not cache a miss forever: the first poll can run before the host
      // has mounted the transcript.
      if (visualBox === null && now - visualBoxStamp < 500) return null
      visualBoxStamp = now
      for (const m of msgs) {
        const id = messageId(m)
        if (!id) continue
        const node = messageNode(context, id)
        if (!node) continue
        const box = findScrollBoxAncestor(node)
        if (box) {
          visualBox = box
          visualBoxSession = sid
          return box
        }
      }
      visualBox = null
      return null
    }

    // ---- line cursor / visual range highlight --------------------------------
    // The cursor persists in both modes: normal scroll mode paints a full-line
    // tint plus a character-cell bar, and visual mode extends the host's native
    // selection from the anchor to the moving cursor. Highlighting goes through
    // the host's own selection machinery, so it uses real text metrics and the
    // theme's selection colors instead of tinting whole message boxes.
    let pollTimer: ReturnType<typeof setInterval> | undefined
    let lastKey: string | null = null
    let selectionWarned = false

    const stopPoll = () => {
      if (pollTimer) {
        clearInterval(pollTimer)
        pollTimer = undefined
      }
    }

    // The host leaves selectionBg undefined on these text nodes, which can
    // make a selection invisible. We set our own color (saving the original)
    // so the cursor line / range is always drawn, then restore on exit.
    const savedSelBg = new WeakMap<object, any>()
    const styledSel = new Set<RNode>()

    const styleSelection = (node: RNode | null | undefined, color: string) => {
      if (!node) return
      try {
        if ((node as any).isDestroyed) return
        if (!("selectionBg" in (node as any))) return
        if (!savedSelBg.has(node)) savedSelBg.set(node, (node as any).selectionBg)
        ;(node as any).selectionBg = color
        styledSel.add(node)
      } catch {
        /* ignore */
      }
    }

    const restoreSelections = () => {
      for (const node of styledSel) {
        try {
          if (!(node as any).isDestroyed) (node as any).selectionBg = savedSelBg.get(node)
        } catch {
          /* ignore */
        }
      }
      styledSel.clear()
    }

    const clearLineSelection = () => {
      lastKey = null
      try {
        renderer?.clearSelection?.()
      } catch {
        /* ignore */
      }
      restoreSelections()
    }

    const boxTopOf = (box: RNode | null): number =>
      box && typeof (box as any).y === "number" ? Math.round((box as any).y) : 0
    const boxHeightOf = (box: RNode | null): number => {
      if (!box) return 0
      const h = (box as any).height
      if (typeof h === "number" && h > 0) return Math.floor(h)
      const vh = (box as any).viewport?.height
      return typeof vh === "number" && vh > 0 ? Math.floor(vh) : 0
    }
    const nodeX = (node: RNode): number =>
      typeof (node as any).x === "number" ? Math.round((node as any).x) : 0
    const nodeY = (node: RNode): number =>
      typeof (node as any).y === "number" ? Math.round((node as any).y) : 0
    const nodeW = (node: RNode): number =>
      typeof (node as any).width === "number" && (node as any).width > 1
        ? Math.floor((node as any).width)
        : 1
    // Stored state can predate these fields (hot reload keeps memory state).
    const colOf = (v: unknown): number =>
      typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0

    // ---- per-line index -----------------------------------------------------
    // One entry per VISUAL line of every selectable text renderable in the
    // transcript. `lineInfo` maps the visual row to a source line, a wrap
    // index, and a display-column range; applying that range to `plainText`
    // yields exactly what is painted on that row (code blocks included).
    type LineEntry = { row: number; node: RNode; text: string }
    type TextData = {
      info: any
      lines: string[]
      count: number
      baseBySource: Map<number, number>
    }

    // Selectable roots only: descending into a TextRenderable's TextNode
    // children would duplicate its text. Non-selectable wrappers (ScrollBox,
    // viewport, content) are traversed. Both the child list and the common
    // content/viewport/wrapper fields are checked because the host build may
    // expose the content wrapper only through one of them.
    const collectSelectableRoots = (
      node: RNode,
      out: RNode[],
      seen = new Set<object>(),
      depth = 0,
    ) => {
      if (depth > 16) return
      try {
        if (!node || seen.has(node as any)) return
        seen.add(node as any)
        if ((node as any).isDestroyed || (node as any).visible === false) return
        if ((node as any).selectable === true) {
          out.push(node)
          return
        }
        const kids: any[] = []
        const list = (node as any).getChildren?.()
        if (Array.isArray(list)) kids.push(...list)
        for (const key of ["content", "viewport", "wrapper"] as const) {
          const sub = (node as any)[key]
          if (sub && typeof sub === "object") kids.push(sub)
        }
        for (const k of kids) collectSelectableRoots(k as RNode, out, seen, depth + 1)
      } catch {
        /* ignore */
      }
    }

    const textCache = new WeakMap<object, { key: string; data: TextData | null }>()
    const textDataOf = (node: RNode): TextData | null => {
      try {
        // `plainText` allocates the whole node text. It can be a large code
        // block, and the 150ms poll would otherwise re-copy it on every tick.
        // textLength/virtualLineCount/width/height change when streaming or
        // re-wrapping makes the cached metadata stale.
        const sig = [
          typeof (node as any).textLength === "number" ? (node as any).textLength : "",
          typeof (node as any).virtualLineCount === "number" ? (node as any).virtualLineCount : "",
          typeof (node as any).width === "number" ? (node as any).width : "",
          typeof (node as any).height === "number" ? (node as any).height : "",
        ].join("|")
        const cached = textCache.get(node)
        if (cached && cached.key === sig) return cached.data
        const plain =
          typeof (node as any).plainText === "string"
            ? (node as any).plainText
            : typeof (node as any).content === "string"
              ? (node as any).content
              : ""
        if (!plain) {
          textCache.set(node, { key: sig, data: null })
          return null
        }
        const lines = plain.split("\n")
        let info: any = null
        try {
          info = (node as any).lineInfo ?? null
        } catch {
          info = null
        }
        const reported =
          info?.lineSources?.length ??
          info?.lineWidthCols?.length ??
          (typeof (node as any).virtualLineCount === "number" ? (node as any).virtualLineCount : 0)
        const count = Math.max(1, typeof reported === "number" && reported > 0 ? reported : lines.length)
        const baseBySource = new Map<number, number>()
        if (Array.isArray(info?.lineSources) && Array.isArray(info?.lineStartCols)) {
          for (let i = 0; i < info.lineSources.length; i++) {
            const src = info.lineSources[i]
            if (!baseBySource.has(src)) baseBySource.set(src, info.lineStartCols[i] ?? 0)
          }
        }
        const data = { info, lines, count, baseBySource }
        textCache.set(node, { key: sig, data })
        return data
      } catch {
        return null
      }
    }

    const entryTextOf = (data: TextData, i: number): string => {
      const info = data.info
      if (!Array.isArray(info?.lineSources) || !Array.isArray(info?.lineWidthCols)) {
        return data.lines[Math.min(i, data.lines.length - 1)] ?? ""
      }
      const src = info.lineSources[i] ?? i
      const base = data.baseBySource.get(src) ?? 0
      const start = Math.max(0, (info.lineStartCols?.[i] ?? base) - base)
      const width = info.lineWidthCols[i]
      const line = data.lines[src] ?? ""
      return typeof width === "number" && width > 0 ? sliceCols(line, start, width) : line
    }

    const buildLineIndex = (box: RNode, visibleOnly: boolean): LineEntry[] => {
      const roots: RNode[] = []
      collectSelectableRoots(box, roots)
      const top = boxTopOf(box)
      const height = boxHeightOf(box) || 40
      const bottom = top + height
      const out: LineEntry[] = []
      for (const node of roots) {
        const data = textDataOf(node)
        if (!data) continue
        const scrollY =
          typeof (node as any).scrollY === "number" ? Math.max(0, Math.floor((node as any).scrollY)) : 0
        const y = nodeY(node)
        for (let i = 0; i < data.count; i++) {
          const row = y + i - scrollY
          if (visibleOnly && (row < top || row >= bottom)) continue
          out.push({ row, node, text: entryTextOf(data, i) })
        }
      }
      out.sort((a, b) => a.row - b.row || nodeX(a.node) - nodeX(b.node))
      // Overlapping renderables are rare; keep one entry per screen row and
      // prefer the one that actually carries text.
      const dedup: LineEntry[] = []
      for (const e of out) {
        const prev = dedup[dedup.length - 1]
        if (prev && prev.row === e.row) {
          // More than one selectable node can paint the same screen row (e.g.
          // a selectable gutter beside code, or the two sides of a split
          // diff). Keep the widest: that is the main content, not the gutter.
          if (nodeW(e.node) > nodeW(prev.node) && (e.text.trim() || !prev.text.trim())) {
            dedup[dedup.length - 1] = e
          }
          continue
        }
        dedup.push(e)
      }
      return dedup
    }

    const lineIndex = (box: RNode, visibleOnly = true): LineEntry[] =>
      buildLineIndex(box, visibleOnly)

    // Nearest entry to an absolute row. The cursor is normally set to an exact
    // entry row, but page scrolls and hot reloads can leave it between rows.
    const entryAtRow = (index: LineEntry[], row: number): LineEntry | null => {
      if (index.length === 0) return null
      let best = index[0]
      let bestD = Math.abs(best.row - row)
      for (const e of index) {
        const d = Math.abs(e.row - row)
        if (d < bestD) {
          best = e
          bestD = d
        }
        if (e.row === row) return e
      }
      return best
    }

    const maxColOf = (text: string): number => Math.max(0, textCols(text) - 1)
    const clampCol = (col: unknown, text: string): number =>
      Math.max(0, Math.min(maxColOf(text), colOf(col)))

    const applyHighlight = (linewiseOverride?: boolean) => {
      // A deferred refresh can land after scroll mode turned off; never paint
      // a selection outside scroll mode (exitScroll clears it).
      if (!state.active || !options.highlight) {
        lastKey = null
        return
      }
      const sid = currentSession()
      if (!sid) return
      const msgs = listMessages(sid)
      const box = ensureVisualBox(msgs)
      if (!box) {
        visualBox = null
        clearLineSelection()
        return
      }
      const vis = lineIndex(box, true)
      if (vis.length === 0) {
        lastKey = null
        clearLineSelection()
        return
      }
      const active = visual.active
      const linewise = linewiseOverride ?? visual.linewise
      let cursorRow = typeof visual.cursorRow === "number" ? visual.cursorRow : vis[0].row
      if (!active && !vis.some((e) => e.row === cursorRow)) {
        // In normal scroll mode the cursor follows the viewport. A host scroll
        // (mouse wheel, ctrl+d, etc.) can leave the stored row off-screen, so
        // snap it to the nearest rendered line instead of pinning the
        // highlight to the first line of the page.
        const near = entryAtRow(vis, cursorRow)
        if (near) cursorRow = near.row
      }
      const anchorRow = typeof visual.anchorRow === "number" ? visual.anchorRow : cursorRow
      const full = active ? lineIndex(box, false) : vis
      const cursor = entryAtRow(active ? full : vis, cursorRow)
      if (!cursor) return
      if (!active) {
        const col = clampCol(visual.cursorCol, cursor.text)
        if (cursor.row !== visual.cursorRow || col !== visual.cursorCol) {
          setVisual((draft: any) => {
            draft.cursorRow = cursor.row
            draft.cursorCol = col
          })
        }
      }
      const anchor = active ? (entryAtRow(full, anchorRow) ?? cursor) : cursor
      const anchorCol = active && !linewise ? clampCol(visual.anchorCol, anchor.text) : 0
      const cursorCol =
        active && !linewise
          ? clampCol(visual.cursorCol, cursor.text)
          : Math.max(0, nodeW(cursor.node) - 1)
      const barCol = clampCol(visual.cursorCol, cursor.text)
      const lo = Math.min(anchor.row, cursor.row)
      const hi = Math.max(anchor.row, cursor.row)
      const key = [
        active ? (linewise ? "V" : "v") : "c",
        anchor.row,
        nodeX(anchor.node),
        anchorCol,
        cursor.row,
        nodeX(cursor.node),
        active ? cursorCol : barCol,
        lo,
        hi,
      ].join("|")
      let hasSel = false
      try {
        hasSel = !!renderer?.hasSelection
      } catch {
        /* ignore */
      }
      if (key === lastKey && hasSel) return
      lastKey = key
      try {
        if (typeof renderer?.startSelection !== "function") throw new Error("selection API missing")
        // The host leaves selectionBg undefined on these nodes, which can make
        // the highlight invisible. Color only the nodes that actually own a
        // selected row; restore on exit.
        for (const e of full) {
          if (e.row < lo || e.row > hi) continue
          styleSelection(e.node, active ? options.selectionColor : options.cursorColor)
        }

        const startX = nodeX(anchor.node) + (active && !linewise ? anchorCol : 0)
        const focusX =
          nodeX(cursor.node) + (active && !linewise ? cursorCol : Math.max(0, nodeW(cursor.node) - 1))
        const behavior = active && linewise ? "line" : "cell"
        renderer.startSelection(anchor.node, startX, anchor.row, behavior)
        // startSelection roots the selection at the anchor's immediate parent.
        // Climb to the transcript ScrollBox so a selection that crosses
        // messages sees both ends, while unrelated UI (sidebar/status) stays
        // out. `updateSelection(null, ...)` climbs exactly one level per call.
        if (active) {
          for (let i = 0; i < 10; i++) {
            let container: any = null
            try {
              container = renderer.getSelectionContainer?.() ?? null
            } catch {
              /* ignore */
            }
            if (!container || container === box) break
            try {
              renderer.updateSelection(null, focusX, cursor.row)
            } catch {
              break
            }
          }
        }
        renderer.updateSelection(cursor.node, focusX, cursor.row, { finishDragging: true })
        renderer.requestRender?.()
        if (!renderer?.hasSelection && !selectionWarned) {
          selectionWarned = true
          toast("Highlight applied but the host reports no selection — run Dump viewport diagnostics", "warning")
        }
      } catch {
        if (!selectionWarned) {
          selectionWarned = true
          toast("This OpenCode build lacks the selection API — line highlight unavailable", "warning")
        }
      }
    }

    // ---- cursor movement -----------------------------------------------------
    // Scrolling stays in the host; the cursor only moves inside the current
    // viewport. At an edge the host scrolls one line and the cursor stays on
    // the edge row, exactly like vim's scrolloff behaviour.

    const scrollVisual = (cmd: string, edge: "top" | "bottom") => {
      keymap.dispatch(cmd)
      setTimeout(() => {
        if (!state.active) return
        const sid = currentSession()
        if (!sid) return
        const msgs = listMessages(sid)
        const box = ensureVisualBox(msgs)
        if (!box) return
        const vis = lineIndex(box, true)
        if (vis.length === 0) return
        const hit = edge === "top" ? vis[0] : vis[vis.length - 1]
        setVisual((draft: any) => {
          draft.cursorRow = hit.row
          draft.cursorCol = clampCol(draft.cursorCol, hit.text)
        })
        lastKey = null
        applyHighlight()
      }, 140)
    }

    const afterPageScroll = (cmd: string) => {
      const sid0 = currentSession()
      const box0 = sid0 ? ensureVisualBox(listMessages(sid0)) : null
      const before = box0 ? lineIndex(box0, true) : []
      const row =
        typeof visual.cursorRow === "number" ? visual.cursorRow : (before[0]?.row ?? 0)
      keymap.dispatch(cmd)
      setTimeout(() => {
        if (!state.active) return
        const sid = currentSession()
        if (!sid) return
        const msgs = listMessages(sid)
        const box = ensureVisualBox(msgs)
        if (!box) return
        const vis = lineIndex(box, true)
        if (vis.length === 0) return
        const hit = entryAtRow(vis, row)
        if (!hit) return
        setVisual((draft: any) => {
          draft.cursorRow = hit.row
          draft.cursorCol = clampCol(draft.cursorCol, hit.text)
        })
        lastKey = null
        applyHighlight()
      }, 140)
    }

    const syncCursorToEdge = (edge: "top" | "bottom") => {
      setTimeout(() => {
        if (!state.active) return
        const sid = currentSession()
        if (!sid) return
        const msgs = listMessages(sid)
        const box = ensureVisualBox(msgs)
        if (!box) return
        const vis = lineIndex(box, true)
        if (vis.length === 0) return
        const hit = edge === "top" ? vis[0] : vis[vis.length - 1]
        setVisual((draft: any) => {
          draft.cursorRow = hit.row
          draft.cursorCol = clampCol(draft.cursorCol, hit.text)
        })
        lastKey = null
        applyHighlight()
      }, 140)
    }

    const afterJump = (cmd: string, edge: "top" | "bottom") => {
      keymap.dispatch(cmd)
      syncCursorToEdge(edge)
    }

    const moveCursor = (delta: number) => {
      if (!state.active) return
      const sid = currentSession()
      if (!sid) return
      const msgs = listMessages(sid)
      const box = ensureVisualBox(msgs)
      if (!box) return
      const vis = lineIndex(box, true)
      if (vis.length === 0) return
      const currentRow = typeof visual.cursorRow === "number" ? visual.cursorRow : vis[0].row
      const cur = entryAtRow(vis, currentRow)
      if (!cur) return
      const at = vis.indexOf(cur)
      const target = at + delta
      if (target < 0) {
        scrollVisual(CMD.lineUp, "top")
        return
      }
      if (target >= vis.length) {
        scrollVisual(CMD.lineDown, "bottom")
        return
      }
      const hit = vis[target]
      setVisual((draft: any) => {
        draft.cursorRow = hit.row
        draft.cursorCol = clampCol(draft.cursorCol, hit.text)
      })
      lastKey = null
      applyHighlight()
    }

    // Move the character cursor horizontally (h/l or arrows) in both modes.
    // Linewise selection ignores columns, same as vim.
    const moveCol = (delta: number) => {
      if (!state.active || (visual.active && visual.linewise)) return
      const sid = currentSession()
      if (!sid) return
      const msgs = listMessages(sid)
      const box = ensureVisualBox(msgs)
      if (!box) return
      const vis = lineIndex(box, true)
      if (vis.length === 0) return
      const cur = entryAtRow(vis, typeof visual.cursorRow === "number" ? visual.cursorRow : vis[0].row)
      if (!cur) return
      const curCol = colOf(visual.cursorCol)
      const next = Math.max(0, Math.min(maxColOf(cur.text), curCol + delta))
      if (next === curCol) return
      setVisual((draft: any) => {
        draft.cursorRow = cur.row
        draft.cursorCol = next
      })
      lastKey = null
      applyHighlight()
    }

    // w / b / e across the rendered lines (charwise only).
    const moveWord = (kind: "w" | "b" | "e") => {
      if (!state.active || (visual.active && visual.linewise)) return
      const sid = currentSession()
      if (!sid) return
      const msgs = listMessages(sid)
      const box = ensureVisualBox(msgs)
      if (!box) return
      const vis = lineIndex(box, true)
      if (vis.length === 0) return
      const cur = entryAtRow(vis, typeof visual.cursorRow === "number" ? visual.cursorRow : vis[0].row)
      if (!cur) return
      const at = vis.indexOf(cur)
      const text = cur.text
      const isWord = (ch: string | undefined) => !!ch && /[\p{L}\p{N}_]/u.test(ch)
      const idx = colToIndex(text, colOf(visual.cursorCol))
      let nextEntry = cur
      let nextIdx = idx
      if (kind === "w") {
        let i = idx + 1
        while (i < text.length && isWord(text[i])) i++
        while (i < text.length && !isWord(text[i])) i++
        if (i >= text.length) {
          const n = vis[at + 1]
          if (n) {
            nextEntry = n
            nextIdx = 0
          }
        } else nextIdx = i
      } else if (kind === "b") {
        let i = idx - 1
        while (i >= 0 && !isWord(text[i])) i--
        while (i > 0 && isWord(text[i - 1])) i--
        if (i < 0) {
          const p = vis[at - 1]
          if (p) {
            nextEntry = p
            nextIdx = Math.max(0, p.text.length - 1)
          }
        } else nextIdx = i
      } else {
        let i = idx + 1
        while (i < text.length && !isWord(text[i])) i++
        while (i < text.length && isWord(text[i])) i++
        if (i >= text.length) {
          const n = vis[at + 1]
          if (n) {
            nextEntry = n
            nextIdx = 0
          }
        } else nextIdx = i > 0 ? i - 1 : 0
      }
      const nextCol = indexToCol(nextEntry.text, Math.min(nextIdx, Math.max(0, nextEntry.text.length - 1)))
      setVisual((draft: any) => {
        draft.cursorRow = nextEntry.row
        draft.cursorCol = nextCol
      })
      lastKey = null
      applyHighlight()
    }

    // 0 / $ in charwise mode.
    const moveLineEdge = (kind: "start" | "end") => {
      if (!state.active || (visual.active && visual.linewise)) return
      const sid = currentSession()
      if (!sid) return
      const msgs = listMessages(sid)
      const box = ensureVisualBox(msgs)
      if (!box) return
      const vis = lineIndex(box, true)
      if (vis.length === 0) return
      const cur = entryAtRow(vis, typeof visual.cursorRow === "number" ? visual.cursorRow : vis[0].row)
      if (!cur) return
      setVisual((draft: any) => {
        draft.cursorRow = cur.row
        draft.cursorCol = kind === "start" ? 0 : maxColOf(cur.text)
      })
      lastKey = null
      applyHighlight()
    }

    // Swap which end of the selection is the anchor.
    const swapEnds = () => {
      if (!visual.active) return
      setVisual((draft: any) => {
        const ar = draft.anchorRow
        const ac = draft.anchorCol
        draft.anchorRow = draft.cursorRow
        draft.anchorCol = draft.cursorCol
        draft.cursorRow = ar
        draft.cursorCol = ac
      })
      lastKey = null
      applyHighlight()
      toast("Anchor and cursor swapped")
    }

    // ---- character cursor -----------------------------------------------
    // The host's selection may not be visible in every build. This 1-cell bar
    // is painted straight into the frame in the renderer's post-process pass
    // at the cursor's character cell, so the column is visible on top of
    // whatever the transcript drew (and of the host's line/range highlight).
    let barRgba: any = null
    let barPos: { x: number; y: number } | null = null
    let barStamp = 0

    const colorFrom = (probe: any, hex: string): any => {
      try {
        const Ctor = probe?.backgroundColor?.constructor
        return Ctor?.fromHex?.(hex) ?? null
      } catch {
        return null
      }
    }

    const refreshBar = (force = false) => {
      const now = Date.now()
      if (!force && now - barStamp < 30) return
      barStamp = now
      barPos = null
      if (!state.active) return
      const sid = currentSession()
      if (!sid) return
      const msgs = listMessages(sid)
      const box = ensureVisualBox(msgs)
      if (!box) return
      const vis = lineIndex(box, true)
      if (vis.length === 0) return
      const row =
        typeof visual.cursorRow === "number" ? visual.cursorRow : vis[0].row
      const hit = vis.find((e) => e.row === row) ?? entryAtRow(vis, row)
      if (!hit) return
      if (!barRgba) {
        barRgba = colorFrom(box, options.barColor) ?? colorFrom(renderer, options.barColor)
      }
      // Paint at the character cell. The cursor column is relative to the
      // displayed line (wrapped segments and code rows included).
      const col = clampCol(visual.cursorCol, hit.text)
      barPos = { x: Math.max(0, nodeX(hit.node) + col), y: hit.row }
    }

    const drawCursorBar = (buffer: any) => {
      try {
        // While a dialog owns focus the whole scroll-mode overlay is suspended
        // (see applyFocusState): no bar, no selection, no poll.
        if (!state.active || !options.highlight || focusState.foreign) return
        refreshBar()
        if (!barPos || !barRgba) return
        if (barPos.y < 0) return
        buffer.fillRect(barPos.x, barPos.y, 1, 1, barRgba)
      } catch {
        /* ignore */
      }
    }

    try {
      renderer?.addPostProcessFn?.(drawCursorBar)
    } catch {
      /* ignore */
    }

    const startPoll = () => {
      stopPoll()
      applyHighlight()
      pollTimer = setInterval(applyHighlight, 150)
    }

    const enterVisual = (linewise: boolean) => {
      const sid = currentSession()
      if (!sid) {
        toast("Open a session to start visual mode", "warning")
        return
      }
      const msgs = listMessages(sid)
      const box = ensureVisualBox(msgs)
      if (!box) {
        toast("No message rendered in view — scroll up to load it first", "warning")
        return
      }
      const vis = lineIndex(box, true)
      if (vis.length === 0) {
        toast("No rendered text in view — scroll to a message first", "warning")
        return
      }
      // Start where the normal-mode cursor is (row and column). This is what
      // makes `l` then `v` select from the middle of a line.
      const startRow =
        typeof visual.cursorRow === "number" ? visual.cursorRow : vis[0].row
      const hit = entryAtRow(vis, startRow) ?? vis[0]
      const startCol = clampCol(visual.cursorCol, hit.text)
      setVisual((draft: any) => {
        draft.active = true
        draft.linewise = linewise
        draft.anchorRow = hit.row
        draft.anchorCol = startCol
        draft.cursorRow = hit.row
        draft.cursorCol = startCol
      })
      lastKey = null
      applyHighlight()
      const preview = clip(hit.text, 56) || "(blank line)"
      toast(
        linewise
          ? `VISUAL LINE · ${preview} — j/k move · o swap · y yank · esc cancel`
          : `VISUAL · ${preview} — j/k move · h/l col · w/b/e word · 0/$ ends · y yank · esc cancel`,
      )
    }

    const exitVisual = () => {
      setVisual((draft: any) => {
        draft.active = false
        draft.linewise = false
        // Keep the cursor where visual mode left it; normal mode continues
        // from the same row/column.
        draft.anchorRow = draft.cursorRow
        draft.anchorCol = draft.cursorCol
      })
      // Back to the single-line cursor on the next refresh.
      lastKey = null
      applyHighlight()
    }

    // Text from the per-line index between two absolute rows. Used when the
    // host's selection text is unavailable; exact for every rendered row,
    // including code blocks and wrapped lines.
    const textBetweenRows = (
      rows: LineEntry[],
      lo: number,
      hi: number,
      charwise: boolean,
      loCol: number,
      hiCol: number,
    ): string => {
      const picked = rows.filter((e) => e.row >= lo && e.row <= hi)
      if (picked.length === 0) return ""
      if (!charwise) return picked.map((e) => e.text).join("\n")
      return picked
        .map((e, i) => {
          if (picked.length === 1) {
            const start = Math.min(loCol, hiCol)
            return sliceCols(e.text, start, Math.abs(hiCol - loCol) + 1)
          }
          if (i === 0) return sliceCols(e.text, loCol, Math.max(0, textCols(e.text) - loCol))
          if (i === picked.length - 1) return sliceCols(e.text, 0, hiCol + 1)
          return e.text
        })
        .join("\n")
    }

    const yankVisual = async (forceLinewise = false) => {
      const sid = currentSession()
      if (!sid) return
      const msgs = listMessages(sid)
      const box = ensureVisualBox(msgs)
      if (!box) {
        toast("Nothing rendered to yank — scroll a message into view first", "warning")
        return
      }
      const vis = lineIndex(box, true)
      if (vis.length === 0) {
        toast("No rendered text in view to yank", "warning")
        return
      }
      const active = visual.active
      const linewise = active ? forceLinewise || visual.linewise : false
      const passiveRow =
        entryAtRow(vis, typeof visual.cursorRow === "number" ? visual.cursorRow : vis[0].row)?.row ??
        vis[0].row
      const anchorRow = active && typeof visual.anchorRow === "number" ? visual.anchorRow : passiveRow
      const cursorRow = active && typeof visual.cursorRow === "number" ? visual.cursorRow : passiveRow
      // Prefer the host selection: it is the exact rendered text (wrapping and
      // code blocks included). The line index is the fallback.
      let text = ""
      if (active) {
        lastKey = null
        applyHighlight(linewise)
        try {
          text = renderer?.getSelection?.()?.getSelectedText?.() ?? ""
        } catch {
          /* ignore */
        }
      } else {
        const hit = entryAtRow(vis, cursorRow)
        if (hit) {
          try {
            renderer.startSelection(hit.node, nodeX(hit.node), hit.row, "cell")
            renderer.updateSelection(hit.node, nodeX(hit.node) + nodeW(hit.node) - 1, hit.row, {
              finishDragging: true,
            })
            text = renderer?.getSelection?.()?.getSelectedText?.() ?? ""
          } catch {
            /* ignore */
          }
        }
      }
      if (!text) {
        const full = lineIndex(box, false)
        const lo = Math.min(anchorRow, cursorRow)
        const hi = Math.max(anchorRow, cursorRow)
        const charwise = active && !linewise
        const lowIsAnchor = anchorRow <= cursorRow
        const loCol = charwise
          ? clampCol(lowIsAnchor ? visual.anchorCol : visual.cursorCol, entryAtRow(full, lo)?.text ?? "")
          : 0
        const hiCol = charwise
          ? clampCol(lowIsAnchor ? visual.cursorCol : visual.anchorCol, entryAtRow(full, hi)?.text ?? "")
          : 0
        text = textBetweenRows(full, lo, hi, charwise, loCol, hiCol)
      }
      if (!text) {
        toast("Selected lines have no text to copy", "warning")
        return
      }
      const ok = await copyToSystemClipboard(context, text)
      const n = text.split("\n").length
      if (ok) {
        toast(`Yanked ${n} line${n === 1 ? "" : "s"} · ${text.length} chars → clipboard`, "success")
      } else {
        toast(`Copy failed — terminal likely blocks OSC52. Text preview: ${clip(text, 40)}`, "error")
      }
      if (visual.active) exitVisual()
    }

    // Y (normal scroll mode): every rendered line currently in the viewport,
    // top to bottom. This is the direct "get each displayed line" primitive.
    const yankVisibleLines = async () => {
      const sid = currentSession()
      if (!sid) return
      const msgs = listMessages(sid)
      const box = ensureVisualBox(msgs)
      if (!box) {
        toast("Nothing rendered to copy — scroll a message into view first", "warning")
        return
      }
      const vis = lineIndex(box, true)
      if (vis.length === 0) {
        toast("No rendered text in view to copy", "warning")
        return
      }
      const text = vis.map((e) => e.text).join("\n")
      const ok = await copyToSystemClipboard(context, text)
      if (ok) {
        toast(`Copied ${vis.length} visible line${vis.length === 1 ? "" : "s"} · ${text.length} chars → clipboard`, "success")
      } else {
        toast(`Copy failed — terminal likely blocks OSC52. Text preview: ${clip(text, 40)}`, "error")
      }
    }

    // Diagnostic dump: records what the renderer tree actually exposes at
    // runtime (node ids, y-values, scroll box fields) so viewport math can be
    // validated against the real TUI. Output lands in /tmp/scroll-mode-diag.json.
    const dumpViewportDiagnostics = () => {
      void (async () => {
        const diag: Record<string, unknown> = { ts: new Date().toISOString() }
        try {
          const sid = currentSession()
          diag.session = sid
          const msgs = sid ? listMessages(sid) : []
          diag.messageCount = msgs.length
          const ids = msgs.map((m: any) => messageId(m)).filter(Boolean)
          diag.firstId = ids[0] ?? null
          diag.lastId = ids[ids.length - 1] ?? null
          const root: any = renderer?.root
          diag.rootType = root ? String(root.constructor?.name) : null
          diag.hasFindDescendantById = !!root && typeof root.findDescendantById === "function"
          const checked: unknown[] = []
          for (let i = Math.max(0, ids.length - 10); i < ids.length; i++) {
            const id = ids[i]
            const node = messageNode(context, id)
            const entry: Record<string, unknown> = {
              id: id ? String(id).slice(-10) : null,
              node: !!node,
              yType: node ? typeof (node as any).y : null,
              y: node ? (typeof (node as any).y === "number" ? (node as any).y : String((node as any).y)) : null,
              heightType: node ? typeof (node as any).height : null,
            }
            if (node) {
              let cur: any = node.parent
              let hops = 0
              const chain: string[] = []
              while (cur && typeof cur === "object" && hops < 14) {
                chain.push(String(cur.id ?? cur.constructor?.name).slice(0, 24))
                cur = cur.parent
                hops++
              }
              entry.parentHops = hops
              entry.chain = chain.slice(0, 8).join(" <- ")
              const box = findScrollBoxAncestor(node)
              entry.boxType = box ? String((box as any).constructor?.name) : null
              if (box) {
                const off = offsetWithin(box, node)
                entry.offsetWithin = off
                entry.offsetTopBox = typeof (box as any).y === "number" ? (box as any).y : null
                entry.boxId = String(box.id ?? "")
                if (offsetWithin(box, node) !== null && entry.boxSample !== true) {
                  entry.boxSample = true
                  diag.boxSample = {
                    scrollTop: typeof (box as any).scrollTop === "number" ? (box as any).scrollTop : String((box as any).scrollTop),
                    height: typeof (box as any).height === "number" ? (box as any).height : String((box as any).height),
                    scrollHeight: typeof (box as any).scrollHeight === "number" ? (box as any).scrollHeight : String((box as any).scrollHeight),
                    viewportHeight: typeof (box as any).viewport?.height === "number" ? (box as any).viewport.height : String((box as any).viewport?.height),
                    contentHeight: typeof (box as any).content?.height === "number" ? (box as any).content.height : String((box as any).content?.height),
                    screenY: typeof (box as any)._screenY === "number" ? (box as any)._screenY : String((box as any)._screenY),
                    scrollState: (() => {
                      try {
                        const st = (box as any)._scrollState?.()
                        return st ? { y: st.y, height: st.height, contentHeight: st.contentHeight } : null
                      } catch {
                        return null
                      }
                    })(),
                  }
                }
              }
            }
            checked.push(entry)
          }
          diag.checked = checked
          diag.selectionApi = {
            start: typeof renderer?.startSelection,
            update: typeof renderer?.updateSelection,
            clear: typeof renderer?.clearSelection,
            hasSelection: (() => {
              try {
                return !!renderer?.hasSelection
              } catch {
                return null
              }
            })(),
          }
          const diagBox = ensureVisualBox(msgs)
          if (diagBox) {
            const top = boxTopOf(diagBox)
            const vis = lineIndex(diagBox, true)
            const full = lineIndex(diagBox, false)
            const hit = vis[0] ?? null
            const roots: RNode[] = []
            try {
              collectSelectableRoots(diagBox, roots)
            } catch {
              /* ignore */
            }
            diag.visual = {
              active: visual.active,
              linewise: visual.linewise,
              anchorRow: visual.anchorRow,
              anchorCol: visual.anchorCol,
              cursorRow: visual.cursorRow,
              cursorCol: visual.cursorCol,
            }
            diag.selectionContainer = (() => {
              try {
                const c: any = renderer?.getSelectionContainer?.() ?? null
                return c ? String(c.id ?? c.constructor?.name ?? "") : null
              } catch {
                return null
              }
            })()
            diag.lineIndex = {
              boxTop: top,
              boxHeight: boxHeightOf(diagBox),
              count: vis.length,
              fullCount: full.length,
              firstRow: vis[0]?.row ?? null,
              lastRow: vis[vis.length - 1]?.row ?? null,
              cursor: {
                row: visual.cursorRow,
                col: visual.cursorCol,
                hit: entryAtRow(vis, typeof visual.cursorRow === "number" ? visual.cursorRow : vis[0]?.row)
                  ? {
                      row: entryAtRow(vis, visual.cursorRow)?.row,
                      text: entryAtRow(vis, visual.cursorRow)?.text.slice(0, 80),
                    }
                  : null,
              },
              roots: roots.slice(0, 40).map((r) => ({
                id: String((r as any).id ?? "").slice(0, 40),
                type: String((r as any).constructor?.name ?? ""),
                selectable: (r as any).selectable,
                x: (r as any).x,
                y: (r as any).y,
                width: (r as any).width,
                height: (r as any).height,
                lineInfo: !!(r as any).lineInfo,
                sourceLines: (r as any).lineInfo?.lineSources?.length ?? null,
                plainChars: typeof (r as any).plainText === "string" ? (r as any).plainText.length : null,
              })),
              first: hit
                ? {
                    row: hit.row,
                    text: hit.text.slice(0, 80),
                    node: String((hit.node as any)?.constructor?.name ?? ""),
                    selectable: (hit.node as any)?.selectable,
                    width: (hit.node as any)?.width,
                    selectionBg: (() => {
                      try {
                        return String((hit.node as any)?.selectionBg ?? "undefined")
                      } catch {
                        return null
                      }
                    })(),
                  }
                : null,
              lines: vis.slice(0, 40).map((e) => ({ row: e.row, text: e.text.slice(0, 80) })),
              selectedText: (() => {
                try {
                  return String(renderer?.getSelection?.()?.getSelectedText?.() ?? "").slice(0, 240)
                } catch {
                  return null
                }
              })(),
            }
          }
          diag.visibleTopResult = visibleTopMessageId(context, ensureVisualBox(msgs) ?? ({ id: "no-box" } as RNode), msgs, resolveNodeCached)
        } catch (e: any) {
          diag.error = String(e?.stack ?? e)
        }
        try {
          const fs = await import("node:fs")
          fs.appendFileSync("/tmp/scroll-mode-diag.json", JSON.stringify(diag, null, 1) + "\n---\n")
        } catch (e2: any) {
          diag.writeError = String(e2)
        }
        toast("Diagnostics → /tmp/scroll-mode-diag.json")
      })()
    }

    keymap.layer(() => {
      const active = state.active
      const suspended = focusState.foreign

      const commands: any[] = []
      if (!suspended) {
        commands.push({
          id: "scroll-mode.toggle",
          title: "Toggle scroll mode",
          group: "Scroll mode",
          palette: true,
          bind: options.toggleKey,
          run: () => {
            const next = !state.active
            setState((draft: any) => {
              draft.active = next
            })
            exitVisual()
            if (!next) {
              exitScroll()
              toast("Edit mode: editor enabled, readline keys restored")
              return
            }
            enterScroll()
            if (options.vim) {
              toast(
                "Scroll mode: editor disabled · j/k cursor · h/l column · w/b/e word · 0/$ ends · ctrl+d/u half · ctrl+f/b page · gg/G ends · [ ] user msgs · v/V select from cursor · y yank · Y visible lines · / ? search · n/N match · q exit",
              )
            } else {
              toast(`Scroll mode: editor disabled · ctrl+u / ctrl+d scroll, ${options.toggleKey} back to edit`)
            }
          },
        })
      }

      if (active && !suspended) {
        // Half-page scrolling. The cursor keeps its screen row while the text
        // scrolls under it, in both normal and visual mode.
        commands.push(
          {
            id: "scroll-mode.up",
            title: "Move cursor / scroll half page up",
            group: "Scroll mode",
            bind: "ctrl+u",
            run: () => afterPageScroll(CMD.halfUp),
          },
          {
            id: "scroll-mode.down",
            title: "Move cursor / scroll half page down",
            group: "Scroll mode",
            bind: "ctrl+d",
            run: () => afterPageScroll(CMD.halfDown),
          },
        )

        if (options.vim) {
          commands.push(
            {
              id: "scroll-mode.line.up",
              title: "Move cursor up",
              group: "Scroll mode",
              bind: "k",
              run: () => moveCursor(-1),
            },
            {
              id: "scroll-mode.line.down",
              title: "Move cursor down",
              group: "Scroll mode",
              bind: "j",
              run: () => moveCursor(1),
            },
            {
              id: "scroll-mode.cursor.col.left",
              title: visual.active ? "Extend selection left" : "Move cursor left",
              group: "Scroll mode",
              palette: true,
              bind: "h",
              run: () => moveCol(-1),
            },
            {
              id: "scroll-mode.cursor.col.left.arrow",
              title: visual.active ? "Extend selection left (arrow)" : "Move cursor left (arrow)",
              group: "Scroll mode",
              bind: "left",
              run: () => moveCol(-1),
            },
            {
              id: "scroll-mode.cursor.col.right",
              title: visual.active ? "Extend selection right" : "Move cursor right",
              group: "Scroll mode",
              palette: true,
              bind: "l",
              run: () => moveCol(1),
            },
            {
              id: "scroll-mode.cursor.col.right.arrow",
              title: visual.active ? "Extend selection right (arrow)" : "Move cursor right (arrow)",
              group: "Scroll mode",
              bind: "right",
              run: () => moveCol(1),
            },
            {
              id: "scroll-mode.cursor.word.next",
              title: visual.active ? "Extend selection to next word" : "Move to next word",
              group: "Scroll mode",
              bind: "w",
              run: () => moveWord("w"),
            },
            {
              id: "scroll-mode.cursor.word.prev",
              title: visual.active ? "Extend selection to previous word" : "Move to previous word",
              group: "Scroll mode",
              bind: "b",
              run: () => moveWord("b"),
            },
            {
              id: "scroll-mode.cursor.word.end",
              title: visual.active ? "Extend selection to end of word" : "Move to end of word",
              group: "Scroll mode",
              bind: "e",
              run: () => moveWord("e"),
            },
            {
              id: "scroll-mode.cursor.line.start",
              title: visual.active ? "Extend selection to line start" : "Move to line start",
              group: "Scroll mode",
              bind: "0",
              run: () => moveLineEdge("start"),
            },
            {
              id: "scroll-mode.cursor.line.end",
              title: visual.active ? "Extend selection to line end" : "Move to line end",
              group: "Scroll mode",
              bind: "$",
              run: () => moveLineEdge("end"),
            },
            {
              id: "scroll-mode.page.up",
              title: "Move cursor / scroll page up",
              group: "Scroll mode",
              bind: "ctrl+b",
              run: () => afterPageScroll(CMD.pageUp),
            },
            {
              id: "scroll-mode.page.down",
              title: "Move cursor / scroll page down",
              group: "Scroll mode",
              bind: "ctrl+f",
              run: () => afterPageScroll(CMD.pageDown),
            },
            {
              id: "scroll-mode.first",
              title: "Go to first message",
              group: "Scroll mode",
              bind: "gg",
              run: () => afterJump(CMD.first, "top"),
            },
            {
              id: "scroll-mode.last",
              title: "Go to last message",
              group: "Scroll mode",
              bind: "shift+g",
              run: () => afterJump(CMD.last, "bottom"),
            },
            {
              id: "scroll-mode.prev_user",
              title: "Previous user message",
              group: "Scroll mode",
              bind: "[",
              run: () => afterJump(CMD.prevUser, "top"),
            },
            {
              id: "scroll-mode.next_user",
              title: "Next user message",
              group: "Scroll mode",
              bind: "]",
              run: () => afterJump(CMD.nextUser, "top"),
            },
            {
              id: "scroll-mode.visual.enter",
              title: "Visual mode (charwise, from the cursor)",
              group: "Scroll mode",
              palette: true,
              bind: "v",
              run: () => {
                if (!visual.active) enterVisual(false)
              },
            },
            {
              id: "scroll-mode.visual.enter.line",
              title: "Visual mode (linewise, from the cursor)",
              group: "Scroll mode",
              palette: true,
              bind: "shift+v",
              run: () => {
                if (!visual.active) enterVisual(true)
              },
            },
            {
              id: "scroll-mode.visual.yank",
              title: visual.active ? "Yank selection to clipboard" : "Yank cursor line",
              group: "Scroll mode",
              palette: true,
              bind: "y",
              run: () => {
                void yankVisual()
              },
            },
            {
              id: "scroll-mode.copy.visible",
              title: visual.active ? "Yank selection (linewise)" : "Copy every visible line",
              group: "Scroll mode",
              palette: true,
              bind: "shift+y",
              run: () => {
                if (visual.active) void yankVisual(true)
                else void yankVisibleLines()
              },
            },
            {
              id: "scroll-mode.exit",
              title: "Exit scroll mode",
              group: "Scroll mode",
              bind: "q",
              run: () => {
                // q is a vim-consistent "cancel" inside visual selection.
                if (visual.active) {
                  exitVisual()
                  toast("Back to scroll mode")
                  return
                }
                setState((draft: any) => {
                  draft.active = false
                })
                exitScroll()
                toast("Edit mode: editor enabled, readline keys restored")
              },
            },
            {
              id: "scroll-mode.debug",
              title: "Dump viewport diagnostics",
              group: "Scroll mode",
              palette: true,
              run: () => dumpViewportDiagnostics(),
            },
          )

          if (visual.active) {
            commands.push(
              {
                id: "scroll-mode.visual.swap",
                title: "Swap anchor and cursor",
                group: "Scroll mode",
                palette: true,
                bind: "o",
                run: () => swapEnds(),
              },
              {
                id: "scroll-mode.visual.cancel",
                title: "Cancel selection (stay in scroll mode)",
                group: "Scroll mode",
                bind: "escape",
                run: () => {
                  exitVisual()
                  toast("Back to scroll mode")
                },
              },
            )
          }
        }

        if (options.search) {
          commands.push(
            {
              id: "scroll-mode.search",
              title: "Search messages",
              group: "Scroll mode",
              palette: true,
              bind: "/",
              run: () => runSearch(false),
            },
            {
              id: "scroll-mode.search.back",
              title: "Search messages (backward)",
              group: "Scroll mode",
              bind: "?",
              run: () => runSearch(true),
            },
            {
              id: "scroll-mode.search.next",
              title: "Next search match",
              group: "Scroll mode",
              bind: "n",
              run: () => stepSearch(1),
            },
            {
              id: "scroll-mode.search.prev",
              title: "Previous search match",
              group: "Scroll mode",
              bind: "shift+n",
              run: () => stepSearch(-1),
            },
          )
        }
      }

      // Wrap every command's run() so it re-reads live focus at execution time.
      // If a dialog owns focus we return false (continue keyboard dispatch) so
      // the key reaches the dialog untouched, and the scroll action never runs.
      // This bypasses the layer's reactive suspension, which is unreliable.
      const guarded = commands.map((c: any) => ({
        ...c,
        run: (...args: any[]) => {
          if (dialogHasFocus()) return false
          return c.run(...args)
        },
      }))

      return {
        mode: "global",
        priority: 100,
        commands: guarded,
        bindings: guarded.map((c) => c.id),
      }
    })

    // Register the guard after the keymap layer so the host's dispatcher runs
    // first and scroll bindings still fire; the guard only stops the event from
    // reaching renderables (the composer).
    try {
      if (renderer?.keyInput && typeof renderer.keyInput.on === "function") {
        renderer.keyInput.on("keypress", onKey)
        detachGuard = () => {
          try {
            renderer.keyInput.off("keypress", onKey)
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* ignore */
    }

    // Keep the composer's cursor hidden if the host re-focuses or remounts it.
    try {
      if (renderer && typeof renderer.on === "function") {
        renderer.on("focused_editor", onFocusedEditor)
        detachCursorGuard = () => {
          try {
            renderer.off("focused_editor", onFocusedEditor)
          } catch {
            /* ignore */
          }
        }
        renderer.on("focused_renderable", onFocusChange)
        detachFocusGuard = () => {
          try {
            renderer.off("focused_renderable", onFocusChange)
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* ignore */
    }

    // If the plugin reloads while scroll mode was on, keep the editor locked
    // and the highlight poll running (enterScroll starts it).
    const restoreIfActive = setTimeout(() => {
      if (state.active) enterScroll()
    }, 0)

    return () => {
      clearTimeout(restoreIfActive)
      detachGuard?.()
      detachCursorGuard?.()
      detachFocusGuard?.()
      try {
        renderer?.removePostProcessFn?.(drawCursorBar)
      } catch {
        /* ignore */
      }
      exitScroll()
    }
  },
})
