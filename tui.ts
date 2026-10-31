import { spawn } from "node:child_process"
import { Plugin } from "@opencode/plugin/tui"

// Conversation scroll mode for the OpenCode TUI.
//
// - ctrl+q toggles between edit mode and scroll mode:
//   * edit mode (default): the composer keeps its readline keys
//     (ctrl+u delete-to-line-start, ctrl+d delete char, etc.).
//   * scroll mode: navigation keys scroll the transcript by dispatching the
//     built-in session.* commands, and (optionally) vim keys + message search.
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
//
// Visual mode (message granularity): v / V anchor on the message currently at
// the top of the transcript viewport; navigation keys keep the other end
// (mark) following the viewport; y copies the selected messages' plain text
// to the system clipboard (OSC52, with pbcopy/xclip/wl-copy as fallback).
// The host owns transcript rendering, so a true on-screen highlight is out of
// reach for now — toasts announce anchor/range instead.

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
  highlight: boolean
}

function readOptions(raw: unknown): Options {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  const maxRaw = o.maxResults
  return {
    vim: o.vim !== false,
    search: o.search !== false,
    maxResults: typeof maxRaw === "number" && maxRaw > 0 ? Math.floor(maxRaw) : 100,
    searchScope: o.searchScope === "user" ? "user" : "all",
    highlight: o.highlight !== false,
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

// Deepest child renderable covering absolute screen row `screenRow`. The
// deepest match is what the selection machinery wants (a text node, not the
// outer message box). Note: Renderable.x/y are absolute screen coordinates in
// this build, so no parent offset accumulates while descending.
function findLineNodeAt(root: RNode, screenRow: number, depth = 0): RNode | null {
  if (depth > 10) return null
  let kids: RNode[] = []
  try {
    const c = (root as any).getChildren?.()
    if (Array.isArray(c)) kids = c as RNode[]
  } catch {
    return null
  }
  for (const child of kids) {
    const cy = (child as any).y
    const ch = (child as any).height
    if (typeof cy !== "number" || typeof ch !== "number" || ch <= 0) continue
    if (screenRow < cy || screenRow >= cy + ch) continue
    const inner = findLineNodeAt(child, screenRow, depth + 1)
    return inner ?? child
  }
  return null
}

// Line-range extraction: from (aIdx, aLine) to (bIdx, bLine), both lines
// inclusive and measured from the top of each message's text.
function rangeTextLines(
  msgs: any[],
  aIdx: number,
  aLine: number,
  bIdx: number,
  bLine: number,
): string {
  if (aIdx < 0 || bIdx < 0 || msgs.length === 0) return ""
  const forward = aIdx < bIdx || (aIdx === bIdx && aLine <= bLine)
  const loIdx = forward ? aIdx : bIdx
  const loLine = forward ? aLine : bLine
  const hiIdx = forward ? bIdx : aIdx
  const hiLine = forward ? bLine : aLine
  const out: string[] = []
  for (let i = loIdx; i <= hiIdx && i < msgs.length; i++) {
    const lines = messageText(msgs[i]).split("\n")
    const start = i === loIdx ? Math.max(0, loLine) : 0
    const end = i === hiIdx ? Math.min(lines.length - 1, hiLine) : lines.length - 1
    for (let l = start; l <= end; l++) out.push(lines[l] ?? "")
  }
  return out.join("\n")
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
    // Visual selection: anchor/mark are (message id, line index) pairs, where
    // the line is measured from the top of that message's text. The mark
    // follows the viewport top line, so navigation grows the selection.
    const [visual, setVisual] = context.storage.memory("scroll-mode.visual", {
      initial: {
        active: false,
        linewise: false,
        anchorId: null as string | null,
        anchorLine: 0,
        markId: null as string | null,
        markLine: 0,
      },
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

    const onKey = (key: any) => {
      if (!state.active) return
      const focused = focusedRenderable()
      // A dialog or other widget has taken focus: let it receive input.
      if (focused && focused !== savedFocus) return
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
      setTimeout(applyHighlight, 150)
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
      setTimeout(applyHighlight, 150)
    }

    // ---- visual mode ---------------------------------------------------------
    // Anchor/mark are message ids. They coerce to indexes in the session message
    // list at yank time, so ranges work even across the host's loaded window.

    let visualBox: RNode | undefined | null // undefined = unknown, null = lookup failed

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

    const ensureVisualBox = (msgs: any[]): RNode | null => {
      if (visualBox) return visualBox
      if (visualBox === null) return null
      for (const m of msgs) {
        const id = messageId(m)
        if (!id) continue
        const node = messageNode(context, id)
        if (!node) continue
        const box = findScrollBoxAncestor(node)
        if (box) {
          visualBox = box
          return box
        }
      }
      return null
    }

    // ---- line cursor / visual range highlight --------------------------------
    // The cursor is one selected LINE at the top of the viewport; visual mode
    // extends that selection to the anchor line. Highlighting goes through the
    // host's own selection machinery (startSelection with "line" behavior), so
    // it uses real text metrics and the theme's selection colors instead of
    // tinting whole message boxes.
    let pollTimer: ReturnType<typeof setInterval> | undefined
    let lastKey: string | null = null
    let selectionWarned = false

    const stopPoll = () => {
      if (pollTimer) {
        clearInterval(pollTimer)
        pollTimer = undefined
      }
    }

    const clearLineSelection = () => {
      lastKey = null
      try {
        renderer?.clearSelection?.()
      } catch {
        /* ignore */
      }
    }

    const idxInList = (msgs: any[], id: string | null): number =>
      id ? msgs.findIndex((m) => messageId(m) === id) : -1

    // A hit is the renderable the host's selection code wants (deepest
    // selectable text node), plus the ABSOLUTE screen row of the target line
    // and the line index inside the message text (used by yank).
    // Node coordinates: Renderable.x/y are absolute screen coordinates in this
    // build, which is exactly what startSelection/updateSelection expect.
    type VHit = { node: RNode; screenY: number; msgId: string; msgLine: number }

    const pickSelectable = (node: RNode): RNode | null => {
      let cur: any = node
      for (let i = 0; i < 8 && cur; i++) {
        if (cur.selectable === true && !cur.isDestroyed) return cur as RNode
        cur = cur.parent
      }
      return null
    }

    const makeHit = (id: string, msgNode: RNode, localRow: number): VHit => {
      const baseY = typeof (msgNode as any).y === "number" ? (msgNode as any).y : 0
      const screenY = Math.round(baseY + localRow)
      const inner = findLineNodeAt(msgNode, screenY)
      const node = pickSelectable(inner ?? msgNode) ?? msgNode
      return { node, screenY, msgId: id, msgLine: Math.max(0, Math.floor(localRow)) }
    }

    // The text line at absolute screen row `row` (the cursor line).
    const hitAtScreenRow = (msgs: any[], row: number): VHit | null => {
      for (const m of msgs) {
        const id = messageId(m)
        if (!id) continue
        const node = resolveNodeCached(id)
        if (!node) continue
        const y = (node as any).y
        const h = (node as any).height
        if (typeof y !== "number" || typeof h !== "number" || h <= 0) continue
        if (row < y || row >= y + h) continue
        return makeHit(id, node, row - y)
      }
      return null
    }

    // The first text line visible from the top of the scroll viewport. A
    // partially scrolled message contributes its clipped bottom, so the
    // cursor sits on the first line that is actually on screen.
    const topLineHit = (msgs: any[], top: number): VHit | null => {
      for (const m of msgs) {
        const id = messageId(m)
        if (!id) continue
        const node = resolveNodeCached(id)
        if (!node) continue
        const y = (node as any).y
        const h = (node as any).height
        if (typeof y !== "number" || typeof h !== "number" || h <= 0) continue
        if (y + h <= top) continue
        const row = Math.max(top, y)
        if (row >= y + h) continue
        return makeHit(id, node, row - y)
      }
      return null
    }

    const hitInMessage = (id: string | null, line: number): VHit | null => {
      if (!id) return null
      const node = resolveNodeCached(id)
      if (!node) return null
      return makeHit(id, node, line)
    }

    const applyHighlight = () => {
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
      const boxTop = typeof (box as any).y === "number" ? Math.round((box as any).y) : 0
      const cursor = topLineHit(msgs, boxTop)
      if (!cursor) return
      // The visual mark follows the viewport top line; the anchor stays put.
      if (visual.active && (cursor.msgId !== visual.markId || cursor.msgLine !== visual.markLine)) {
        setVisual((draft: any) => {
          draft.markId = cursor.msgId
          draft.markLine = cursor.msgLine
        })
      }
      const anchor = visual.active ? hitInMessage(visual.anchorId, visual.anchorLine) : null
      const key = `${visual.active ? "v" : "c"}|${anchor?.msgId ?? ""}:${anchor?.msgLine ?? -1}|${cursor.msgId}:${cursor.msgLine}`
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
        const start = anchor ?? cursor
        const x = (node: RNode): number =>
          typeof (node as any).x === "number" ? Math.round((node as any).x) : 0
        // Absolute screen coordinates; "line" behavior snaps both ends to
        // whole text lines, so this paints a clean line-wise range.
        renderer.startSelection(start.node, x(start.node), start.screenY, "line")
        renderer.updateSelection(cursor.node, x(cursor.node), cursor.screenY, { finishDragging: true })
        renderer.requestRender?.()
      } catch {
        if (!selectionWarned) {
          selectionWarned = true
          toast("This OpenCode build lacks the selection API — line highlight unavailable", "warning")
        }
      }
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
      const boxTop = box && typeof (box as any).y === "number" ? Math.round((box as any).y) : 0
      const hit = box ? topLineHit(msgs, boxTop) : null
      if (!hit) {
        toast("No message rendered in view — jump with [ ] or / first, then press v", "warning")
        return
      }
      setVisual((draft: any) => {
        draft.active = true
        draft.linewise = linewise
        draft.anchorId = hit.msgId
        draft.anchorLine = hit.msgLine
        draft.markId = hit.msgId
        draft.markLine = hit.msgLine
      })
      lastKey = null
      applyHighlight()
      const pos = idxInList(msgs, hit.msgId) + 1
      toast(
        `${linewise ? "V" : "v"} visual: msg ${pos}/${msgs.length} line ${hit.msgLine + 1} — j/k/… move · o swap · y yank · esc cancel`,
      )
    }

    const exitVisual = () => {
      setVisual((draft: any) => {
        draft.active = false
        draft.anchorId = null
        draft.anchorLine = 0
        draft.markId = null
        draft.markLine = 0
      })
      // Back to the single-line cursor on the next refresh.
      lastKey = null
      applyHighlight()
    }

    const yankVisual = async () => {
      const sid = currentSession()
      if (!sid) return
      const msgs = listMessages(sid)
      const idxOf = (id: string | null): number =>
        id ? msgs.findIndex((m) => messageId(m) === id) : -1
      let a: number
      let aLine: number
      let b: number
      let bLine: number
      if (visual.active) {
        a = idxOf(visual.anchorId)
        aLine = visual.anchorLine
        b = idxOf(visual.markId)
        bLine = visual.markLine
      } else {
        // Normal-mode y: yank the cursor line (the viewport top line).
        const box = ensureVisualBox(msgs)
        const boxTop = box && typeof (box as any).y === "number" ? Math.round((box as any).y) : 0
        const hit = box ? topLineHit(msgs, boxTop) : null
        if (!hit) {
          toast("Nothing under the viewport to yank — scroll a line into view first", "warning")
          return
        }
        a = idxOf(hit.msgId)
        aLine = hit.msgLine
        b = a
        bLine = hit.msgLine
      }
      if (a < 0 || b < 0) {
        toast("Nothing under the viewport to yank — scroll a line into view first", "warning")
        return
      }
      // Prefer the host selection text: it comes from the rendered lines, so
      // it stays exact when text wraps. Fall back to plain-text slicing.
      applyHighlight()
      let text = ""
      try {
        text = renderer?.getSelection?.()?.getSelectedText?.() ?? ""
      } catch {
        /* ignore */
      }
      if (!text.trim()) text = rangeTextLines(msgs, a, aLine, b, bLine)
      if (!text.trim()) {
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

    // After a scroll dispatch the viewport settles on the next frame; update
    // the visual mark then. Cheap no-op while visual mode is off.
    const afterScroll = (fn: () => void) => () => {
      fn()
      setTimeout(applyHighlight, 120)
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
            const top = typeof (diagBox as any).y === "number" ? Math.round((diagBox as any).y) : 0
            const hit = topLineHit(msgs, top)
            diag.lineCursor = {
              boxTop: top,
              hit: hit
                ? {
                    msgId: String(hit.msgId).slice(-10),
                    screenY: hit.screenY,
                    msgLine: hit.msgLine,
                    node: String((hit.node as any)?.constructor?.name ?? ""),
                    selectable: (hit.node as any)?.selectable,
                  }
                : null,
              selectedText: (() => {
                try {
                  return String(renderer?.getSelection?.()?.getSelectedText?.() ?? "").slice(0, 160)
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

      const commands: any[] = [
        {
          id: "scroll-mode.toggle",
          title: "Toggle scroll mode",
          group: "Scroll mode",
          palette: true,
          bind: "ctrl+q",
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
                "Scroll mode: editor disabled · j/k line · ctrl+d/u half · ctrl+f/b page · gg/G ends · [ ] user msgs · v/V select · y yank · / ? search · n/N match · q exit",
              )
            } else {
              toast("Scroll mode: editor disabled · ctrl+u / ctrl+d scroll, ctrl+q back to edit")
            }
          },
        },
      ]

      if (active) {
        // Half-page scrolling — always available in scroll mode. In visual
        // mode the mark follows the viewport ~120ms after each move.
        commands.push(
          {
            id: "scroll-mode.up",
            title: "Scroll half page up",
            group: "Scroll mode",
            bind: "ctrl+u",
            run: afterScroll(() => keymap.dispatch(CMD.halfUp)),
          },
          {
            id: "scroll-mode.down",
            title: "Scroll half page down",
            group: "Scroll mode",
            bind: "ctrl+d",
            run: afterScroll(() => keymap.dispatch(CMD.halfDown)),
          },
        )

        if (options.vim) {
          commands.push(
            {
              id: "scroll-mode.line.up",
              title: "Scroll line up",
              group: "Scroll mode",
              bind: "k",
              run: afterScroll(() => keymap.dispatch(CMD.lineUp)),
            },
            {
              id: "scroll-mode.line.down",
              title: "Scroll line down",
              group: "Scroll mode",
              bind: "j",
              run: afterScroll(() => keymap.dispatch(CMD.lineDown)),
            },
            {
              id: "scroll-mode.page.up",
              title: "Scroll page up",
              group: "Scroll mode",
              bind: "ctrl+b",
              run: afterScroll(() => keymap.dispatch(CMD.pageUp)),
            },
            {
              id: "scroll-mode.page.down",
              title: "Scroll page down",
              group: "Scroll mode",
              bind: "ctrl+f",
              run: afterScroll(() => keymap.dispatch(CMD.pageDown)),
            },
            {
              id: "scroll-mode.first",
              title: "Go to first message",
              group: "Scroll mode",
              bind: "gg",
              run: afterScroll(() => keymap.dispatch(CMD.first)),
            },
            {
              id: "scroll-mode.last",
              title: "Go to last message",
              group: "Scroll mode",
              bind: "shift+g",
              run: afterScroll(() => keymap.dispatch(CMD.last)),
            },
            {
              id: "scroll-mode.prev_user",
              title: "Previous user message",
              group: "Scroll mode",
              bind: "[",
              run: afterScroll(() => keymap.dispatch(CMD.prevUser)),
            },
            {
              id: "scroll-mode.next_user",
              title: "Next user message",
              group: "Scroll mode",
              bind: "]",
              run: afterScroll(() => keymap.dispatch(CMD.nextUser)),
            },
            {
              id: "scroll-mode.visual.enter",
              title: "Visual mode (select messages)",
              group: "Scroll mode",
              palette: true,
              bind: "v",
              run: () => {
                if (!visual.active) enterVisual(false)
              },
            },
            {
              id: "scroll-mode.visual.enter.line",
              title: "Visual mode (linewise)",
              group: "Scroll mode",
              palette: true,
              bind: "shift+v",
              run: () => {
                if (!visual.active) enterVisual(true)
              },
            },
            {
              id: "scroll-mode.visual.yank",
              title: visual.active ? "Yank selection lines to clipboard" : "Yank cursor line",
              group: "Scroll mode",
              palette: true,
              bind: "y",
              run: () => {
                void yankVisual()
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
                run: () => {
                  setVisual((draft: any) => {
                    const a = draft.anchorId
                    const al = draft.anchorLine
                    draft.anchorId = draft.markId
                    draft.anchorLine = draft.markLine
                    draft.markId = a
                    draft.markLine = al
                  })
                  toast("Anchor and cursor swapped")
                },
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

      return {
        mode: "global",
        priority: 100,
        commands,
        bindings: commands.map((c) => c.id),
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
      exitScroll()
    }
  },
})
