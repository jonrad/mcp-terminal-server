# Terminal MCP App

An MCP App that renders an interactive xterm.js terminal inline in Claude Code and Claude Desktop. Multi-session PTY support via `node-pty` with tabbed UI.

## MCP Client Configuration

Add to your MCP client configuration (stdio transport):

```json
{
  "mcpServers": {
    "terminal": {
      "command": "npx",
      "args": [
        "-y",
        "--silent",
        "github:jonrad/mcp-terminal-server",
        "--stdio"
      ]
    }
  }
}
```

## Features

- **Inline Terminal**: xterm.js terminal emulator with full xterm-256color support
- **Multi-Session Tabs**: Create, switch, close, and customize terminal sessions
- **Tab Customization**: Set names, colors, and icons per tab via LLM tools
- **Fullscreen Toggle**: Switch between inline and fullscreen display modes
- **LLM-Readable History**: `terminal-read` returns ANSI-stripped output for LLM consumption
- **Graceful Cleanup**: All PTY sessions killed on server shutdown

## Tools

- **`terminal-show`** — Opens the terminal UI and spawns one or more sessions. Accepts optional `tabs` array (each with `command`, `cwd`, `name`, `color`, `icon`), `height`, and `width`. Defaults to one bash tab.
- **`terminal-create`** — Spawns additional sessions without re-rendering UI. Same `tabs` options as `terminal-show`.
- **`terminal-list`** (App-only) — Lists all sessions with IDs, labels, titles, and style.
- **`terminal-write`** (App-only) — Writes data to a PTY session. Omit data to poll the output buffer.
- **`terminal-read`** — Returns ANSI-stripped terminal history (last 10k chars). Non-destructive.
- **`terminal-resize`** (App-only) — Resizes PTY to match UI dimensions.
- **`terminal-refresh`** (App-only) — Sends SIGWINCH to force running programs to redraw.
- **`terminal-close`** (App-only) — Kills a PTY session and removes it.
- **`terminal-customize`** — Sets name, color, and/or icon on a tab.

## License

MIT
