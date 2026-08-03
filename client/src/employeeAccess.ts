import type { Employee } from "./types";

export interface SystemEmployeeScope {
  projectId: string;
  roleId?: string;
}

export function systemEmployeeScope(employee: Employee): SystemEmployeeScope | undefined {
  const projectId = employee.identity.metadata?.internalProjectId;
  if (typeof projectId !== "string" || !projectId.trim()) return undefined;
  const roleId = employee.identity.metadata?.internalProjectRoleId;
  return {
    projectId: projectId.trim(),
    ...(typeof roleId === "string" && roleId.trim() ? { roleId: roleId.trim() } : {})
  };
}

export function isSystemEmployee(employee: Employee): boolean {
  return systemEmployeeScope(employee) !== undefined;
}
