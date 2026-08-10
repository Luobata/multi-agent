/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConversationComposer,
  ConversationMessageEvidence,
  MAX_COMPOSER_IMAGE_BYTES,
  detectLarkDocumentLinks,
  type ComposerDraft
} from "./ConversationComposer";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** FileReader 加载是异步任务，多等几个宏任务确保附件落进状态。 */
async function settle() {
  for (let index = 0; index < 10; index += 1) await flush();
}

function imageFile(name: string, bytes: number, type = "image/png"): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

function typeText(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function pasteFiles(textarea: HTMLTextAreaElement, files: File[]) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { files } });
  textarea.dispatchEvent(event);
}

describe("ConversationComposer", () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value(this: HTMLDialogElement) { this.setAttribute("open", ""); }
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value(this: HTMLDialogElement) { this.removeAttribute("open"); }
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.replaceChildren();
    Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
    Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  });

  function render(onSend: (draft: ComposerDraft) => Promise<boolean>) {
    act(() => root.render(<ConversationComposer ariaLabel="测试消息" placeholder="写点什么" onSend={onSend} />));
    return {
      form: container.querySelector<HTMLFormElement>("form.conversation-composer")!,
      textarea: container.querySelector<HTMLTextAreaElement>("form.conversation-composer textarea")!
    };
  }

  async function submit(form: HTMLFormElement) {
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await settle();
    });
  }

  it("attaches a pasted image and sends it as base64 attachments, then clears on success", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const { form, textarea } = render(onSend);

    act(() => typeText(textarea, "请 review 这张截图"));
    await act(async () => {
      pasteFiles(textarea, [imageFile("screen.png", 256)]);
      await settle();
    });
    expect(container.querySelectorAll(".composer-attachment")).toHaveLength(1);
    expect(container.textContent).toContain("screen.png");
    expect(container.querySelector<HTMLImageElement>(".composer-attachment img")?.src).toMatch(/^data:image\/png;base64,/);

    await submit(form);

    expect(onSend).toHaveBeenCalledTimes(1);
    const draft = onSend.mock.calls[0]?.[0] as ComposerDraft;
    expect(draft.message).toBe("请 review 这张截图");
    expect(draft.attachments).toHaveLength(1);
    expect(draft.attachments[0]?.name).toBe("screen.png");
    expect(draft.attachments[0]?.mediaType).toBe("image/png");
    expect(draft.attachments[0]?.base64.length).toBeGreaterThan(0);
    // 成功清空：正文与附件都不保留
    expect(textarea.value).toBe("");
    expect(container.querySelectorAll(".composer-attachment")).toHaveLength(0);
  });

  it("keeps the message and attachments when sending fails", async () => {
    const onSend = vi.fn().mockResolvedValue(false);
    const { form, textarea } = render(onSend);

    act(() => typeText(textarea, "失败也不能丢草稿"));
    await act(async () => {
      pasteFiles(textarea, [imageFile("keep.png", 128)]);
      await settle();
    });
    await submit(form);

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(textarea.value).toBe("失败也不能丢草稿");
    expect(container.querySelectorAll(".composer-attachment")).toHaveLength(1);
  });

  it("rejects non-image files with an accessible error and no chip", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const { textarea } = render(onSend);

    await act(async () => {
      pasteFiles(textarea, [new File(["plain"], "notes.txt", { type: "text/plain" })]);
      await settle();
    });

    expect(container.querySelectorAll(".composer-attachment")).toHaveLength(0);
    const alert = container.querySelector("[role='alert']");
    expect(alert?.textContent).toContain("不是 PNG/JPEG/WebP/GIF 图片");
    expect(textarea.getAttribute("aria-invalid")).toBe("true");
    expect(textarea.getAttribute("aria-describedby")).toBe(alert?.id ?? "");
  });

  it("rejects a single image over the 8MiB limit", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const { textarea } = render(onSend);

    await act(async () => {
      pasteFiles(textarea, [imageFile("huge.png", MAX_COMPOSER_IMAGE_BYTES + 1)]);
      await settle();
    });

    expect(container.querySelectorAll(".composer-attachment")).toHaveLength(0);
    expect(container.querySelector("[role='alert']")?.textContent).toContain("超过单张 8MiB 限制");
  });

  it("caps attachments at five images per message", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const { textarea } = render(onSend);

    await act(async () => {
      pasteFiles(textarea, [1, 2, 3, 4, 5, 6].map((index) => imageFile(`p${index}.png`, 64)));
      await settle();
    });

    expect(container.querySelectorAll(".composer-attachment")).toHaveLength(5);
    expect(container.querySelector("[role='alert']")?.textContent).toContain("最多附带 5 张图片");
  });

  it("rejects the image that would push the total over 20MiB", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const { textarea } = render(onSend);
    // 单张 7MiB（低于 8MiB 单张上限），三张合计 21MiB 触发 20MiB 总量上限。
    const each = 7 * 1024 * 1024;

    await act(async () => {
      pasteFiles(textarea, ["a.png", "b.png", "c.png"].map((name) => imageFile(name, each)));
      await settle();
    });

    expect(container.querySelectorAll(".composer-attachment")).toHaveLength(2);
    expect(container.querySelector("[role='alert']")?.textContent).toContain("合计 20MiB 限制");
  });

  it("removes a staged attachment through its remove button", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const { textarea } = render(onSend);

    await act(async () => {
      pasteFiles(textarea, [imageFile("remove-me.png", 64)]);
      await settle();
    });
    expect(container.querySelectorAll(".composer-attachment")).toHaveLength(1);
    act(() => {
      container.querySelector<HTMLButtonElement>(".composer-attachment-remove")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelectorAll(".composer-attachment")).toHaveLength(0);
  });

  it("surfaces a read-only lark-cli hint when the draft links a Feishu document", () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const { textarea } = render(onSend);

    expect(container.querySelector(".composer-lark-hint")).toBeNull();
    act(() => typeText(textarea, "参考 https://example.feishu.cn/docx/AbCdEf 的结论"));
    expect(container.querySelector(".composer-lark-hint")?.textContent).toContain("检测到 1 个飞书 / Lark 文档链接");
  });

  it("disables input and shows the offline hint while the daemon is unavailable", () => {
    const onSend = vi.fn().mockResolvedValue(true);
    act(() => root.render(<ConversationComposer ariaLabel="测试消息" disabled onSend={onSend} />));

    expect(container.querySelector("textarea")?.disabled).toBe(true);
    expect(container.textContent).toContain("服务离线，仅可查阅历史");
    expect(container.querySelector<HTMLButtonElement>("button[type='submit']")?.disabled).toBe(true);
  });

  it("opens the persisted image in a dismissible in-app preview", () => {
    act(() => root.render(<ConversationMessageEvidence attachments={[{
      id: "att-1",
      kind: "image",
      name: "screen.png",
      mediaType: "image/png",
      sizeBytes: 2048,
      sha256: "x"
    }]} />));

    act(() => container.querySelector<HTMLButtonElement>('[aria-label="放大预览 screen.png"]')?.click());
    const preview = document.querySelector<HTMLDialogElement>("dialog.message-evidence-preview-modal");
    expect(preview?.open).toBe(true);
    expect(preview?.querySelector<HTMLImageElement>('.message-evidence-preview-viewport img')?.alt).toBe("screen.png");
    expect(preview?.querySelector<HTMLAnchorElement>('a[href="/api/conversation-attachments/att-1"]')?.textContent).toContain("打开原图");

    act(() => preview?.querySelector<HTMLButtonElement>('[aria-label="关闭弹窗"]')?.click());
    expect(document.querySelector("dialog.message-evidence-preview-modal")).toBeNull();
  });
});

