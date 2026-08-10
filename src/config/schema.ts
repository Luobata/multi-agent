const stringList = {
  type: "array",
  items: { type: "string", minLength: 1 },
  uniqueItems: true
} as const;

export const manifestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["version", "name", "providers", "roles", "workflows"],
  properties: {
    version: { const: 1 },
    name: { type: "string", minLength: 1 },
    artifactRoot: { type: "string", minLength: 1 },
    providers: {
      type: "object",
      minProperties: 1,
      additionalProperties: {
        type: "object",
        additionalProperties: true,
        required: ["adapter"],
        properties: {
          adapter: { type: "string", pattern: "^[a-z][a-z0-9-]*$" },
          outputProtocol: { enum: ["json", "claude-json", "claude-stream-json", "codex-stream-json", "raw"] }
        }
      }
    },
    skills: {
      type: "object",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        required: ["description", "instructions"],
        properties: {
          displayName: { type: "string", minLength: 1 },
          description: { type: "string", minLength: 1 },
          instructions: { type: "string", minLength: 1 },
          configSchema: { type: "string", minLength: 1 },
          tools: stringList
        }
      }
    },
    roles: {
      type: "object",
      minProperties: 1,
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        required: ["identity", "provider", "requestTemplate", "outputSchema"],
        properties: {
          identity: {
            type: "object",
            additionalProperties: false,
            required: ["displayName", "background", "responsibilities"],
            properties: {
              displayName: { type: "string", minLength: 1 },
              background: { type: "string", minLength: 1 },
              responsibilities: { ...stringList, minItems: 1 },
              goals: stringList,
              constraints: stringList,
              metadata: { type: "object" }
            }
          },
          description: { type: "string", minLength: 1 },
          provider: { type: "string", minLength: 1 },
          instructions: { type: "string", minLength: 1 },
          skills: {
            type: "array",
            uniqueItems: true,
            items: {
              oneOf: [
                { type: "string", minLength: 1 },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["id"],
                  properties: {
                    id: { type: "string", minLength: 1 },
                    config: { type: "object" },
                    enabled: { type: "boolean" }
                  }
                }
              ]
            }
          },
          requestTemplate: { type: "string", minLength: 1 },
          outputSchema: { type: "string", minLength: 1 },
          maxAttempts: { type: "integer", minimum: 1, maximum: 10 },
          permissions: {
            type: "object",
            additionalProperties: false,
            required: ["write"],
            properties: {
              write: { enum: ["none", "artifacts-only", "project"] },
              tools: stringList
            }
          },
          verdict: {
            type: "object",
            additionalProperties: false,
            required: ["path", "pass", "block"],
            properties: {
              path: { type: "string", minLength: 1 },
              pass: { type: "array", minItems: 1, items: { type: ["string", "number", "boolean", "null"] } },
              block: { type: "array", minItems: 1, items: { type: ["string", "number", "boolean", "null"] } }
            }
          }
        }
      }
    },
    workflows: {
      type: "object",
      minProperties: 1,
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        required: ["architecture", "config"],
        properties: {
          architecture: { type: "string", pattern: "^[a-z][a-z0-9-]*$" },
          description: { type: "string" },
          inputSchema: { type: "string", minLength: 1 },
          config: { type: "object" }
        }
      }
    }
  }
} as const;
