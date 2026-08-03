import type { Employee } from "./types";

export interface SystemEmployeeScope {
  projectId: string;
  roleId?: string;
}

export function systemEmployeeScope(employee: Employee): SystemEmployeeScope | undefined {
  // System ownership and project scope are separate concerns. Legacy system
  // Employees are explicitly marked in identity metadata; a user-created
  // project Employee must not be presented as a system Employee merely because
  // it is project-scoped.
  const legacyProjectId = employee.identity.metadata?.internalProjectId;
  const projectId = typeof legacyProjectId === "string" && legacyProjectId.trim() ? legacyProjectId.trim() : undefined;
  if (!projectId) return undefined;
  const roleId = employee.identity.metadata?.internalProjectRoleId;
  return {
    projectId,
    ...(typeof roleId === "string" && roleId.trim() ? { roleId: roleId.trim() } : {})
  };
}

export function isSystemEmployee(employee: Employee): boolean {
  return systemEmployeeScope(employee) !== undefined;
}

export function isProjectEmployee(employee: Employee): boolean {
  return employee.scope.kind === "project" && !isSystemEmployee(employee);
}
