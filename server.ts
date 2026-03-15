import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import crypto from "node:crypto";
import { accessSync, constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as pty from "node-pty";
import stripAnsi from "strip-ansi";
import { z } from "zod";

// Works both from source (server.ts) and compiled (dist/server.js)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST_DIR = __filename.endsWith(".ts")
  ? path.join(__dirname, "dist")
  : __dirname;

const MAX_HISTORY = 100_000;
const MAX_OUTPUT_BUFFER = 100_000;

/** Append data to a buffer string, trimming to half of maxLen when exceeded. */
function appendWithLimit(buffer: string, data: string, maxLen: number): string {
  const result = buffer + data;
  return result.length > maxLen ? result.slice(-maxLen / 2) : result;
}

interface TabStyle {
  name: string;   // custom display name, overrides dynamic title
  color: string;  // tab background color (CSS color string)
  icon: string;   // emoji/icon prefix shown before tab name
}

interface TerminalSession {
  process: pty.IPty;
  outputBuffer: string;
  history: string;
  label: string;
  title: string;
  style: TabStyle;
}

const sessions = new Map<string, TerminalSession>();
let pendingFocus: string | null = null;

function withSession(sessionId: string, fn: (session: TerminalSession) => CallToolResult): CallToolResult {
  const session = sessions.get(sessionId);
  if (!session) return { content: [{ type: "text", text: "No such session" }], isError: true };
  return fn(session);
}

// Regex to match OSC title sequences: \x1b]0;...\x07 and \x1b]2;...\x07
// Supports both BEL (\x07) and ST (\x1b\) terminators
const OSC_TITLE_RE = /\x1b\](?:0|2);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

interface SpawnResult {
  sessionId: string;
  label: string;
}

function findShell(): string {
  const candidates = [
    process.env.SHELL,
    "/bin/zsh",
    "/bin/bash",
    "/bin/sh",
  ];
  for (const sh of candidates) {
    if (!sh) continue;
    try { accessSync(sh, constants.X_OK); return sh; } catch {}
  }
  return "/bin/sh";
}

function spawnTerminal(command?: string, style?: Partial<TabStyle>, cwd?: string): SpawnResult {
  const sessionId = crypto.randomUUID();
  const shell = findShell();
  const label = command || path.basename(shell);

  let resolvedCwd = cwd || process.env.HOME || process.cwd();
  try { accessSync(resolvedCwd, constants.R_OK); } catch { resolvedCwd = process.cwd(); }

  const proc = pty.spawn(shell, command ? ["-lic", command] : ["-li"], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: resolvedCwd,
    env: Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
  });

  const session: TerminalSession = {
    process: proc,
    outputBuffer: "",
    history: "",
    label,
    title: "",
    style: { name: style?.name ?? "", color: style?.color ?? "", icon: style?.icon ?? "" },
  };

  proc.onData((data: string) => {
    session.outputBuffer = appendWithLimit(session.outputBuffer, data, MAX_OUTPUT_BUFFER);
    session.history = appendWithLimit(session.history, data, MAX_HISTORY);

    for (const match of data.matchAll(OSC_TITLE_RE)) {
      session.title = match[1];
    }
  });

  proc.onExit(() => {
    sessions.delete(sessionId);
  });

  sessions.set(sessionId, session);
  return { sessionId, label };
}

interface TabConfig {
  command?: string;
  cwd?: string;
  name?: string;
  color?: string;
  icon?: string;
}

function spawnTabs(tabs?: Array<TabConfig>): SpawnResult[] {
  return (tabs?.length ? tabs : [{}]).map((c) =>
    spawnTerminal(c.command, { name: c.name, color: c.color, icon: c.icon }, c.cwd),
  );
}

/** Kill all active PTY sessions. Call on server shutdown. */
export function cleanup(): void {
  for (const [, session] of sessions) {
    try { session.process.kill(); } catch {}
  }
  sessions.clear();
}

