# opencode-scroll-mode

OpenCode TUI 的「对话滚动模式」插件：一键切换编辑 / 滚动两种状态，滚动时支持 vim 键位、消息搜索与 visual 选区复制。

## 功能

- `ctrl+q` 在「编辑模式」与「滚动模式」之间切换。
  - 编辑模式：输入框保留原生 readline 键位。
  - 滚动模式：导航键位滚动 transcript，并启用 vim 键位与搜索。
  - 滚动模式会**锁定输入框**：进入时让编辑器失焦、隐藏编辑光标，并全局吞掉按键，避免滚动时误把字符打进 prompt；退出时恢复焦点、光标与输入。对话框（搜索、选择等）获得焦点时自动放行。
- 滚动全部委托给 OpenCode 内置的 `session.*` 命令，不自行计算偏移，避免与 transcript 分页冲突。
- 状态存于内存：每次 TUI 启动重置，插件热重载时保留。

## 键位（仅滚动模式下生效）

| 键 | 动作 |
| --- | --- |
| `ctrl+q` | 开 / 关滚动模式 |
| `j` / `k` | 下 / 上一行 |
| `ctrl+d` / `ctrl+u` | 下 / 上半页 |
| `ctrl+f` / `ctrl+b` | 下 / 上整页 |
| `gg` / `G` | 跳到首条 / 末条消息 |
| `[` / `]` | 上 / 下一条用户消息 |
| `/` / `?` | 打开搜索（正 / 反向） |
| `n` / `N` | 下 / 上一个匹配 |
| `q` | 退出滚动模式（visual 中先取消选区） |

## Visual 选区与复制

`v` / `V` 以**当前视口顶部的行**为锚点进入 visual 选区：

| 键 | 动作 |
| --- | --- |
| `v` | 进入 charwise（字符）选择：上下移动跨行，`h`/`l`（或 ←/→）在这一行左右扩展 |
| `V` | 进入 linewise（整行）选择 |
| `j` `k` `C-d` `C-u` `C-f` `C-b` `gg` `G` `[` `]` `n` `N` | 移动；游标（另一端）随视口自动跟随（~120ms 刷新） |
| `h` / `l`、`←` / `→` | charwise 下向左 / 右扩展选区 |
| `o` | 交换锚点与游标（视口会跟到新的游标端） |
| `y` | yank 选中文本（含跨消息）→ 系统剪贴板；退出 visual |
| `y`（非 visual） | 复制光标所在的那一行 |
| `esc` / `q` | 取消选区，留在滚动模式 |

复制通道：优先 **OSC52**（iTerm2 需在设置里允许终端访问剪贴板；tmux 需 `set -g set-clipboard on`；ssh 远端也可能直接生效），失败时回退 `pbcopy`（macOS）/ `wl-copy` / `xclip`（Linux）。

### 视觉反馈（行光标 + 选区）

滚动模式下，**视口顶部的第一行**整行着色，作为「行光标」；按 `v` 后锚点行到当前行之间高亮，`h`/`l` 在当前行左右扩展，`V` 则按整行选中。退出滚动模式或取消 visual 时立即清除并恢复宿主原色。

实现方式：调用宿主的选区 API（`renderer.startSelection` / `updateSelection` / `clearSelection`），与鼠标拖选走同一套渲染路径，按真实文本行对齐。由于宿主默认不给文本节点设置 `selectionBg`，插件会显式设置 `cursorColor` / `selectionColor`（退出时还原），否则选区可能完全看不见。宿主 renderable 不属于公开 API，调用失败会降级为 toast 提示；可用 `highlight: false` 完全关闭。

## 搜索

`/` 输入关键词 → 在会话消息中全文检索 → 结果列表（摘要 + 角色 + 时间）→ 选中跳转；`n` / `N` 在结果间循环。

跳转采用「渲染树定位」：找到已渲染的消息节点，让最近的 ScrollBox 将其滚入视野。**仅对已加载进主视图窗口的消息有效**；更早的消息需先上滚 transcript 加载，再按 `n`。

## 配置

放在自动加载目录（如 `~/.config/opencode/plugins/scroll-mode/`）即生效。若需传参数，在 `opencode.json` 的 `plugins` 中显式列出：

```jsonc
{
  "plugins": [
    {
      "package": "./plugins-src/scroll-mode",
      "options": {
        "vim": true,
        "search": true,
        "maxResults": 100,
        "searchScope": "all",
        "highlight": true,
        "cursorColor": "#3d5a80",
        "selectionColor": "#2f5d9e"
      }
    }
  ]
}
```

| 选项 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `vim` | boolean | `true` | 是否启用 vim 键位 |
| `search` | boolean | `true` | 是否启用消息搜索 |
| `maxResults` | number | `100` | 搜索结果上限 |
| `searchScope` | `"all"` \| `"user"` | `"all"` | 搜索范围 |
| `highlight` | boolean | `true` | 行光标 / 选区高亮 |
| `cursorColor` | string | `"#3d5a80"` | 行光标背景色 |
| `selectionColor` | string | `"#2f5d9e"` | visual 选区背景色 |

> 提示：同一目录若既位于自动加载的 `plugins/` 下、又在 `plugins` 中显式列出，可能被加载两次。二选一。

## 结构

- `index.ts` — 服务端入口（仅注册 id）。
- `tui.ts` — TUI 入口，全部逻辑。
- `package.json` — 包元数据与 `exports`。
