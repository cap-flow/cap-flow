/**
 * Error boundary специально для V3 cost basis override.
 *
 * Если wire-up Alchemy `IncreaseLiquidity` events ломает рендер
 * OpenPositionsPage, этот boundary:
 *   1. Catch'ит ошибку через `componentDidCatch`
 *   2. Записывает full stack в `window.__v3OverrideError` для inspect
 *   3. Логирует в console.error с component stack
 *   4. Показывает inline message с error.message + кнопкой Reset
 *   5. Главное: НЕ рушит весь page — children re-render возможен
 */

import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  componentStack: string | null;
}

export class V3OverrideErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, componentStack: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, componentStack: null };
  }

  componentDidCatch(error: Error, info: { componentStack: string }): void {
    console.error("=== V3OverrideErrorBoundary caught ===");
    console.error("Error message:", error.message);
    console.error("Error name:", error.name);
    console.error("Error stack:", error.stack);
    console.error("Component stack:", info.componentStack);
    console.error("=== End boundary trace ===");

    // Save in window для inspection из browser console:
    //   > window.__v3OverrideError
    if (typeof window !== "undefined") {
      (window as unknown as { __v3OverrideError: unknown }).__v3OverrideError = {
        message: error.message,
        name: error.name,
        stack: error.stack,
        componentStack: info.componentStack,
        timestamp: new Date().toISOString(),
      };
    }
    this.setState({ componentStack: info.componentStack });
  }

  reset = (): void => {
    this.setState({ hasError: false, error: null, componentStack: null });
  };

  override render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            padding: 24,
            margin: 24,
            border: "2px solid #f87171",
            borderRadius: 8,
            background: "rgba(239, 68, 68, 0.05)",
            fontFamily: "monospace",
            fontSize: 12,
            color: "#fca5a5",
          }}
        >
          <div style={{ fontSize: 14, fontWeight: "bold", marginBottom: 8 }}>
            🐛 V3 Override Error Boundary triggered
          </div>
          <div style={{ marginBottom: 8 }}>
            <strong>Message:</strong> {this.state.error?.message ?? "(unknown)"}
          </div>
          <div style={{ marginBottom: 8 }}>
            <strong>Name:</strong> {this.state.error?.name ?? "(unknown)"}
          </div>
          <details style={{ marginBottom: 8 }}>
            <summary style={{ cursor: "pointer" }}>Stack trace</summary>
            <pre
              style={{
                whiteSpace: "pre-wrap",
                marginTop: 4,
                fontSize: 10,
                lineHeight: 1.4,
              }}
            >
              {this.state.error?.stack ?? "(no stack)"}
            </pre>
          </details>
          {this.state.componentStack && (
            <details style={{ marginBottom: 8 }}>
              <summary style={{ cursor: "pointer" }}>Component stack</summary>
              <pre
                style={{
                  whiteSpace: "pre-wrap",
                  marginTop: 4,
                  fontSize: 10,
                  lineHeight: 1.4,
                }}
              >
                {this.state.componentStack}
              </pre>
            </details>
          )}
          <div style={{ fontSize: 11, marginTop: 8, color: "#fbbf24" }}>
            Стек тоже сохранён в <code>window.__v3OverrideError</code> для
            inspect.
          </div>
          <button
            type="button"
            onClick={this.reset}
            style={{
              marginTop: 12,
              padding: "6px 14px",
              background: "#ef4444",
              color: "white",
              border: "none",
              borderRadius: 4,
              cursor: "pointer",
            }}
          >
            Reset boundary (re-render children)
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
