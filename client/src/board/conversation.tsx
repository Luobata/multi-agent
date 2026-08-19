import { Fragment, type ReactNode } from "react";
import type { InvocationStartReceipt } from "../api";

/**
 * Provider JSON occasionally contains a second, literal escaping layer. Decode only
 * line-break escapes here; React renders every resulting fragment as an escaped text
 * node, so message content can never introduce executable HTML.
 */
export function normalizeConversationLineBreaks(content: string): string {
  return content.replace(/\\r\\n|\\n|\\r/g, "\n");
}

function inlineMarkdown(text: string): ReactNode[] {
  return text.split(/(\*\*[^*\n]+\*\*)/g).filter(Boolean).map((part, index) =>
    part.startsWith("**") && part.endsWith("**")
      ? <strong key={index}>{part.slice(2, -2)}</strong>
      : <Fragment key={index}>{part}</Fragment>
  );
}

export function ConversationMessageContent({ content }: { content: string }) {
  const lines = normalizeConversationLineBreaks(content).split("\n");
  const blocks: ReactNode[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    const unordered = /^\s*[-*+]\s+(.+)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (unordered || ordered) {
      const orderedList = Boolean(ordered);
      const items: ReactNode[] = [];
      while (index < lines.length) {
        const match = orderedList
          ? /^\s*\d+[.)]\s+(.+)$/.exec(lines[index]!)
          : /^\s*[-*+]\s+(.+)$/.exec(lines[index]!);
        if (!match) break;
        items.push(<li key={index}>{inlineMarkdown(match[1]!)}</li>);
        index += 1;
      }
      blocks.push(orderedList ? <ol key={`list-${index}`}>{items}</ol> : <ul key={`list-${index}`}>{items}</ul>);
      continue;
    }
    if (!line.trim()) {
      blocks.push(<div className="board-ai-message-spacer" aria-hidden="true" key={`blank-${index}`} />);
    } else {
      blocks.push(<p key={`paragraph-${index}`}>{inlineMarkdown(line)}</p>);
    }
    index += 1;
  }
  return <div className="board-ai-message-content">{blocks}</div>;
}

export interface AgentPendingTurn {
  receipt: InvocationStartReceipt;
  message: string;
  startedAt: number;
  cursor: string;
  phase: "waiting" | "cancelling" | "interrupted";
  /** False once the monitor loop has died (interrupted); remount sets it back. */
  monitorLive: boolean;
  lastReason?: "changed" | "heartbeat";
  lastUpdateAt?: string;
  lastStatus?: string;
  lastPhase?: string;
  error?: string;
}

export function formatAgentElapsedMs(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
