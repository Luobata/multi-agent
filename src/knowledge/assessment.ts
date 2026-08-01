import type {
  KnowledgeBaseDefinition,
  KnowledgeRevision,
  KnowledgeRevisionAssessment,
  KnowledgeRevisionWarning
} from "./types.js";

export function assessKnowledgeRevision(
  knowledgeBase: KnowledgeBaseDefinition,
  revision: KnowledgeRevision,
  assessedAt = new Date().toISOString()
): KnowledgeRevisionAssessment {
  const warnings: KnowledgeRevisionWarning[] = [];
  if (revision.documents.length === 0) {
    warnings.push({
      code: "empty-revision",
      severity: "blocker",
      message: "Revision 没有任何文档，不能发布。"
    });
  }
  const collections = knowledgeBase.collections.map((collection) => {
    const documents = revision.documents.filter((document) => document.collectionId === collection.id);
    const sourceDocumentCount = documents.filter((document) => Boolean(document.sourceId)).length;
    const manualDocumentCount = documents.length - sourceDocumentCount;
    if (documents.length === 0) {
      warnings.push({
        code: "empty-collection",
        severity: "warning",
        collectionId: collection.id,
        message: `Collection ${collection.displayName}（${collection.id}）没有内容。`
      });
    }
    return {
      collectionId: collection.id,
      collectionName: collection.displayName,
      documentCount: documents.length,
      sourceDocumentCount,
      manualDocumentCount
    };
  });
  const sourceDocumentCount = revision.documents.filter((document) => Boolean(document.sourceId)).length;
  if (knowledgeBase.sources.length > 0 && sourceDocumentCount === 0) {
    warnings.push({
      code: "source-coverage-missing",
      severity: "warning",
      message: "知识库配置了同步来源，但这个 Revision 没有任何来源文档。"
    });
  }
  const status = warnings.some((warning) => warning.severity === "blocker")
    ? "blocked"
    : warnings.length > 0 ? "attention" : "ready";
  return {
    knowledgeBaseId: knowledgeBase.id,
    revision: revision.revision,
    status,
    documentCount: revision.documents.length,
    sourceDocumentCount,
    manualDocumentCount: revision.documents.length - sourceDocumentCount,
    collections,
    warnings,
    assessedAt
  };
}
