import type { App } from "@modelcontextprotocol/ext-apps";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

interface TabStyle {
  // Must match server.ts TabStyle
  name: string;
  color: string;
  icon: string;
}

const DEFAULT_STYLE: TabStyle = { name: "", color: "", icon: "" };

// Shared map so TerminalApp can reset a specific pane's xterm instance
const terminalInstances = new Map<string, Terminal>();

interface TabState {
  sessionId: string;
  label: string;
  title: string;
  style: TabStyle;
}

function extractToolText(result: unknown): string {
  return ((result as any)?.content as Array<{ type: string; text: string }>)
    ?.find((c) => c.type === "text")?.text ?? "";
}

function TerminalApp() {
  const [tabs, setTabs] = useState<TabState[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [followMode, setFollowMode] = useState(true);
  const followModeRef = useRef(true);
  const [displayHeight, setDisplayHeight] = useState<number>(500);
  const [displayWidth, setDisplayWidth] = useState<number | null>(null);

  const { app, error } = useApp({
    appInfo: { name: "Terminal", version: "1.0.0" },
    capabilities: {},
    onAppCreated: (app) => {
      app.onerror = console.error;
      app.onteardown = async () => ({});
      app.ontoolresult = async (result) => {
        const text = extractToolText(result);
        if (!text) return;

        let parsed: { sessions?: Array<{ sessionId: string; label: string }>; height?: number; width?: number };
        try { parsed = JSON.parse(text); } catch { return; }

        if (parsed.height) setDisplayHeight(parsed.height);
        if (parsed.width) setDisplayWidth(parsed.width);

        const newSessions = parsed.sessions;
        if (!newSessions?.length) return;

        setTabs((prev) => {
          let updated = [...prev];
          for (const s of newSessions) {
            if (!updated.some((t) => t.sessionId === s.sessionId)) {
              updated.push({ sessionId: s.sessionId, label: s.label, title: "", style: { ...DEFAULT_STYLE } });
            }
          }
          return updated;
        });
        // Always activate if no current tab (initial open), otherwise respect follow mode
        setActiveTab((current) => {
          if (!current || followModeRef.current) return newSessions[0].sessionId;
          return current;
        });
      };
    },
  });

  // Sync tabs with server sessions (immediate on mount + periodic poll)
  useEffect(() => {
    if (!app) return;

    const syncSessions = async () => {
      try {
        const result = await app.callServerTool({
          name: "terminal-list",
          arguments: {},
        });
        const text = extractToolText(result);
        if (!text) return;
        const listData: {
          sessions: Array<{ sessionId: string; label: string; title: string; style: TabStyle }>;
          pendingFocus: string | null;
        } = JSON.parse(text);
        const serverSessions = listData.sessions;

        setTabs((prev) => {
          const serverById = new Map(serverSessions.map((s) => [s.sessionId, s]));
          // Keep existing tabs that still exist on server, updating title/style
          const updated = prev
            .filter((t) => serverById.has(t.sessionId))
            .map((t) => {
              const s = serverById.get(t.sessionId)!;
              serverById.delete(t.sessionId);
              const styleChanged = s.style.name !== t.style.name
                || s.style.color !== t.style.color
                || s.style.icon !== t.style.icon;
              return (s.title !== t.title || styleChanged) ? { ...t, title: s.title, style: s.style } : t;
            });
          // Add new sessions not yet in tabs
          for (const [, s] of serverById) {
            updated.push({ sessionId: s.sessionId, label: s.label, title: s.title, style: s.style });
          }
          return updated;
        });

        // Follow mode: switch to the tab the AI last wrote to or created
        if (listData.pendingFocus && followModeRef.current) {
          setActiveTab(listData.pendingFocus);
        } else {
          // If active tab was removed, switch to first available
          setActiveTab((current) => {
            const serverIds = new Set(serverSessions.map((s) => s.sessionId));
            if (current && !serverIds.has(current)) {
              return serverSessions.length > 0 ? serverSessions[0].sessionId : null;
            }
            return current;
          });
        }
      } catch {
        // ignore polling errors
      }
    };

    // Immediate sync on mount to pick up existing sessions after re-render
    syncSessions();
    const interval = setInterval(syncSessions, 2000);
    return () => clearInterval(interval);
  }, [app]);

  const handleNewTab = useCallback(async () => {
    if (!app) return;
    try {
      const result = await app.callServerTool({
        name: "terminal-create",
        arguments: {},
      });
      const text = extractToolText(result);
      if (!text) return;
      const { sessions } = JSON.parse(text) as { sessions: Array<{ sessionId: string; label: string }> };
      const s = sessions[0];
      if (!s) return;
      setTabs((prev) => [...prev, { sessionId: s.sessionId, label: s.label, title: "", style: { ...DEFAULT_STYLE } }]);
      setActiveTab(s.sessionId);
    } catch (e) {
      console.error("Failed to create tab", e);
    }
  }, [app]);

  const handleCloseTab = useCallback(
    async (sessionId: string) => {
      if (!app) return;
      try {
        await app.callServerTool({
          name: "terminal-close",
          arguments: { sessionId },
        });
      } catch (e) {
        console.warn("close error:", e);
      }
      setTabs((prev) => {
        const next = prev.filter((t) => t.sessionId !== sessionId);
        setActiveTab((currentActive) => {
          if (currentActive !== sessionId) return currentActive;
          const oldIdx = prev.findIndex((t) => t.sessionId === sessionId);
          const newIdx = Math.min(oldIdx, next.length - 1);
          return next[newIdx]?.sessionId ?? null;
        });
        return next;
      });
    },
    [app],
  );

  const toggleFullscreen = useCallback(() => {
    if (!app) return;
    const next = !isFullscreen;
    setIsFullscreen(next);
    app.requestDisplayMode({ mode: next ? "fullscreen" : "inline" });
    // Double-rAF gives the host more time to settle layout before re-fitting
    requestAnimationFrame(() => requestAnimationFrame(() => window.dispatchEvent(new Event("resize"))));
  }, [app, isFullscreen]);

  const handleReset = useCallback(async () => {
    if (!activeTab || !app) return;
    await app.callServerTool({
      name: "terminal-refresh",
      arguments: { sessionId: activeTab },
    });
  }, [activeTab, app]);

  const toggleFollowMode = useCallback(() => {
    setFollowMode((prev) => {
      followModeRef.current = !prev;
      return !prev;
    });
  }, []);

  if (error) return <div style={{ color: "#f44", padding: 16 }}>Error: {error.message}</div>;
  if (!app) return <div style={{ color: "#888", padding: 16 }}>Connecting...</div>;
  if (tabs.length === 0)
    return <div style={{ color: "#888", padding: 16 }}>Starting terminal...</div>;

  const height = isFullscreen ? "100vh" : displayHeight;
  const width = isFullscreen ? "100vw" : displayWidth ?? "100%";

  return (
    <div style={{ width, height, display: "flex", flexDirection: "column" }}>
      <TabBar
        tabs={tabs}
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        onCloseTab={handleCloseTab}
        onNewTab={handleNewTab}
        onReset={handleReset}
        followMode={followMode}
        onToggleFollowMode={toggleFollowMode}
        isFullscreen={isFullscreen}
        onToggleFullscreen={toggleFullscreen}
      />
      <div style={{ flex: 1, position: "relative" }}>
        {tabs.map((tab) => (
          <TerminalPane
            key={tab.sessionId}
            app={app}
            sessionId={tab.sessionId}
            visible={tab.sessionId === activeTab}
          />
        ))}
      </div>
    </div>
  );
}

function TabBar({
  tabs,
  activeTab,
  onSelectTab,
  onCloseTab,
  onNewTab,
  onReset,
  followMode,
  onToggleFollowMode,
  isFullscreen,
  onToggleFullscreen,
}: {
  tabs: TabState[];
  activeTab: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTab: () => void;
  onReset: () => void;
  followMode: boolean;
  onToggleFollowMode: () => void;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        background: "#252526",
        height: 30,
        flexShrink: 0,
        borderBottom: "1px solid #191919",
        overflow: "hidden",
      }}
    >
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {tabs.map((tab) => {
          const isActive = tab.sessionId === activeTab;
          const displayName = tab.style.name || tab.title || tab.label;
          const hasCustomColor = !!tab.style.color;
          const defaultBg = isActive ? "#1e1e1e" : "transparent";
          const tabBg = hasCustomColor
            ? tab.style.color
            : defaultBg;
          const tabColor = hasCustomColor
            ? "#fff"
            : isActive ? "#d4d4d4" : "#888";
          return (
            <div
              key={tab.sessionId}
              onClick={() => onSelectTab(tab.sessionId)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "0 10px",
                height: 30,
                cursor: "pointer",
                background: tabBg,
                opacity: hasCustomColor && !isActive ? 0.7 : 1,
                borderRight: "1px solid #191919",
                borderBottom: isActive ? "4px solid #007acc" : "4px solid transparent",
                color: tabColor,
                fontSize: 12,
                fontFamily: "'Menlo', 'DejaVu Sans Mono', 'Courier New', monospace",
                whiteSpace: "nowrap",
                maxWidth: 200,
                userSelect: "none",
              }}
            >
              {tab.style.icon && (
                <span style={{ fontSize: 13, flexShrink: 0 }}>{tab.style.icon}</span>
              )}
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {displayName}
              </span>
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(tab.sessionId);
                }}
                title="Close tab"
                style={{
                  marginLeft: 4,
                  cursor: "pointer",
                  opacity: 0.6,
                  fontSize: 14,
                  lineHeight: "14px",
                }}
                onMouseEnter={(e) => ((e.target as HTMLElement).style.opacity = "1")}
                onMouseLeave={(e) => ((e.target as HTMLElement).style.opacity = "0.6")}
              >
                ×
              </span>
            </div>
          );
        })}
      </div>
      <ToolbarButton onClick={onNewTab} title="New terminal">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <line x1="8" y1="3" x2="8" y2="13" />
          <line x1="3" y1="8" x2="13" y2="8" />
        </svg>
      </ToolbarButton>
      <ToolbarButton onClick={onReset} title="Refresh terminal">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M13 8a5 5 0 1 1-1.5-3.5M13 3v3h-3" />
        </svg>
      </ToolbarButton>
      <ToolbarButton onClick={onToggleFollowMode} title={followMode ? "Follow mode (on)" : "Follow mode (off)"} style={{ color: followMode ? "#d4d4d4" : undefined }}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <circle cx="8" cy="8" r="6" />
          <circle cx="8" cy="8" r="2" fill={followMode ? "currentColor" : "none"} />
        </svg>
      </ToolbarButton>
      <ToolbarButton onClick={onToggleFullscreen} title={isFullscreen ? "Exit fullscreen" : "Fullscreen"} style={{ marginRight: 6 }}>
        {isFullscreen ? (
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <polyline points="6,2 6,6 2,6" />
            <polyline points="10,14 10,10 14,10" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <polyline points="2,6 2,2 6,2" />
            <polyline points="14,10 14,14 10,14" />
          </svg>
        )}
      </ToolbarButton>
    </div>
  );
}

