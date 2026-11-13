/**
 * IP 类型（原生 / 广播），只看 IPv4。
 *
 * 数据来自可选的「IP 信息插件」（Komari-IP-Info）的基础查询接口。插件只对已登录管理员开放，
 * 所以由管理员浏览器在后台查询、把结果写进主题设置，再由首页展示给所有访客。
 *
 * 判定口径尽量与 NodeQuality 的 IP 质量体检（xykt/IPQuality）一致：使用地与注册地相同为
 * 原生 IP，不同为广播 IP。插件同时给出两个国家代码时按这条规则自己判定；缺少国家代码时
 * 才采用插件（Net.Coffee）给出的原生 / 广播结论。任播 IP 且缺少国家代码时不显示。
 *
 * 主题设置对访客公开，因此只保存国家代码，不保存 IP 本身。
 */

import type { IpInfoData } from "@/services/ipInfo";

export const IP_TYPE_SETTINGS_KEY = "ipType";

export type IpTypeKind = "native" | "broadcast";

export interface IpTypeNodeResult {
  type: IpTypeKind;
  /** 使用地（地理定位国家）。插件没给出时缺省。 */
  country?: string;
  /** 注册地。插件没给出时缺省。 */
  registered?: string;
  /** 检测时间（Unix 秒）。 */
  at: number;
}

export interface IpTypeSettings {
  results: Record<string, IpTypeNodeResult>;
}

function countryCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const code = value.trim().toUpperCase();
  if (code === "UK") return "GB";
  return /^[A-Z]{2}$/.test(code) ? code : undefined;
}

/** 由国家代码判定；缺一个时回退到给定的结论，都没有时返回 null。 */
function buildResult(
  country: string | undefined,
  registered: string | undefined,
  fallback: unknown,
  at: number,
): IpTypeNodeResult | null {
  let type: IpTypeKind | null = null;
  if (country && registered) type = country === registered ? "native" : "broadcast";
  else if (fallback === "native" || fallback === "broadcast") type = fallback;
  if (!type) return null;
  return {
    type,
    ...(country ? { country } : {}),
    ...(registered ? { registered } : {}),
    at,
  };
}

function normalizeResult(raw: unknown): IpTypeNodeResult | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const at = typeof value.at === "number" && Number.isFinite(value.at) ? value.at : 0;
  return buildResult(countryCode(value.country), countryCode(value.registered), value.type, at);
}

export function normalizeIpTypeSettings(raw: unknown): IpTypeSettings {
  const results: Record<string, IpTypeNodeResult> = {};
  const source =
    raw && typeof raw === "object" ? (raw as { results?: unknown }).results : undefined;
  if (source && typeof source === "object") {
    for (const [uuid, entry] of Object.entries(source as Record<string, unknown>)) {
      const result = normalizeResult(entry);
      if (result) results[uuid] = result;
    }
  }
  return { results };
}

export type IpTypeLookupOutcome =
  | { status: "ok"; result: IpTypeNodeResult }
  /** 插件排除的中国大陆 IP。 */
  | { status: "excluded" }
  /** 插件没给出可用的判断（例如任播 IP、数据源都失败）。 */
  | { status: "unknown" };

/** 把插件的基础查询结果转成要保存的 IP 类型。 */
export function ipTypeFromLookup(data: IpInfoData, nowSeconds: number): IpTypeLookupOutcome {
  if (data.excluded) return { status: "excluded" };
  if (data.address.family !== 4) return { status: "unknown" };
  const classification = data.classification;
  const country = countryCode(
    classification?.geolocated_country_code ?? data.location.country_code,
  );
  const registered = countryCode(
    classification?.registered_country_code ?? data.location.registered_country_code,
  );
  const result = buildResult(country, registered, classification?.type, nowSeconds);
  return result ? { status: "ok", result } : { status: "unknown" };
}

export const IP_TYPE_LABELS: Readonly<Record<IpTypeKind, string>> = {
  native: "原生IP",
  broadcast: "广播IP",
};

export function describeIpType(result: IpTypeNodeResult): string {
  const parts = [`IPv4 ${IP_TYPE_LABELS[result.type]}`];
  if (result.country) parts.push(`使用地 ${result.country}`);
  if (result.registered) parts.push(`注册地 ${result.registered}`);
  return parts.join(" · ");
}
