import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Response } from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonObject } from "../src/core/types.js";
import type { ProviderRegistry } from "../src/runtime/providers.js";
import { createDaemonApp, sendConversationAttachment } from "../src/daemon/server.js";
import { createWorkbenchMcpServer } from "../src/mcp/server.js";
import {
  LarkCliDocumentFetcher,
  LarkDocumentFetchError,
  MAX_CONVERSATION_IMAGE_BYTES,
  detectLarkDocumentUrls,
  validateConversationImages,
  type LarkExecFile
} from "../src/workbench/conversationEvidence.js";
import { WorkbenchService } from "../src/workbench/service.js";
import type { ConversationImageAttachmentInput } from "../src/workbench/types.js";

const temporaryDirectories: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "multi-agent-conversation-evidence-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function imageBytes(size = 16): Buffer {
  const bytes = Buffer.alloc(Math.max(size, 8));
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  return bytes;
}

function pngAttachment(name = "evidence.png", size = 16): ConversationImageAttachmentInput {
  return { name, mediaType: "image/png", base64: imageBytes(size).toString("base64") };
}

async function evidenceService(options: {
  dataRoot?: string;
  fetch?: (url: string) => Promise<{ content: string; documentId?: string; revisionId?: string }>;
} = {}) {
  const observedInputs: JsonObject[] = [];
  const providers: ProviderRegistry = new Map([["evidence-capture", {
    id: "evidence-capture",
    validate: () => [],
    invoke: async (invocation) => {
      const input = invocation.templateContext.input;
      observedInputs.push(JSON.parse(JSON.stringify(input)) as JsonObject);
      return { stdout: JSON.stringify({ message: "Evidence received." }), stderr: "", durationMs: 1 };
    }
  }]]);
  const dataRoot = options.dataRoot ?? temporaryRoot();
  const service = await WorkbenchService.open({
    dataRoot,
    providers,
    larkDocumentFetcher: { fetch: options.fetch ?? (async () => ({ content: "unused" })) }
  });
  await service.putProvider("evidence-provider", {
    adapter: "evidence-capture",
    model: "evidence-test",
    outputProtocol: "json"
  });
  await service.createEmployee({
    id: "evidence-agent",
    identity: {
      displayName: "Evidence Agent",
      background: "Reads frozen conversation evidence.",
      responsibilities: ["Read evidence"]
    },
    providerId: "evidence-provider"
  });
  return { service, dataRoot, observedInputs };
}

describe("conversation evidence validation", () => {
  it("strictly validates image names, media types, base64, signatures, count, and byte limits", () => {
    expect(validateConversationImages([pngAttachment()])).toEqual([
      expect.objectContaining({ name: "evidence.png", mediaType: "image/png", bytes: imageBytes() })
    ]);
    expect(() => validateConversationImages(new Array(6).fill(pngAttachment()))).toThrow(/at most 5 images/);
    expect(() => validateConversationImages([{ ...pngAttachment(), name: "../evidence.png" }])).toThrow(/safe .*file name/);
    expect(() => validateConversationImages([{ ...pngAttachment(), name: "evidence.jpg" }])).toThrow(/extension does not match/);
    expect(() => validateConversationImages([{ ...pngAttachment(), mediaType: "image/svg+xml" }])).toThrow(/mediaType must be/);
    expect(() => validateConversationImages([{ ...pngAttachment(), base64: "data:image/png;base64,AAAA" }])).toThrow(/canonical base64/);
    expect(() => validateConversationImages([{ ...pngAttachment(), base64: Buffer.from("not png").toString("base64") }]))
      .toThrow(/bytes do not match/);
    expect(() => validateConversationImages([pngAttachment("too-large.png", MAX_CONVERSATION_IMAGE_BYTES + 1)]))
      .toThrow(/byte limit/);
    const sevenMiB = pngAttachment("large.png", 7 * 1024 * 1024);
    expect(() => validateConversationImages([sevenMiB, { ...sevenMiB, name: "large-2.png" }, { ...sevenMiB, name: "large-3.png" }]))
      .toThrow(/byte total limit/);
  });

  it("detects only Feishu, Lark, and Doubao docx/wiki URLs and preserves their original URL", () => {
    expect(detectLarkDocumentUrls([
      "读 https://team.feishu.cn/docx/DocToken?from=chat，",
      "以及 https://open.larksuite.com/wiki/WikiToken#section",
      "再看 https://docs.doubao.com/docx/DoubaoToken.",
      "忽略 https://evil-feishu.cn/docx/Nope 与 https://team.feishu.cn/sheets/Nope"
    ].join(" "))).toEqual([
      "https://team.feishu.cn/docx/DocToken?from=chat",
      "https://open.larksuite.com/wiki/WikiToken#section",
      "https://docs.doubao.com/docx/DoubaoToken"
    ]);
  });

  it("uses execFile-style argv, user identity, notifier suppression, timeout, and bounded output", async () => {
    const run = vi.fn<LarkExecFile>(async () => ({
      stdout: JSON.stringify({
        ok: true,
        identity: "user",
        data: { document: { document_id: "doc-1", revision_id: 42, content: "# Frozen" } }
      }),
      stderr: ""
    }));
    const fetcher = new LarkCliDocumentFetcher(run);
    await expect(fetcher.fetch("https://team.feishu.cn/docx/DocToken")).resolves.toEqual({
      content: "# Frozen",
      documentId: "doc-1",
      revisionId: "42"
    });
    expect(run).toHaveBeenCalledOnce();
    const [file, args, options] = run.mock.calls[0]!;
    expect(file).toBe("lark-cli");
    expect(args).toEqual([
      "docs", "+fetch", "--doc", "https://team.feishu.cn/docx/DocToken",
      "--doc-format", "markdown", "--detail", "simple", "--as", "user"
    ]);
    expect(options).toMatchObject({ timeout: 30_000, maxBuffer: expect.any(Number) });
    expect(options.env).toMatchObject({
      LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
      LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1"
    });
  });
});

