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
}

function readOptions(raw: unknown): Options {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  const maxRaw = o.maxResults
  return {
    vim: o.vim !== false,
    search: o.search !== false,
    maxResults: typeof maxRaw === "number" && maxRaw > 0 ? Math.floor(maxRaw) : 100,
    searchScope: o.searchScope === "user" ? "user" : "all",
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

// ---- plugin ---------------------------------------------------------------

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
            if (!next) {
              exitScroll()
              toast("Edit mode: editor enabled, readline keys restored")
              return
            }
            enterScroll()
            if (options.vim) {
              toast(
                "Scroll mode: editor disabled · j/k line · ctrl+d/u half · ctrl+f/b page · gg/G ends · [ ] user msgs · / ? search · n/N match · q exit",
              )
            } else {
              toast("Scroll mode: editor disabled · ctrl+u / ctrl+d scroll, ctrl+q back to edit")
            }
          },
        },
      ]

      if (active) {
        // Half-page scrolling — always available in scroll mode.
        commands.push(
          {
            id: "scroll-mode.up",
            title: "Scroll half page up",
            group: "Scroll mode",
            bind: "ctrl+u",
            run: () => keymap.dispatch(CMD.halfUp),
          },
          {
            id: "scroll-mode.down",
            title: "Scroll half page down",
            group: "Scroll mode",
            bind: "ctrl+d",
            run: () => keymap.dispatch(CMD.halfDown),
          },
        )

        if (options.vim) {
          commands.push(
            {
              id: "scroll-mode.line.up",
              title: "Scroll line up",
              group: "Scroll mode",
              bind: "k",
              run: () => keymap.dispatch(CMD.lineUp),
            },
            {
              id: "scroll-mode.line.down",
              title: "Scroll line down",
              group: "Scroll mode",
              bind: "j",
              run: () => keymap.dispatch(CMD.lineDown),
            },
            {
              id: "scroll-mode.page.up",
              title: "Scroll page up",
              group: "Scroll mode",
              bind: "ctrl+b",
              run: () => keymap.dispatch(CMD.pageUp),
            },
            {
              id: "scroll-mode.page.down",
              title: "Scroll page down",
              group: "Scroll mode",
              bind: "ctrl+f",
              run: () => keymap.dispatch(CMD.pageDown),
            },
            {
              id: "scroll-mode.first",
              title: "Go to first message",
              group: "Scroll mode",
              bind: "gg",
              run: () => keymap.dispatch(CMD.first),
            },
            {
              id: "scroll-mode.last",
              title: "Go to last message",
              group: "Scroll mode",
              bind: "shift+g",
              run: () => keymap.dispatch(CMD.last),
            },
            {
              id: "scroll-mode.prev_user",
              title: "Previous user message",
              group: "Scroll mode",
              bind: "[",
              run: () => keymap.dispatch(CMD.prevUser),
            },
            {
              id: "scroll-mode.next_user",
              title: "Next user message",
              group: "Scroll mode",
              bind: "]",
              run: () => keymap.dispatch(CMD.nextUser),
            },
            {
              id: "scroll-mode.exit",
              title: "Exit scroll mode",
              group: "Scroll mode",
              bind: "q",
              run: () => {
                setState((draft: any) => {
                  draft.active = false
                })
                exitScroll()
                toast("Edit mode: editor enabled, readline keys restored")
              },
            },
          )
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

    // If the plugin reloads while scroll mode was on, keep the editor locked.
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
