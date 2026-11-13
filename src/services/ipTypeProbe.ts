import { getPublic, saveThemeSettings } from "@/services/api";
import {
  IP_TYPE_SETTINGS_KEY,
  normalizeIpTypeSettings,
  type IpTypeNodeResult,
  type IpTypeSettings,
} from "@/utils/ipType";

/**
 * 保存接口接收整份设置；先取服务端最新值，只合并 `ipType.results`，
 * 避免覆盖其他页面或三网回程检测刚保存的配置。
 */
export async function saveIpTypeResults(
  theme: string,
  results: Record<string, IpTypeNodeResult>,
): Promise<IpTypeSettings | null> {
  if (Object.keys(results).length === 0) return null;
  const latest = await getPublic();
  if (latest.theme !== theme) throw new Error("站点主题已切换，请刷新页面后重试。");
  const current = normalizeIpTypeSettings(latest.theme_settings?.[IP_TYPE_SETTINGS_KEY]);
  const next: IpTypeSettings = { results: { ...current.results, ...results } };
  await saveThemeSettings(theme, { ...(latest.theme_settings ?? {}), [IP_TYPE_SETTINGS_KEY]: next });
  return next;
}

// ---------------------------------------------------------------------------
// 管理员浏览器本地记录（不公开）：记下每台节点查询时用的 IP 和结果状态，用来
// 发现 IP 变更、避免反复查询失败或被排除的节点。
// ---------------------------------------------------------------------------

const LOCAL_STATE_KEY = "luminaplus:ip-type-probe";

export type IpTypeLocalStatus = "ok" | "failed" | "excluded" | "unknown";

export interface IpTypeLocalEntry {
  ip: string;
  status: IpTypeLocalStatus;
  /** Unix 秒。 */
  at: number;
}

export interface IpTypeLocalState {
  nodes: Record<string, IpTypeLocalEntry>;
  /** 插件当天额度用完或限流时，在这个时间（Unix 秒）之前不再查询。 */
  pausedUntil?: number;
}

export function readIpTypeLocalState(): IpTypeLocalState {
  try {
    const raw = JSON.parse(window.localStorage.getItem(LOCAL_STATE_KEY) ?? "null") as unknown;
    if (raw && typeof raw === "object") {
      const value = raw as Partial<IpTypeLocalState>;
      return {
        nodes: value.nodes && typeof value.nodes === "object" ? value.nodes : {},
        ...(typeof value.pausedUntil === "number" ? { pausedUntil: value.pausedUntil } : {}),
      };
    }
  } catch {
    // 存储不可用或内容损坏时从空状态开始。
  }
  return { nodes: {} };
}

export function writeIpTypeLocalState(state: IpTypeLocalState) {
  try {
    window.localStorage.setItem(LOCAL_STATE_KEY, JSON.stringify(state));
  } catch {
    // 忽略：最坏情况是下次多查一次，插件自身有缓存。
  }
}

/** 查询失败、或插件给不出判断时，隔多久再试。 */
const RETRY_AFTER_SECONDS: Readonly<Record<Exclude<IpTypeLocalStatus, "ok">, number>> = {
  failed: 6 * 3600,
  unknown: 7 * 86400,
  excluded: 30 * 86400,
};

/**
 * 这台节点现在需不需要查询：
 * - 还没有公开结果，且本地没有近期的失败 / 排除记录；
 * - 或者已有结果，但本地记录显示节点的 IPv4 变了。
 */
export function needsIpTypeProbe(
  ipv4: string,
  hasResult: boolean,
  local: IpTypeLocalEntry | undefined,
  nowSeconds: number,
): boolean {
  if (!ipv4) return false;
  if (local && local.ip !== ipv4) return true;
  if (hasResult) return false;
  if (!local || local.status === "ok") return true;
  return nowSeconds - local.at >= RETRY_AFTER_SECONDS[local.status];
}
