/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WikiDirectoryTree, buildWikiDirectory } from "./KnowledgePage";
import type { KnowledgeCollection, KnowledgeWikiDocument } from "./types";

const timestamp = "2026-08-02T00:00:00.000Z";
const collections: KnowledgeCollection[] = [{
  id: "foundation",
  displayName: "基础与架构边界",
  description: "Foundation",
  authority: "canonical",
  tags: []
}];
const entries: KnowledgeWikiDocument[] = [{
  document: {
    id: "foundation-readme-b33563055168",
    title: "README.md",
    content: "正文",
    collectionId: "foundation",
    sourceId: "foundation-source",
    metadata: { relativePath: "guides/README.md" },
    updatedAt: timestamp
  },
  outgoingReferences: [],
  backlinks: [],
  candidateRelations: []
}];

describe("WikiDirectoryTree keyboard navigation", () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("collapses, expands, moves focus and opens a document with the keyboard", () => {
    const onSelect = vi.fn();
    const nodes = buildWikiDirectory(collections, entries);
    act(() => root.render(<WikiDirectoryTree nodes={nodes} selectedId="" onSelect={onSelect} />));

    const collection = container.querySelector<HTMLButtonElement>("[role='treeitem'][aria-level='1']")!;
    expect(collection.getAttribute("aria-expanded")).toBe("true");
    expect(collection.getAttribute("aria-posinset")).toBe("1");
    expect(collection.getAttribute("aria-setsize")).toBe("1");
    expect(container.textContent).toContain("guides");
    expect(container.textContent).not.toContain("foundation-readme-b33563055168");
    expect(collection.querySelector(".glyph-collection")?.textContent).toBe("正");

    act(() => collection.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    expect(collection.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("guides");

    act(() => collection.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    act(() => collection.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    const folder = container.querySelector<HTMLButtonElement>("[role='treeitem'][aria-level='2']")!;
    expect(document.activeElement).toBe(folder);
    expect(folder.querySelector(".glyph-folder")).not.toBeNull();
    expect(folder.querySelectorAll(".wiki-directory-guides i")).toHaveLength(1);

    act(() => folder.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    act(() => folder.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    const documentRow = container.querySelector<HTMLButtonElement>("[role='treeitem'][aria-level='3']")!;
    expect(document.activeElement).toBe(documentRow);
    expect(documentRow.querySelector(".glyph-synced")).not.toBeNull();
    expect(documentRow.querySelectorAll(".wiki-directory-guides i")).toHaveLength(2);

    act(() => documentRow.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(onSelect).toHaveBeenCalledWith("foundation-readme-b33563055168");
  });

  it("automatically exposes the selected document path", () => {
    const nodes = buildWikiDirectory(collections, entries);
    act(() => root.render(<WikiDirectoryTree nodes={nodes} selectedId="foundation-readme-b33563055168" onSelect={vi.fn()} />));

    const documentRow = container.querySelector<HTMLButtonElement>("[role='treeitem'][aria-level='3']");
    expect(documentRow?.getAttribute("aria-selected")).toBe("true");
    expect(documentRow?.textContent).toContain("README.md");
  });
});
