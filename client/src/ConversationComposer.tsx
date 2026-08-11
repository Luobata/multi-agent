/**
 * 共享对话编辑器：textarea + 图片附件（PNG/JPEG/WebP/GIF）。
 * 与服务端契约保持一致：最多 5 张、单张 8MiB、合计 20MiB，
 * 发送载体严格为 attachments: [{ name, mediaType, base64 }]。
 * 发送失败（onSend 返回 false）时正文与附件全部保留，由用户决定重试或修改。
 */
import { useEffect, useId, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from "react";
import { Modal, Stamp } from "./components";
import "./conversation-composer.css";
import type {
  ConversationDocumentEvidenceMetadata,
  ConversationImageAttachmentInput,
  ConversationImageAttachmentMetadata,
  ConversationImageMediaType
} from "./types";

export const MAX_COMPOSER_IMAGES = 5;
export const MAX_COMPOSER_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_COMPOSER_IMAGE_TOTAL_BYTES = 20 * 1024 * 1024;

export const COMPOSER_IMAGE_ACCEPT = ".png,.jpg,.jpeg,.webp,.gif";

const MEDIA_BY_EXTENSION: Record<string, ConversationImageMediaType> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif"
};

const ACCEPTED_MEDIA_TYPES = new Set<string>(Object.values(MEDIA_BY_EXTENSION));

/** 与服务端 conversationEvidence 保持一致的只读解析范围。 */
const LARK_DOCUMENT_HOSTS = ["feishu.cn", "larksuite.com", "larkoffice.com", "doubao.com"];

export interface ComposerImage {
  id: string;
  name: string;
  mediaType: ConversationImageMediaType;
  sizeBytes: number;
  base64: string;
}

export interface ComposerDraft {
  message: string;
  attachments: ConversationImageAttachmentInput[];
}

let composerImageCounter = 0;

export function formatAttachmentSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${Math.max(1, Math.round(bytes / 1024))} KiB`;
  return `${bytes} B`;
}

function imageMediaType(file: File): ConversationImageMediaType | undefined {
  if (ACCEPTED_MEDIA_TYPES.has(file.type)) return file.type as ConversationImageMediaType;
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return MEDIA_BY_EXTENSION[extension];
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`无法读取文件 ${file.name}`));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      if (!result.startsWith("data:") || comma < 0) {
        reject(new Error(`无法解析文件 ${file.name}`));
        return;
      }
      resolve(result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

/** 检测正文中的飞书 / Lark / Doubao `/docx/` `/wiki/` 链接；发送后由服务端 lark-cli 只读解析。 */
export function detectLarkDocumentLinks(text: string): string[] {
  const candidates = text.match(/https?:\/\/[^\s<>"'）)】]+/gi) ?? [];
  const links = new Set<string>();
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      const host = url.hostname.toLowerCase();
      if (!LARK_DOCUMENT_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`))) continue;
      if (!/^\/(?:docx|wiki)\/[^/?#]+/i.test(url.pathname)) continue;
      links.add(url.toString());
    } catch {
      // 非完整 URL 的文本片段直接忽略。
    }
  }
  return [...links];
}

export function conversationAttachmentUrl(id: string): string {
  return `/api/conversation-attachments/${encodeURIComponent(id)}`;
}