describe("detectLarkDocumentLinks", () => {
  it("detects Feishu/Lark docx and wiki links exactly once", () => {
    const links = detectLarkDocumentLinks(
      "见 https://acme.feishu.cn/docx/Token123 与 https://acme.feishu.cn/docx/Token123 以及 https://tenant.larksuite.com/wiki/Node99?from=copy"
    );
    expect(links).toHaveLength(2);
    expect(links[0]).toContain("feishu.cn/docx/Token123");
    expect(links[1]).toContain("larksuite.com/wiki/Node99");
  });

  it("ignores non-Lark hosts and non-document Lark paths", () => {
    expect(detectLarkDocumentLinks("https://example.com/docx/abc")).toEqual([]);
    expect(detectLarkDocumentLinks("https://acme.feishu.cn/sheets/abc")).toEqual([]);
    expect(detectLarkDocumentLinks("https://acme.feishu.cn/")).toEqual([]);
    expect(detectLarkDocumentLinks("不是链接")).toEqual([]);
  });
});

describe("ConversationMessageEvidence", () => {
  it("renders image attachments as an accessible preview trigger without local paths", () => {
    const html = renderToStaticMarkup(<ConversationMessageEvidence
      attachments={[{ id: "att-1", kind: "image", name: "screen.png", mediaType: "image/png", sizeBytes: 2048, sha256: "x" }]}
      documents={[{
        id: "doc-1",
        kind: "lark-document",
        url: "https://acme.feishu.cn/docx/Token123",
        status: "failed",
        fetchedAt: "2026-08-09T00:00:00.000Z",
        error: { code: "unavailable", message: "lark-cli 未登录", action: "先完成登录再重试" }
      }]}
    />);

    expect(html).toContain("/api/conversation-attachments/att-1");
    expect(html).toContain("aria-haspopup=\"dialog\"");
    expect(html).toContain("放大预览 screen.png");
    expect(html).toContain("点击放大");
    expect(html).toContain("screen.png");
    expect(html).toContain("https://acme.feishu.cn/docx/Token123");
    expect(html).toContain("文档解析失败");
    expect(html).toContain("lark-cli 未登录");
  });

  it("renders nothing for messages without evidence", () => {
    expect(renderToStaticMarkup(<ConversationMessageEvidence />)).toBe("");
  });
});
