/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { EffectiveProfileView } from "./EffectiveProfileView";
import type { EffectiveExecutionProfile } from "./types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const profile: EffectiveExecutionProfile = {
  schemaVersion: 1,
  compiledAt: "2026-08-04T00:00:00.000Z",
  runId: "run-example",
  nodeId: "respond",
  employee: { id: "coder", version: 3, displayName: "Coder" },
  fields: [{
    key: "instructions",
    label: "执行指令",
    mergeRule: "Employee 为基础。",
    value: { systemPrompt: "effective" },
    contributions: [{ referenceId: "employee:coder:v3", scope: "employee", action: "base", path: "systemPrompt" }]
  }],
  references: [{
    refId: "employee:coder:v3",
    kind: "employee",
    id: "coder",
    version: 3,
    label: "Coder · Employee v3",
    route: { page: "employees", entityId: "coder" },
    snapshot: { systemPrompt: "FULL_VERSIONED_CONTENT" }
  }]
};

describe("EffectiveProfileView", () => {
  it("lets a version reference expand to its full snapshot and offers a registry jump", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => { root.render(<EffectiveProfileView profile={profile} />); });

    const source = container.querySelector<HTMLDetailsElement>(".effective-source");
    const sourceSummary = source?.querySelector("summary");
    expect(source?.open).toBe(false);
    await act(async () => { sourceSummary?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(source?.open).toBe(true);
    expect(source?.textContent).toContain("FULL_VERSIONED_CONTENT");
    expect(container.querySelector<HTMLAnchorElement>("a.effective-source-link")?.getAttribute("href")).toBe("#employees");

    await act(async () => { root.unmount(); });
    container.remove();
  });
});