export function ConversationComposer({
  ariaLabel,
  placeholder,
  disabled = false,
  message,
  onMessageChange,
  initialMessage = "",
  submitLabel = "发送",
  sendingLabel = "发送中…",
  hint = "⌘ / Ctrl + Enter 发送",
  offlineHint = "服务离线，仅可查阅历史",
  className = "",
  onSend,
  onPendingChange
}: {
  ariaLabel: string;
  placeholder?: string;
  disabled?: boolean;
  /** 受控模式：传入 message + onMessageChange 后由父组件持有正文。 */
  message?: string;
  onMessageChange?: (value: string) => void;
  /** 非受控模式的初始正文（仅挂载时生效）。 */
  initialMessage?: string;
  submitLabel?: string;
  sendingLabel?: string;
  hint?: string;
  offlineHint?: string;
  className?: string;
  /** 返回 true 表示发送成功（清空正文与附件）；返回 false 表示失败（全部保留）。 */
  onSend: (draft: ComposerDraft) => Promise<boolean>;
  onPendingChange?: (pending: boolean) => void;
}) {
  const controlled = message !== undefined && onMessageChange !== undefined;
  const [internalMessage, setInternalMessage] = useState(initialMessage);
  const value = controlled ? message : internalMessage;
  const setValue = (next: string) => {
    if (controlled) onMessageChange(next);
    else setInternalMessage(next);
  };
  const [images, setImages] = useState<ComposerImage[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [pending, setPending] = useState(false);
  const [previewImage, setPreviewImage] = useState<ComposerImage>();
  const [failedImages, setFailedImages] = useState<Set<string>>(() => new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const pendingRef = useRef(onPendingChange);
  pendingRef.current = onPendingChange;

  useEffect(() => {
    pendingRef.current?.(pending);
  }, [pending]);

  const addFiles = async (files: Iterable<File>) => {
    const incoming = [...files];
    if (incoming.length === 0) return;
    const rejected: string[] = [];
    const accepted: File[] = [];
    for (const file of incoming) {
      if (!imageMediaType(file)) {
        rejected.push(`「${file.name || "未命名图片"}」不是 PNG/JPEG/WebP/GIF 图片`);
      } else if (file.size > MAX_COMPOSER_IMAGE_BYTES) {
        rejected.push(`「${file.name || "未命名图片"}」超过单张 8MiB 限制`);
      } else {
        accepted.push(file);
      }
    }
    let next = images;
    const loaded: ComposerImage[] = [];
    for (const file of accepted) {
      if (next.length + loaded.length >= MAX_COMPOSER_IMAGES) {
        rejected.push(`最多附带 ${MAX_COMPOSER_IMAGES} 张图片`);
        break;
      }
      const mediaType = imageMediaType(file);
      if (!mediaType) continue;
      try {
        const base64 = await readFileAsBase64(file);
        loaded.push({
          id: `composer-img-${++composerImageCounter}`,
          name: file.name || `粘贴图片-${composerImageCounter}.${mediaType.split("/")[1]}`,
          mediaType,
          sizeBytes: file.size,
          base64
        });
      } catch (error) {
        rejected.push(error instanceof Error ? error.message : String(error));
      }
    }
    const totalBytes = [...next, ...loaded].reduce((sum, image) => sum + image.sizeBytes, 0);
    let finalLoaded = loaded;
    if (totalBytes > MAX_COMPOSER_IMAGE_TOTAL_BYTES) {
      const kept: ComposerImage[] = [];
      let running = next.reduce((sum, image) => sum + image.sizeBytes, 0);
      for (const image of loaded) {
        if (running + image.sizeBytes > MAX_COMPOSER_IMAGE_TOTAL_BYTES) {
          rejected.push(`「${image.name}」加入后会超过合计 20MiB 限制`);
          continue;
        }
        running += image.sizeBytes;
        kept.push(image);
      }
      finalLoaded = kept;
    }
    if (finalLoaded.length > 0) setImages([...next, ...finalLoaded]);
    setAttachmentError(rejected.join("；"));
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...(event.clipboardData?.files ?? [])];
    if (files.length === 0) return;
    event.preventDefault();
    if (disabled || pending) return;
    void addFiles(files);
  };

  const removeImage = (id: string) => {
    setImages((current) => current.filter((image) => image.id !== id));
    setPreviewImage((current) => current?.id === id ? undefined : current);
    setAttachmentError("");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = value.trim();
    if (!text || disabled || pending) return;
    setPending(true);
    try {
      const sent = await onSend({
        message: text,
        attachments: images.map(({ name, mediaType, base64 }) => ({ name, mediaType, base64 }))
      });
      if (sent) {
        setValue("");
        setImages([]);
        setAttachmentError("");
      }
    } finally {
      setPending(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  const larkLinks = detectLarkDocumentLinks(value);
  const effectivelyDisabled = disabled || pending;

  return <form className={`composer conversation-composer ${className}`.trim()} onSubmit={(event) => void submit(event)}>
    {images.length > 0 && <ul className="composer-attachments" aria-label="待发送的图片附件">
      {images.map((image) => <li className="composer-attachment" key={image.id}>
        <button type="button" className="composer-attachment-preview" onClick={() => setPreviewImage(image)} aria-haspopup="dialog" aria-label={`放大预览 ${image.name}`}>
          {failedImages.has(image.id)
            ? <span className="composer-attachment-image-error" role="status">无法加载</span>
            : <img src={`data:${image.mediaType};base64,${image.base64}`} alt="" width={48} height={48} onError={() => setFailedImages((current) => new Set(current).add(image.id))} />}
        </button>
        <span className="composer-attachment-meta"><strong>{image.name}</strong><small>{image.mediaType.split("/")[1].toUpperCase()} · {formatAttachmentSize(image.sizeBytes)}</small></span>
        <button type="button" className="composer-attachment-remove" disabled={pending} onClick={() => removeImage(image.id)} aria-label={`移除附件 ${image.name}`}>×</button>
      </li>)}
    </ul>}
    <textarea
      rows={3}
      required
      disabled={effectivelyDisabled}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      placeholder={placeholder}
      aria-label={ariaLabel}
      aria-describedby={attachmentError ? errorId : undefined}
      aria-invalid={Boolean(attachmentError) || undefined}
    />
    {attachmentError && <p className="composer-error" id={errorId} role="alert">{attachmentError}</p>}
    {larkLinks.length > 0 && <p className="composer-lark-hint" role="status">
      检测到 {larkLinks.length} 个飞书 / Lark 文档链接，发送后由 lark-cli 只读解析；文档内容不会赋予 Agent 额外权限。
    </p>}
    <div className="composer-footer">
      <span aria-live="polite">{pending ? <><span className="composer-loading" aria-hidden="true" />{sendingLabel}</> : disabled ? offlineHint : `${hint} · 可粘贴或选择图片（≤5 张，单张 ≤8MiB）`}</span>
      <div className="composer-actions">
        <input
          ref={fileInputRef}
          type="file"
          accept={COMPOSER_IMAGE_ACCEPT}
          multiple
          className="sr-only"
          aria-label="选择图片附件"
          disabled={effectivelyDisabled}
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = "";
            void addFiles(files);
          }}
        />
        <button type="button" className="button secondary" disabled={effectivelyDisabled || images.length >= MAX_COMPOSER_IMAGES} onClick={() => fileInputRef.current?.click()}>添加图片</button>
        <button type="submit" className="button primary" disabled={effectivelyDisabled || !value.trim()}>{pending ? sendingLabel : submitLabel}</button>
      </div>
    </div>
    {previewImage && <Modal title={previewImage.name} eyebrow="STAGED IMAGE · PREVIEW" onClose={() => setPreviewImage(undefined)} wide className="message-evidence-preview-modal">
      <div className="message-evidence-preview-body">
        <div className="message-evidence-preview-viewport">
          {failedImages.has(previewImage.id)
            ? <span className="message-evidence-image-error" role="status">图片无法加载</span>
            : <img src={`data:${previewImage.mediaType};base64,${previewImage.base64}`} alt={previewImage.name} onError={() => setFailedImages((current) => new Set(current).add(previewImage.id))} />}
        </div>
        <footer><span>{previewImage.mediaType.split("/")[1].toUpperCase()} · {formatAttachmentSize(previewImage.sizeBytes)}</span></footer>
      </div>
    </Modal>}
  </form>;
}

/** 历史消息证据：图片走服务端按附件 id 的预览 URL，文档只展示 URL 与 available/failed 状态；绝不展示本地磁盘路径。 */
function ConversationEvidenceImage({ attachment }: { attachment: ConversationImageAttachmentMetadata }) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const url = conversationAttachmentUrl(attachment.id);

  return <>
    <button
      type="button"
      className="message-evidence-image"
      onClick={() => setPreviewOpen(true)}
      aria-haspopup="dialog"
      aria-label={`放大预览 ${attachment.name}`}
    >
      {thumbnailFailed
        ? <span className="message-evidence-image-error" role="status">图片暂时无法加载</span>
        : <img src={url} alt="" loading="lazy" decoding="async" onError={() => setThumbnailFailed(true)} />}
      <span><strong>{attachment.name}</strong><small>{formatAttachmentSize(attachment.sizeBytes)} · 点击放大</small></span>
    </button>
    {previewOpen && <Modal
      title={attachment.name}
      eyebrow="IMAGE EVIDENCE · PREVIEW"
      onClose={() => setPreviewOpen(false)}
      wide
      className="message-evidence-preview-modal"
    >
      <div className="message-evidence-preview-body">
        <div className="message-evidence-preview-viewport">
          <img src={url} alt={attachment.name} />
        </div>
        <footer>
          <span>{attachment.mediaType.split("/")[1]?.toUpperCase()} · {formatAttachmentSize(attachment.sizeBytes)}</span>
          <a className="button secondary" href={url} target="_blank" rel="noreferrer">在新窗口打开原图</a>
        </footer>
      </div>
    </Modal>}
  </>;
}

export function ConversationMessageEvidence({ attachments, documents }: {
  attachments?: ConversationImageAttachmentMetadata[];
  documents?: ConversationDocumentEvidenceMetadata[];
}) {
  if (!attachments?.length && !documents?.length) return null;
  return <div className="message-evidence">
    {attachments?.map((attachment) => <ConversationEvidenceImage key={attachment.id} attachment={attachment} />)}
    {documents?.map((document) => <div key={document.id} className={`message-evidence-doc message-evidence-doc--${document.status}`}>
      <Stamp status={document.status === "available" ? "passed" : "failed"} label={document.status === "available" ? "文档已解析" : "文档解析失败"} />
      <span className="message-evidence-doc-url">{document.url}</span>
      {document.status === "available" && document.contentBytes !== undefined && <span className="message-evidence-doc-meta">只读快照 · {formatAttachmentSize(document.contentBytes)}</span>}
      {document.status === "failed" && document.error && <span className="message-evidence-doc-error">{document.error.message}；{document.error.action}</span>}
    </div>)}
  </div>;
}