function ToolbarButton({ onClick, title, style, children }: {
  onClick: () => void;
  title: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "transparent",
        color: "#888",
        border: "none",
        cursor: "pointer",
        padding: "0 6px",
        height: 30,
        flexShrink: 0,
        ...style,
      }}
      onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = "#d4d4d4")}
      onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = "#888")}
    >
      {children}
    </button>
  );
}

function TerminalPane({
  app,
  sessionId,
  visible,
}: {
  app: App;
  sessionId: string;
  visible: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const openedRef = useRef(false);

  // Create xterm instance once on mount (but don't open it yet)
  useEffect(() => {
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'Menlo', 'DejaVu Sans Mono', 'Courier New', monospace",
      theme: {
        background: "#1e1e1e",
        foreground: "#d4d4d4",
        cursor: "#d4d4d4",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    terminalInstances.set(sessionId, terminal);

    // --- Poll: drain output buffer and write to xterm ---
    // Returns true if data was received, false if empty, null on error
    const poll_read = async (): Promise<boolean | null> => {
      try {
        const result = await app.callServerTool({
          name: "terminal-write",
          arguments: { sessionId },
        });
        const text = extractToolText(result);
        if (text) {
          terminal.write(text);
          return true;
        }
      } catch (e) {
        console.warn("poll error:", e);
        return null;
      }
      return false;
    };

    // --- Batched writes: coalesce keystrokes, fire-and-forget ---
    let writeBuf = "";
    let flushScheduled = false;
    let writeInFlight = false;

    const flushWrite = async () => {
      flushScheduled = false;
      if (!writeBuf || writeInFlight) return;
      const batch = writeBuf;
      writeBuf = "";
      writeInFlight = true;
      try {
        await app.callServerTool({
          name: "terminal-write",
          arguments: { sessionId, data: batch },
        });
      } catch (e) {
        console.warn("write error:", e);
      }
      writeInFlight = false;
      if (writeBuf) flushWrite();
    };

    let resizeTimer: ReturnType<typeof setTimeout>;
    terminal.onResize(({ cols, rows }) => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        app.callServerTool({
          name: "terminal-resize",
          arguments: { sessionId, cols, rows },
        }).catch(() => {});
      }, 50);
    });

    terminal.onData((data) => {
      writeBuf += data;
      if (!flushScheduled && !writeInFlight) {
        flushScheduled = true;
        queueMicrotask(flushWrite);
      }
    });

    const handleResize = () => {
      if (!openedRef.current) return;
      fitAddon.fit();
    };
    window.addEventListener("resize", handleResize);

    // --- Background poll for async output ---
    const POLL_ACTIVE = 16;
    const POLL_IDLE = 400;
    let timeoutId: ReturnType<typeof setTimeout>;
    let consecutiveErrors = 0;
    const poll = async () => {
      const hadData = await poll_read();
      if (hadData === null) {
        if (++consecutiveErrors >= 5) return; // stop polling for dead sessions
      } else {
        consecutiveErrors = 0;
      }
      timeoutId = setTimeout(poll, hadData ? POLL_ACTIVE : POLL_IDLE);
    };
    poll();

    return () => {
      clearTimeout(timeoutId);
      clearTimeout(resizeTimer);
      window.removeEventListener("resize", handleResize);
      terminalInstances.delete(sessionId);
      terminal.dispose();
    };
  }, [app, sessionId]);

  // Open xterm into DOM only when visible (so fitAddon can measure correctly)
  useEffect(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!visible || !terminal || !containerRef.current) return;

    if (!openedRef.current) {
      openedRef.current = true;
      terminal.open(containerRef.current);
    }

    // Always re-fit when becoming visible (handles tab switches + initial open)
    requestAnimationFrame(() => {
      fitAddon?.fit();
    });
  }, [visible]);

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height: "100%",
        position: "absolute",
        top: 0,
        left: 0,
        display: visible ? "block" : "none",
      }}
    />
  );
}

createRoot(document.getElementById("root")!).render(<TerminalApp />);