describe("conversation evidence persistence", () => {
  it("keeps base64 out of state, freezes image/document evidence, and carries paths into Run and later history", async () => {
    const fetch = vi.fn(async () => ({
      content: "# Frozen requirements\n\nUse traceable evidence.",
      documentId: "doxcn-frozen",
      revisionId: "17"
    }));
    const { service, dataRoot, observedInputs } = await evidenceService({ fetch });
    const attachment = pngAttachment("screen.png");
    const result = await service.invokeEmployee("evidence-agent", {
      message: "Review https://team.feishu.cn/docx/FrozenDoc?from=chat",
      attachments: [attachment]
    });

    expect(fetch).toHaveBeenCalledWith("https://team.feishu.cn/docx/FrozenDoc?from=chat");
    const userMessage = result.session.messages.find((message) => message.role === "user")!;
    expect(userMessage.attachments).toEqual([
      expect.objectContaining({ kind: "image", name: "screen.png", mediaType: "image/png", sizeBytes: 16 })
    ]);
    expect(userMessage.documents).toEqual([
      expect.objectContaining({
        kind: "lark-document",
        status: "available",
        documentId: "doxcn-frozen",
        revisionId: "17"
      })
    ]);
    const persistedState = fs.readFileSync(path.join(dataRoot, "state.json"), "utf8");
    expect(persistedState).not.toContain(attachment.base64);
    expect(persistedState).not.toContain("absolutePath");

    const firstEvidence = observedInputs[0]!.conversationEvidence as JsonObject;
    const promptImages = firstEvidence.attachments as unknown as Array<{ absolutePath: string; mediaType: string; name: string }>;
    const promptDocuments = firstEvidence.documents as unknown as Array<{ absolutePath: string; revisionId: string }>;
    expect(path.isAbsolute(promptImages[0]!.absolutePath)).toBe(true);
    expect(promptImages[0]).toMatchObject({ mediaType: "image/png", name: "screen.png" });
    expect(fs.readFileSync(promptImages[0]!.absolutePath)).toEqual(imageBytes());
    expect(fs.readFileSync(promptDocuments[0]!.absolutePath, "utf8")).toContain("Frozen requirements");
    const actualRequestPrompt = fs.readFileSync(
      path.join(result.runDir, "nodes", "respond", "attempt-1", "request-prompt.md"),
      "utf8"
    );
    expect(actualRequestPrompt).toContain(promptImages[0]!.absolutePath);
    expect(actualRequestPrompt).toContain(promptDocuments[0]!.absolutePath);
    expect(actualRequestPrompt).toContain("image/png");
    expect(actualRequestPrompt).toContain("screen.png");

    const runInput = JSON.parse(fs.readFileSync(path.join(result.runDir, "input.json"), "utf8")) as JsonObject;
    const runEvidence = JSON.parse(fs.readFileSync(path.join(result.runDir, "conversation", "evidence.json"), "utf8")) as JsonObject;
    expect(runInput.conversationEvidence).toEqual(runEvidence);
    expect(JSON.stringify(runInput)).not.toContain(attachment.base64);
    expect(runEvidence).toEqual(firstEvidence);

    await service.invokeEmployee("evidence-agent", {
      message: "Use the previous image and frozen document.",
      sessionId: result.session.id
    });
    const laterHistory = observedInputs[1]!.sessionHistory as string;
    expect(laterHistory).toContain("screen.png");
    expect(laterHistory).toContain(promptImages[0]!.absolutePath);
    expect(laterHistory).toContain(promptDocuments[0]!.absolutePath);
    expect(laterHistory).toContain("revisionId=17");
  });

  it("records an actionable failed Lark fetch and still invokes the Agent with the user message", async () => {
    const { service, dataRoot, observedInputs } = await evidenceService({
      fetch: async () => {
        throw new LarkDocumentFetchError(
          "User authentication is missing.",
          "lark_auth_required",
          "Run lark-cli auth login --domain docs --no-wait --json, then retry."
        );
      }
    });
    const result = await service.invokeEmployee("evidence-agent", {
      message: "Read https://team.feishu.cn/wiki/ProtectedDoc and continue even if access fails."
    });

    expect(result.status).toBe("passed");
    const userMessage = result.session.messages.find((message) => message.role === "user")!;
    expect(userMessage.content).toContain("ProtectedDoc");
    expect(userMessage.documents).toEqual([
      expect.objectContaining({
        status: "failed",
        error: expect.objectContaining({ code: "lark_auth_required", action: expect.stringContaining("auth login") })
      })
    ]);
    const evidence = observedInputs[0]!.conversationEvidence as JsonObject;
    expect(JSON.stringify(evidence)).toContain("lark_auth_required");
    expect(JSON.stringify(evidence)).toContain("auth login");
    const metadataFiles = fs.readdirSync(path.join(dataRoot, "conversation-evidence", "sessions"), { recursive: true })
      .filter((entry) => String(entry).endsWith(".metadata.json"));
    expect(metadataFiles).toHaveLength(1);
  });

  it("bounds host CLI fan-out and tells the Agent how to submit additional Lark links", async () => {
    const fetch = vi.fn(async (url: string) => ({ content: `Frozen ${url}` }));
    const { service, observedInputs } = await evidenceService({ fetch });
    const links = Array.from({ length: 6 }, (_, index) => `https://team.feishu.cn/docx/Doc${index + 1}`);
    const result = await service.invokeEmployee("evidence-agent", { message: links.join(" ") });
    expect(fetch).toHaveBeenCalledTimes(5);
    const documents = result.session.messages.find((message) => message.role === "user")!.documents!;
    expect(documents).toHaveLength(6);
    expect(documents[5]).toMatchObject({
      status: "failed",
      error: { code: "lark_document_limit", action: expect.stringContaining("batches") }
    });
    expect(JSON.stringify(observedInputs[0]!.conversationEvidence)).toContain("lark_document_limit");
  });

  it("builds the GET response only from a persisted attachment id and rejects traversal through symlinks", async () => {
    const root = temporaryRoot();
    const { service } = await evidenceService({ dataRoot: root });
    const invoked = await service.invokeEmployee("evidence-agent", {
      message: "Preview this image",
      attachments: [pngAttachment("preview.png")]
    });
    const attachmentId = invoked.session.messages.find((message) => message.role === "user")!.attachments![0]!.id;
    let sentPath = "";
    const response = {
      status: vi.fn(),
      type: vi.fn(),
      set: vi.fn(),
      sendFile: vi.fn((filePath: string, _options: { dotfiles: string }, callback: (error?: Error) => void) => {
        sentPath = filePath;
        callback();
      })
    } as unknown as Response;
    await sendConversationAttachment(service, attachmentId, response);
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.type).toHaveBeenCalledWith("image/png");
    expect(response.set).toHaveBeenCalledWith("X-Content-Type-Options", "nosniff");
    expect(response.sendFile).toHaveBeenCalledWith(sentPath, { dotfiles: "allow" }, expect.any(Function));
    expect(fs.readFileSync(sentPath)).toEqual(imageBytes());

    await expect(service.getConversationImageAttachment("../state.json")).rejects.toThrow(/id is invalid/);

    const stored = await service.getConversationImageAttachment(attachmentId);
    fs.unlinkSync(stored.filePath);
    fs.symlinkSync(path.join(root, "state.json"), stored.filePath);
    await expect(service.getConversationImageAttachment(attachmentId)).rejects.toThrow(/outside the evidence root/);
  });

  it("serves attachments through HTTP when the validated data root contains a dot-directory", async () => {
    const root = temporaryRoot();
    const dataRoot = path.join(root, ".multi-agent", "workbench");
    const { service } = await evidenceService({ dataRoot });
    const invoked = await service.invokeEmployee("evidence-agent", {
      message: "Preview this image over HTTP",
      attachments: [pngAttachment("hidden-root.png")]
    });
    const attachmentId = invoked.session.messages.find((message) => message.role === "user")!.attachments![0]!.id;
    const app = createDaemonApp(service, { staticDir: path.join(root, "missing-client") });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected TCP address");
      const response = await fetch(`http://127.0.0.1:${address.port}/api/conversation-attachments/${attachmentId}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("image/png");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(imageBytes());
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

describe("conversation evidence MCP compatibility", () => {
  it("keeps message-only calls valid and forwards optional image attachments without changing the endpoint", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({ data: { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }));
    const server = createWorkbenchMcpServer("http://127.0.0.1:4318");
    const client = new Client({ name: "conversation-evidence-contract", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      await client.callTool({
        name: "invoke_employee",
        arguments: { employeeId: "evidence-agent", message: "Message-only compatibility" }
      });
      const attachment = pngAttachment("mcp.png");
      await client.callTool({
        name: "invoke_employee",
        arguments: { employeeId: "evidence-agent", message: "With image", attachments: [attachment] }
      });
      expect(requests.map((request) => request.url)).toEqual([
        "http://127.0.0.1:4318/api/employees/evidence-agent/invoke",
        "http://127.0.0.1:4318/api/employees/evidence-agent/invoke"
      ]);
      expect(JSON.parse(String(requests[0]!.init?.body))).toEqual({ message: "Message-only compatibility" });
      expect(JSON.parse(String(requests[1]!.init?.body))).toEqual({ message: "With image", attachments: [attachment] });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
