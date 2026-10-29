# opencode-scroll-mode

OpenCode TUI 的「对话滚动模式」插件：一键切换编辑 / 滚动两种状态，滚动时支持 vim 键位与消息搜索。

## 功能

- `ctrl+q` 在「编辑模式」与「滚动模式」之间切换。
  - 编辑模式：输入框保留原生 readline 键位。
  - 滚动模式：导航键位滚动 transcript，并启用 vim 键位与搜索。
  - 滚动模式会**锁定输入框**：进入时让编辑器失焦，并全局吞掉按键，避免滚动时误把字符打进 prompt；退出时恢复焦点与输入。对话框（搜索、选择等）获得焦点时自动放行。
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
| `q` | 退出滚动模式 |

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
        "searchScope": "all"
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

> 提示：同一目录若既位于自动加载的 `plugins/` 下、又在 `plugins` 中显式列出，可能被加载两次。二选一。

## 结构

- `index.ts` — 服务端入口（仅注册 id）。
- `tui.ts` — TUI 入口，全部逻辑。
- `package.json` — 包元数据与 `exports`。
