// src/config/datetime.ts
function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

/**
 * 展示层时间格式化：ISO 8601 -> "YYYY-MM-DD HH:mm:ss"（本地时区）。
 * 存储层不受影响，继续用 ISO 8601 以保排序与 Date.parse 兼容。
 */
export function formatDateTime(iso: string): string {
  if (!iso) return iso;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}
