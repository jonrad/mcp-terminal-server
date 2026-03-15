# Terminal App

MCP App (React + `@modelcontextprotocol/ext-apps`) that renders an xterm.js terminal inline in Claude Code/Desktop. Multi-session PTY support via `node-pty`.

## Commands

```bash
npm run build        # Build UI + server
npm run dev          # Dev mode with hot reload
npm run serve:stdio  # Run server via stdio
```

## Key Files

- `server.ts` - MCP server: terminal tools, PTY session management, cleanup
- `main.ts` - Entry point: stdio/HTTP transport, graceful shutdown
- `terminal-app.html` - HTML entry (Vite bundles to single file)
- `src/terminal-app.tsx` - React UI with xterm.js
- `vite.config.ts` - Vite config with `vite-plugin-singlefile`

## Architecture

- `terminal-show` opens UI + spawns PTY session, returns `sessionId`
- `terminal-create` adds sessions without re-rendering UI (for additional tabs)
- `terminal-write` sends input to PTY; omit data to poll output buffer (used by UI)
- `terminal-read` returns ANSI-stripped history for LLM consumption
- `terminal-customize` sets tab name/color/icon; `terminal-refresh` triggers program redraw
- UI polls `terminal-write` (no data) with adaptive timing (16ms active, 400ms idle)
- See `requirements.md` for full specification