/**
 * Creates a new MCP server instance with tools and resources registered.
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: "Terminal App",
    version: "1.0.0",
  });

  const terminalResourceUri = "ui://terminal-show/terminal-app.html";

  const tabConfigSchema = z.object({
    command: z.string().optional().describe("Command to run (e.g. 'claude', 'htop'). If omitted, opens bash."),
    cwd: z.string().optional().describe("Working directory for the terminal session. Defaults to $HOME."),
    name: z.string().optional().describe("Custom tab name."),
    color: z.string().optional().describe("Tab background color (CSS color)."),
    icon: z.string().optional().describe("Emoji/icon for the tab."),
  });

  registerAppTool(server,
    "terminal-show",
    {
      title: "Show Terminal",
      description: "Opens the terminal UI and starts one or more sessions. Only call this ONCE to open the terminal. To create additional sessions (tabs) after the terminal is already open, use the terminal-create tool instead — calling terminal-show again will duplicate the UI. Defaults to one bash tab if tabs is omitted.",
      inputSchema: {
        tabs: z.array(tabConfigSchema).optional().describe("Terminal tabs to open. Each entry spawns a session. Defaults to one bash tab if omitted."),
        height: z.number().optional().describe("Display height in pixels (default 500)."),
        width: z.number().optional().describe("Display width in pixels (default: full width)."),
      },
      _meta: { ui: { resourceUri: terminalResourceUri } },
    },
    async ({ tabs, height, width }: { tabs?: Array<TabConfig>; height?: number; width?: number }): Promise<CallToolResult> => {
      const results = spawnTabs(tabs);
      return { content: [{ type: "text", text: JSON.stringify({ sessions: results, height, width }) }] };
    },
  );

  // Writes data to the PTY. When data is omitted, drains and returns the output
  // buffer (used by the UI to poll for new output).
  server.tool(
    "terminal-write",
    "Writes input to a terminal session. To press Enter, include a real newline character in the data value (not a literal backslash-n). Real newlines are converted to \\r (carriage return) for PTY compatibility. Omit data to poll for new output (returns buffered output). Use terminal-read to see full terminal history.",
    {
      sessionId: z.string(),
      data: z.string().optional().describe("Data to write. Omit to poll for new output."),
    },
    async ({ sessionId, data }): Promise<CallToolResult> => {
      return withSession(sessionId, (session) => {
        if (data) {
          // In a PTY, Enter is \r (0x0D), not \n (0x0A).
          // LLMs naturally produce \n, so convert for correct behavior.
          try {
            session.process.write(data.replace(/\n/g, "\r"));
          } catch {
            return { content: [{ type: "text", text: "Session process has exited" }], isError: true };
          }
          pendingFocus = sessionId;
          return { content: [{ type: "text", text: "" }] };
        }
        // Read-only: drain output buffer (used by UI polling)
        const out = session.outputBuffer;
        session.outputBuffer = "";
        return { content: [{ type: "text", text: out }] };
      });
    },
  );

  server.tool(
    "terminal-read",
    "Returns recent terminal output (ANSI-stripped). Use this to read what's on screen.",
    { sessionId: z.string() },
    async ({ sessionId }): Promise<CallToolResult> => {
      return withSession(sessionId, (session) => {
        pendingFocus = sessionId;
        const clean = stripAnsi(session.history);
        return { content: [{ type: "text", text: clean.slice(-10_000) }] };
      });
    },
  );

  server.tool(
    "terminal-create",
    "Creates one or more terminal tabs/sessions. Use this instead of terminal-show when the terminal UI is already open. New sessions appear as tabs automatically. Defaults to one bash tab if tabs is omitted.",
    {
      tabs: z.array(tabConfigSchema).optional().describe("Terminal tabs to create. Each entry spawns a session. Defaults to one bash tab if omitted."),
    },
    async ({ tabs }): Promise<CallToolResult> => {
      const results = spawnTabs(tabs);
      pendingFocus = results[0]?.sessionId ?? null;
      return {
        content: [{ type: "text", text: JSON.stringify({ sessions: results }) }],
      };
    },
  );

  server.tool(
    "terminal-list",
    "Lists all active terminal sessions with their IDs, labels, and titles.",
    {},
    async (): Promise<CallToolResult> => {
      const list = Array.from(sessions.entries()).map(([id, s]) => ({
        sessionId: id,
        label: s.label,
        title: s.title,
        style: s.style,
      }));
      // Return pendingFocus but let clients decide whether to consume it.
      // The value is cleared here since terminal-list is the only consumer.
      const focus = pendingFocus;
      if (focus) pendingFocus = null;
      return { content: [{ type: "text", text: JSON.stringify({ sessions: list, pendingFocus: focus }) }] };
    },
  );

  server.tool(
    "terminal-customize",
    "Customize a terminal tab's appearance. All fields are optional — only provided fields are updated.",
    {
      sessionId: z.string(),
      name: z.string().optional().describe("Custom display name (overrides dynamic title). Pass empty string to clear."),
      color: z.string().optional().describe("Tab background color as CSS color (e.g. '#e06c75', 'red', 'rgb(50,150,80)'). Pass empty string to reset to default."),
      icon: z.string().optional().describe("Emoji or short string shown before the tab name (e.g. '🐍', '🔧', '⚡'). Pass empty string to clear."),
    },
    async ({ sessionId, name, color, icon }): Promise<CallToolResult> => {
      return withSession(sessionId, (session) => {
        if (name !== undefined) session.style.name = name;
        if (color !== undefined) session.style.color = color;
        if (icon !== undefined) session.style.icon = icon;
        return { content: [{ type: "text", text: `Updated: ${JSON.stringify(session.style)}` }] };
      });
    },
  );

  server.tool(
    "terminal-refresh",
    "Triggers a redraw of the running program by sending SIGWINCH (resize signal) to the PTY.",
    { sessionId: z.string() },
    async ({ sessionId }): Promise<CallToolResult> => {
      return withSession(sessionId, (session) => {
        // Toggle dimensions to trigger SIGWINCH, causing the program to redraw
        const { cols, rows } = session.process;
        const safeCol = Math.max(2, cols);
        session.process.resize(safeCol - 1, rows);
        session.process.resize(safeCol, rows);
        return { content: [{ type: "text", text: "" }] };
      });
    },
  );

  server.tool(
    "terminal-resize",
    "Resizes the PTY to match the UI terminal dimensions.",
    {
      sessionId: z.string(),
      cols: z.number(),
      rows: z.number(),
    },
    async ({ sessionId, cols, rows }): Promise<CallToolResult> => {
      return withSession(sessionId, (session) => {
        const clampedCols = Math.max(2, Math.min(cols, 500));
        const clampedRows = Math.max(1, Math.min(rows, 200));
        session.process.resize(clampedCols, clampedRows);
        return { content: [{ type: "text", text: "" }] };
      });
    },
  );

  server.tool(
    "terminal-close",
    "Closes a terminal session and kills the PTY process.",
    { sessionId: z.string() },
    async ({ sessionId }): Promise<CallToolResult> => {
      return withSession(sessionId, (session) => {
        try { session.process.kill(); } catch {}
        sessions.delete(sessionId);
        return { content: [{ type: "text", text: "Session closed" }] };
      });
    },
  );

  registerAppResource(server,
    terminalResourceUri,
    terminalResourceUri,
    { mimeType: RESOURCE_MIME_TYPE },
    async (): Promise<ReadResourceResult> => {
      const html = await fs.readFile(path.join(DIST_DIR, "terminal-app.html"), "utf-8");
      return {
        contents: [{ uri: terminalResourceUri, mimeType: RESOURCE_MIME_TYPE, text: html }],
      };
    },
  );

  return server;
}
