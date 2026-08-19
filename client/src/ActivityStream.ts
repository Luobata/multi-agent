import { createContext, useContext } from "react";
import type { ActivitySnapshot } from "./types";

/**
 * 共享实时活动流：App.tsx 持有唯一的 `/api/activity/stream` EventSource，
 * 其余组件通过 `useActivityStream()` 消费同一份快照，而不是自己再开连接。
 * 默认值为空快照 + offline，未包 Provider 的宿主（如独立测试）会自然降级为轮询。
 */
export type ActivityStreamStatus = "connecting" | "live" | "reconnecting" | "offline";

export interface ActivityStreamValue {
  activity: ActivitySnapshot;
  status: ActivityStreamStatus;
}

const EMPTY_ACTIVITY: ActivitySnapshot = { invocations: [], instances: [] };

export const ActivityStreamContext = createContext<ActivityStreamValue>({
  activity: EMPTY_ACTIVITY,
  status: "offline"
});

export function useActivityStream(): ActivityStreamValue {
  return useContext(ActivityStreamContext);
}
