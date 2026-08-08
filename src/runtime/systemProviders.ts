export const SYSTEM_PROVIDER_RUNTIME_PROFILES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "codex-knowledge-control": Object.freeze(["knowledge-proposal-only"]),
  "codex-configuration-control": Object.freeze(["configuration-proposal-only"]),
  "codex-gate-control": Object.freeze(["gate-proposal-only"])
});

export function isSystemManagedProviderId(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(SYSTEM_PROVIDER_RUNTIME_PROFILES, id);
}

export function systemProviderRuntimeProfiles(id: string): readonly string[] | undefined {
  return SYSTEM_PROVIDER_RUNTIME_PROFILES[id];
}
