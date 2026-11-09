/**
 * 三网回程线路：采集命令、输出解析、线路判定与展示格式。
 *
 * 判定口径对齐 NodeQuality 的「三网回程路由」（xykt/NetQuality `nexttrace_test`）：
 * 看回程进入中国大陆后第一跳的 ASN——AS4134 → 163、AS4809 → CN2GIA、AS4837 → 4837、
 * AS9929 → 9929、AS58807 → CMIN2、AS58453/AS9808 → CMI 等；第一跳认不出时，再按整条
 * 路由出现过的骨干 ASN 兜底。境外中转取进入大陆前最后一个境外 ASN，只有在白名单里
 * （Softbank / IIJ / Level3 等）才显示为 `Softbank->163`，例如 AS979 → CN2GIA 只显示
 * `CN2GIA`。
 *
 * 采集流程参考 yyy622hhh/komari-theme-transit（MIT License, Copyright (c) 2026
 * yyy622hhh; Copyright (c) 2025 Tony Liu）：浏览器拿不到逐跳信息，主题通过 Komari 的
 * `admin:exec` 下发下面的固定命令，在节点上运行 nexttrace `--raw`，再把 stdout 拿回来
 * 解析。节点没有 nexttrace 且无法下载时回退到系统 traceroute，此时只能按骨干 IP 段
 * 判断、不判中转。
 */

export type BackRouteCarrier = "ct" | "cu" | "cm";
export type BackRouteRegion = "gd" | "sh" | "bj";
export type BackRouteTool = "nexttrace" | "traceroute";
export type BackRouteGrade = "premium" | "good" | "normal";

export const BACK_ROUTE_CARRIERS: readonly BackRouteCarrier[] = ["ct", "cu", "cm"];

export const BACK_ROUTE_CARRIER_LABELS: Readonly<Record<BackRouteCarrier, string>> = {
  ct: "电信",
  cu: "联通",
  cm: "移动",
};

export const BACK_ROUTE_REGION_LABELS: Readonly<Record<BackRouteRegion, string>> = {
  gd: "广东",
  sh: "上海",
  bj: "北京",
};

export const DEFAULT_BACK_ROUTE_REGION: BackRouteRegion = "gd";

/** 境外中转商白名单：只有这些出现在国内骨干之前时才显示 `中转->骨干`。 */
export const BACK_ROUTE_TRANSIT_NAMES: Readonly<Record<number, string>> = {
  17676: "Softbank",
  2497: "IIJ",
  3356: "Level3",
  2914: "NTT",
  2516: "KDDI",
  4713: "OCN",
  1299: "Arelion",
  174: "Cogent",
  6939: "HE",
  3257: "GTT",
  6461: "Zayo",
  6453: "Tata",
  3491: "PCCW",
  4637: "Telstra",
  7473: "Singtel",
};

// ---------------------------------------------------------------------------
// 骨干网 ASN 识别（IPv4 前缀兜底，traceroute 回退路径和 nexttrace 漏标 ASN 时使用）
// ---------------------------------------------------------------------------

/** 国内骨干与教育/科研网 ASN；第一次出现即视为「进入国内」。 */
const CHINA_BACKBONE_ASNS = new Set([
  4134, 4809, 23764, 4837, 9929, 10099, 58453, 58807, 9808, 4538, 7497, 4808,
]);

const ROUTE_ASN_PREFIXES: ReadonlyArray<readonly [readonly number[], number]> = [
  [[59, 43], 4809],
  [[202, 97], 4134],
  [[218, 105], 9929],
  [[210, 51], 9929],
  [[202, 77], 10099],
  [[43, 252], 10099],
  [[61, 14], 10099],
  [[219, 158], 4837],
  [[223, 118], 58453],
  [[223, 119], 58453],
  [[223, 120], 58453],
  [[223, 121], 58453],
  [[221, 183], 9808],
  [[111, 24], 9808],
  [[69, 194], 23764],
  [[203, 22], 23764],
];

function parseIpv4Octets(value: string): number[] | null {
  const parts = value.trim().split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    octets.push(octet);
  }
  return octets;
}

/** CMIN2（AS58807）与 CMI（AS58453）在 223/8 内交错，只能按第三段细分。 */
function isCmin2Ipv4(octets: readonly number[]): boolean {
  const [first, second, third] = octets as [number, number, number, number];
  if (first !== 223) return false;
  if (second === 118 && third === 32) return true;
  if (second === 120 && third >= 128) return true;
  if (second !== 119) return false;
  return (
    third === 8 ||
    third === 9 ||
    (third >= 10 && third <= 15) ||
    (third >= 26 && third <= 29) ||
    (third >= 32 && third <= 37) ||
    third === 74 ||
    third === 75 ||
    third === 88 ||
    third === 89 ||
    third === 100 ||
    third === 252 ||
    third === 253
  );
}

/** 把跳点 IPv4 映射成骨干网 ASN，认不出返回 null。 */
export function resolveBackboneAsn(ip: string): number | null {
  const octets = parseIpv4Octets(ip);
  if (!octets) return null;
  if (isCmin2Ipv4(octets)) return 58807;
  for (const [prefix, asn] of ROUTE_ASN_PREFIXES) {
    if (prefix.every((value, index) => octets[index] === value)) return asn;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 采集命令
// ---------------------------------------------------------------------------

export const BACK_ROUTE_NO_TOOL_MARKER = "__LP_ROUTE_NO_TOOL__";
const TOOL_MARKER_PREFIX = "__LP_ROUTE_TOOL_";
const SECTION_MARKER_PREFIX = "__LP_ROUTE_SECTION_";
const REMOTE_DISABLED_TEXT = "Remote control is disabled.";

/** 与 Komari agent `Remote control is disabled.` 回执对应的标记。 */
export function isRemoteControlDisabledOutput(output: string): boolean {
  return output.includes(REMOTE_DISABLED_TEXT);
}

function regionTargets(region: BackRouteRegion): Record<BackRouteCarrier, string> {
  return {
    ct: `${region}-ct-v4.ip.zstaticcdn.com`,
    cu: `${region}-cu-v4.ip.zstaticcdn.com`,
    cm: `${region}-cm-v4.ip.zstaticcdn.com`,
  };
}

/**
 * 生成下发给节点的命令（agent 以 `sh -s` 执行，必须是 POSIX sh）。
 *
 * 这条命令以 root 在每台服务器上运行，所以它只由编译期常量组成：目标域名来自上面
 * 的固定表，地区只能是 `gd`/`sh`/`bj` 三者之一；节点 UUID 只进 `clients` 数组，
 * 绝不进命令字符串。
 *
 * 1. 没有 nexttrace 时，从 GitHub Release 下载固定版本 v1.3.7（与 NodeQuality 相同）。
 * 2. 三网错开 2 秒并行追踪。与 NodeQuality 相同：nexttrace 的 IP 归属 API 被限流时
 *    输出里会有「try again later」，或者根本没跑出跳点，这两种情况等 5 秒重试，最多 5 次。
 * 3. 都没有时回退到 traceroute（ICMP 优先，失败再 UDP）。
 */
export function buildBackRouteCommand(region: BackRouteRegion): string {
  const safeRegion: BackRouteRegion = isBackRouteRegion(region) ? region : DEFAULT_BACK_ROUTE_REGION;
  const targets = regionTargets(safeRegion);
  const nexttraceJob = (carrier: BackRouteCarrier, delay: number) =>
    `  ( sleep ${delay}; N=0; while [ "$N" -lt 5 ]; do ` +
    `timeout 60 "$NT" -4 --tcp -p 80 -q 3 -m 30 --raw ${targets[carrier]} >"$D/${carrier}" 2>&1; ` +
    `if grep -q '|' "$D/${carrier}" && ! grep -qi 'try again later' "$D/${carrier}"; then break; fi; ` +
    `N=$((N+1)); sleep 5; done ) &`;
  const lines = [
    "NT=$(command -v nexttrace 2>/dev/null || true)",
    'if [ -z "$NT" ]; then',
    '  case "$(uname -m)" in x86_64|amd64) A=amd64 ;; aarch64|arm64) A=arm64 ;; *) A= ;; esac',
    '  if [ -n "$A" ]; then',
    '    U="https://github.com/nxtrace/NTrace-core/releases/download/v1.3.7/nexttrace_linux_$A"',
    "    T=$(mktemp)",
    '    if curl -fsSL "$U" -o "$T" 2>/dev/null || wget -qO "$T" "$U" 2>/dev/null; then',
    '      chmod 755 "$T" && mv -f "$T" /usr/local/bin/nexttrace && NT=/usr/local/bin/nexttrace',
    "    fi",
    '    rm -f "$T"',
    "  fi",
    "fi",
    "D=$(mktemp -d)",
    'if [ -n "$NT" ]; then',
    `  echo ${TOOL_MARKER_PREFIX}nexttrace__`,
    nexttraceJob("ct", 0),
    nexttraceJob("cu", 2),
    nexttraceJob("cm", 4),
    "  wait",
    "elif command -v traceroute >/dev/null 2>&1; then",
    `  echo ${TOOL_MARKER_PREFIX}traceroute__`,
    ...BACK_ROUTE_CARRIERS.map(
      (carrier) =>
        `  ( timeout 90 traceroute -I -n -q 1 -w 1 -m 30 ${targets[carrier]} >"$D/${carrier}" 2>/dev/null || ` +
        `timeout 90 traceroute -n -q 1 -w 1 -m 30 ${targets[carrier]} >"$D/${carrier}" 2>/dev/null ) &`,
    ),
    "  wait",
    "else",
    `  echo ${BACK_ROUTE_NO_TOOL_MARKER}`,
    "fi",
    ...BACK_ROUTE_CARRIERS.map(
      (carrier) => `echo ${SECTION_MARKER_PREFIX}${carrier}__; cat "$D/${carrier}" 2>/dev/null`,
    ),
    'rm -rf "$D"',
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 输出解析
// ---------------------------------------------------------------------------

export interface BackRouteHop {
  /** 跳数，从 1 开始。 */
  ttl: number;
  ip: string;
  /** nexttrace 给出的 ASN（59.43.* 视为 AS4809、CTGNet 视为 AS23764），缺失时用骨干前缀兜底。 */
  asn: number | null;
  /** 是否位于中国大陆：nexttrace 国家字段为「中国」且省份不是港澳台。 */
  mainland: boolean;
}

export interface ParsedBackRouteOutput {
  tool: BackRouteTool | null;
  carriers: Partial<Record<BackRouteCarrier, BackRouteHop[]>>;
}

function parseAsn(value: string | undefined): number | null {
  if (!value) return null;
  const matched = /^\s*(?:AS)?(\d{1,10})\s*$/i.exec(value);
  if (!matched) return null;
  const asn = Number(matched[1]);
  return Number.isSafeInteger(asn) && asn > 0 ? asn : null;
}

const NON_MAINLAND_PROVINCES = new Set(["香港", "澳门", "台湾"]);

function isMainlandGeo(country: string, province: string): boolean {
  const value = country.trim();
  if (!value.includes("中国") && !/^china$/i.test(value)) return false;
  return !NON_MAINLAND_PROVINCES.has(province.trim());
}

const TRACEROUTE_HOP_PATTERN = /^\s*(\d+)\s+((?:\d{1,3}\.){3}\d{1,3})\b/;

/**
 * 解析 nexttrace `--raw`（`ttl|ip|host|rtt|asn|国家|省|市|区|owner|lat|lng`）或
 * traceroute `-n` 的输出。同一跳多次探测时取第一条有地址的记录。
 */
export function parseBackRouteOutput(output: string): ParsedBackRouteOutput {
  const result: ParsedBackRouteOutput = { tool: null, carriers: {} };
  let current: BackRouteCarrier | null = null;
  let hops = new Map<number, BackRouteHop>();

  const flush = () => {
    if (!current) return;
    result.carriers[current] = [...hops.values()].sort((left, right) => left.ttl - right.ttl);
  };

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith(TOOL_MARKER_PREFIX)) {
      const tool = line.slice(TOOL_MARKER_PREFIX.length).replace(/_+$/, "");
      if (tool === "nexttrace" || tool === "traceroute") result.tool = tool;
      continue;
    }
    if (line.startsWith(SECTION_MARKER_PREFIX)) {
      flush();
      const carrier = line.slice(SECTION_MARKER_PREFIX.length).replace(/_+$/, "");
      current = (BACK_ROUTE_CARRIERS as readonly string[]).includes(carrier)
        ? (carrier as BackRouteCarrier)
        : null;
      hops = new Map();
      continue;
    }
    if (!current) continue;

    if (line.includes("|")) {
      const fields = line.split("|");
      const ttl = Number(fields[0]);
      const ip = fields[1]?.trim() ?? "";
      if (!Number.isInteger(ttl) || ttl <= 0 || !ip || ip === "*" || hops.has(ttl)) continue;
      let asn = parseAsn(fields[4]);
      if (ip.startsWith("59.43.")) asn = 4809;
      if (/CTGNet/i.test(fields[9] ?? "")) asn = 23764;
      hops.set(ttl, {
        ttl,
        ip,
        asn: asn ?? resolveBackboneAsn(ip),
        mainland: isMainlandGeo(fields[5] ?? "", fields[6] ?? ""),
      });
      continue;
    }
    const matched = TRACEROUTE_HOP_PATTERN.exec(line);
    if (matched) {
      const ttl = Number(matched[1]);
      if (hops.has(ttl)) continue;
      const ip = matched[2]!;
      hops.set(ttl, { ttl, ip, asn: resolveBackboneAsn(ip), mainland: false });
    }
  }
  flush();
  return result;
}

// ---------------------------------------------------------------------------
// 线路判定（NodeQuality / NetQuality `nexttrace_test` 口径）
// ---------------------------------------------------------------------------

interface RouteCodeInfo {
  /** 卡片上显示的短名，省略运营商前缀（行名已经是「广东电信」）。 */
  short: string;
  grade: BackRouteGrade | null;
}

const ROUTE_CODE_INFO: Readonly<Record<string, RouteCodeInfo>> = {
  // 当前口径，与 NodeQuality 输出同名。
  CN2GIA: { short: "CN2GIA", grade: "premium" },
  CN2GT: { short: "CN2GT", grade: "good" },
  CN2: { short: "CN2", grade: "good" },
  CTGGIA: { short: "CTGGIA", grade: "premium" },
  "163": { short: "163", grade: "normal" },
  "9929": { short: "9929", grade: "premium" },
  "10099": { short: "10099", grade: "good" },
  "4837": { short: "4837", grade: "normal" },
  CMIN2: { short: "CMIN2", grade: "premium" },
  CMI: { short: "CMI", grade: "normal" },
  CERNET: { short: "CERNET", grade: "normal" },
  CSTNET: { short: "CSTNET", grade: "normal" },
  Hidden: { short: "隐藏", grade: null },
  NoData: { short: "无数据", grade: null },
  // v1.3.7 / v1.3.8 保存的旧 code，读取时继续兼容。
  ct_cn2_gia: { short: "CN2GIA", grade: "premium" },
  ct_cn2_gt: { short: "CN2GT", grade: "good" },
  ct_cn2_mixed: { short: "CN2", grade: "good" },
  ct_ctgnet: { short: "CTGGIA", grade: "premium" },
  ct_163: { short: "163", grade: "normal" },
  ct_destination_only: { short: "163", grade: "normal" },
  ct_unknown: { short: "无数据", grade: null },
  cu_9929: { short: "9929", grade: "premium" },
  cu_9929_mixed: { short: "9929", grade: "premium" },
  cu_cug: { short: "10099", grade: "good" },
  cu_4837: { short: "4837", grade: "normal" },
  cu_destination_only: { short: "4837", grade: "normal" },
  cu_unknown: { short: "无数据", grade: null },
  cm_cmin2: { short: "CMIN2", grade: "premium" },
  cm_cmin2_mixed: { short: "CMIN2", grade: "premium" },
  cm_cmi: { short: "CMI", grade: "normal" },
  cm_cmnet: { short: "CMI", grade: "normal" },
  cm_unknown: { short: "无数据", grade: null },
};

export function isKnownRouteCode(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(ROUTE_CODE_INFO, code);
}

/**
 * 进入中国大陆的第一跳下标：优先用 nexttrace 的地理字段；没有地理信息时
 * （traceroute 回退）用第一个骨干 ASN 跳。找不到返回 -1。
 */
function findMainlandEntry(hops: readonly BackRouteHop[]): number {
  const byGeo = hops.findIndex((hop) => hop.mainland);
  if (byGeo >= 0) return byGeo;
  return hops.findIndex((hop) => hop.asn != null && CHINA_BACKBONE_ASNS.has(hop.asn));
}

/** 第一跳认不出时，按整条路由里出现过的骨干 ASN 兜底，顺序与 NodeQuality 相同。 */
function fallbackByAllAsns(all: ReadonlySet<number>): string | null {
  if (all.has(58807)) return "CMIN2";
  if (all.has(9929)) return "9929";
  if (all.has(10099)) return "10099";
  if (all.has(4809)) return "CN2";
  if (all.has(9808) || all.has(58453)) return "CMI";
  if (all.has(4134)) return "163";
  if (all.has(4837)) return "4837";
  return null;
}

/**
 * 按 NodeQuality 口径判定一条回程：看进入中国大陆后第一跳的 ASN。
 * `_carrier` 保留在签名里便于调用方对照，判定本身只看 ASN。
 */
export function classifyBackRoute(_carrier: BackRouteCarrier, hops: readonly BackRouteHop[]): string {
  const all = new Set(hops.map((hop) => hop.asn).filter((asn): asn is number => asn != null));
  let entry = findMainlandEntry(hops);
  // 进不了大陆，或大陆段只有最后一跳（目标本身），说明中间路由被隐藏。
  if (entry < 0 || entry === hops.length - 1) return fallbackByAllAsns(all) ?? "Hidden";
  // Softbank（AS17676）常出现在大陆边界跳上，NodeQuality 顺延一跳再看。
  if (hops[entry]!.asn === 17676 && entry + 1 < hops.length) entry += 1;

  switch (hops[entry]!.asn) {
    case 4134:
      return "163";
    case 4837:
      return entry > 0 && hops[entry - 1]!.asn === 10099 ? "10099" : "4837";
    case 58453:
      return "CMI";
    case 58807:
      return "CMIN2";
    case 9808:
      return all.has(58807) ? "CMIN2" : "CMI";
    case 9929:
      return "9929";
    case 10099:
      return all.has(9929) ? "9929" : "10099";
    case 4809: {
      if (all.has(23764)) return "CTGGIA";
      // 163 骨干出现在 CN2 之前，说明先走 163 再进 CN2，即 CN2GT。
      const cn2Index = hops.findIndex((hop) => hop.asn === 4809);
      const ct163Index = hops.findIndex((hop) => hop.asn === 4134);
      return ct163Index >= 0 && ct163Index < cn2Index ? "CN2GT" : "CN2GIA";
    }
    case 23764:
      return "CTGGIA";
    case 4538:
      return "CERNET";
    case 7497:
      return "CSTNET";
    default:
      return fallbackByAllAsns(all) ?? "NoData";
  }
}

/**
 * 进入大陆前最后一个境外 ASN（NodeQuality 同款口径）。没进入大陆、或之前没有任何
 * 带 ASN 的境外跳时返回 null。
 */
export function findTransitAsn(hops: readonly BackRouteHop[]): number | null {
  const entry = findMainlandEntry(hops);
  if (entry <= 0) return null;
  for (let index = entry - 1; index >= 0; index--) {
    const asn = hops[index]!.asn;
    if (asn != null && !CHINA_BACKBONE_ASNS.has(asn)) return asn;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 存储格式
// ---------------------------------------------------------------------------

export interface BackRouteCarrierResult {
  /** 判定 code，例如 `ct_cn2_gia`。 */
  code: string;
  /** 进入国内骨干前最后一个境外 ASN；traceroute 回退路径下为 null。 */
  transit: number | null;
}

export interface BackRouteNodeResult {
  /** 采集时间，Unix 秒。 */
  at: number;
  region: BackRouteRegion;
  tool: BackRouteTool;
  ct?: BackRouteCarrierResult;
  cu?: BackRouteCarrierResult;
  cm?: BackRouteCarrierResult;
}

/** 定时检测的节点范围：全部境外节点，或只重测已有结果的节点。 */
export type BackRouteAutoScope = "all" | "tested";

/** 可选的定时间隔（小时）。 */
export const BACK_ROUTE_AUTO_INTERVALS: readonly number[] = [6, 12, 24, 72, 168];
export const DEFAULT_BACK_ROUTE_AUTO_INTERVAL = 24;

export interface BackRouteAutoSettings {
  enabled: boolean;
  intervalHours: number;
  scope: BackRouteAutoScope;
}

export interface BackRouteAutoRun {
  /** 本轮开始时间（Unix 秒），同时充当多浏览器之间的「占位」。 */
  startedAt: number;
  /** 本轮结束时间；未结束（或中途关闭页面）时缺省。 */
  finishedAt?: number;
  ok?: number;
  failed?: number;
  /** 整轮失败时的原因，例如远程执行被拒绝。 */
  error?: string;
}

export interface BackRouteSettings {
  region: BackRouteRegion;
  results: Record<string, BackRouteNodeResult>;
  auto: BackRouteAutoSettings;
  lastAutoRun?: BackRouteAutoRun;
}

export const DEFAULT_BACK_ROUTE_AUTO: BackRouteAutoSettings = {
  enabled: false,
  intervalHours: DEFAULT_BACK_ROUTE_AUTO_INTERVAL,
  scope: "all",
};

/** 中国大陆节点到国内测速点不经过国际骨干，回程线路没有意义。 */
export function isMainlandChinaRegion(region: string): boolean {
  const value = region.trim().toUpperCase();
  return value === "CN" || value === "🇨🇳";
}

/**
 * 定时检测是否到期：距离上一轮开始已超过间隔。上一轮开始了但一直没结束（例如中途
 * 关闭了页面）时，超过 15 分钟也视为可以重来。
 */
export function isBackRouteAutoDue(settings: BackRouteSettings, nowSeconds: number): boolean {
  if (!settings.auto.enabled) return false;
  const last = settings.lastAutoRun;
  if (!last) return true;
  if (last.finishedAt == null && nowSeconds - last.startedAt < 15 * 60) return false;
  return nowSeconds - last.startedAt >= settings.auto.intervalHours * 3600;
}

/** 下一次定时检测的时间（Unix 秒）；未开启时返回 null。 */
export function nextBackRouteAutoAt(settings: BackRouteSettings): number | null {
  if (!settings.auto.enabled) return null;
  return settings.lastAutoRun ? settings.lastAutoRun.startedAt + settings.auto.intervalHours * 3600 : null;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeAutoSettings(value: unknown): BackRouteAutoSettings {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const interval = finiteNumber(raw.intervalHours);
  return {
    enabled: raw.enabled === true,
    intervalHours:
      interval != null && BACK_ROUTE_AUTO_INTERVALS.includes(interval)
        ? interval
        : DEFAULT_BACK_ROUTE_AUTO_INTERVAL,
    scope: raw.scope === "tested" ? "tested" : "all",
  };
}

function normalizeAutoRun(value: unknown): BackRouteAutoRun | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const startedAt = finiteNumber(raw.startedAt);
  if (startedAt == null) return undefined;
  const run: BackRouteAutoRun = { startedAt };
  const finishedAt = finiteNumber(raw.finishedAt);
  if (finishedAt != null) run.finishedAt = finishedAt;
  const ok = finiteNumber(raw.ok);
  if (ok != null) run.ok = ok;
  const failed = finiteNumber(raw.failed);
  if (failed != null) run.failed = failed;
  if (typeof raw.error === "string" && raw.error) run.error = raw.error.slice(0, 200);
  return run;
}

export const BACK_ROUTE_SETTINGS_KEY = "backRoute";

export function isBackRouteRegion(value: unknown): value is BackRouteRegion {
  return value === "gd" || value === "sh" || value === "bj";
}

export type BackRouteProbeOutcome =
  | { status: "ok"; result: BackRouteNodeResult }
  | { status: "remote-disabled" | "no-tool" | "failed"; detail: string };

/** 把一台节点的回执变成可保存的结果；三网一个骨干都没认出时判失败、不写回。 */
export function buildBackRouteResult(
  output: string,
  region: BackRouteRegion,
  nowSeconds: number,
): BackRouteProbeOutcome {
  if (isRemoteControlDisabledOutput(output)) {
    return { status: "remote-disabled", detail: "节点已关闭远程控制" };
  }
  if (output.includes(BACK_ROUTE_NO_TOOL_MARKER)) {
    return { status: "no-tool", detail: "节点无法下载 nexttrace，也没有 traceroute" };
  }
  const parsed = parseBackRouteOutput(output);
  if (!parsed.tool) {
    return { status: "failed", detail: "回执格式无法识别" };
  }
  const result: BackRouteNodeResult = { at: nowSeconds, region, tool: parsed.tool };
  let recognized = 0;
  for (const carrier of BACK_ROUTE_CARRIERS) {
    const hops = parsed.carriers[carrier] ?? [];
    const code = classifyBackRoute(carrier, hops);
    if (ROUTE_CODE_INFO[code]?.grade !== null) recognized += 1;
    result[carrier] = {
      code,
      transit: parsed.tool === "nexttrace" ? findTransitAsn(hops) : null,
    };
  }
  if (recognized === 0) {
    return { status: "failed", detail: "三网都没有识别到骨干网，可能被限流或网络异常" };
  }
  return { status: "ok", result };
}

function normalizeCarrierResult(value: unknown): BackRouteCarrierResult | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.code !== "string" || !isKnownRouteCode(raw.code)) return undefined;
  const transit =
    typeof raw.transit === "number" && Number.isSafeInteger(raw.transit) && raw.transit > 0
      ? raw.transit
      : null;
  return { code: raw.code, transit };
}

export function normalizeBackRouteSettings(value: unknown): BackRouteSettings {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const results: Record<string, BackRouteNodeResult> = {};
  const rawResults =
    raw.results && typeof raw.results === "object" && !Array.isArray(raw.results)
      ? (raw.results as Record<string, unknown>)
      : {};
  for (const [uuid, entry] of Object.entries(rawResults)) {
    if (!uuid || !entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    if (typeof item.at !== "number" || !Number.isFinite(item.at)) continue;
    const node: BackRouteNodeResult = {
      at: item.at,
      region: isBackRouteRegion(item.region) ? item.region : DEFAULT_BACK_ROUTE_REGION,
      tool: item.tool === "traceroute" ? "traceroute" : "nexttrace",
    };
    for (const carrier of BACK_ROUTE_CARRIERS) {
      const parsed = normalizeCarrierResult(item[carrier]);
      if (parsed) node[carrier] = parsed;
    }
    results[uuid] = node;
  }
  const lastAutoRun = normalizeAutoRun(raw.lastAutoRun);
  return {
    region: isBackRouteRegion(raw.region) ? raw.region : DEFAULT_BACK_ROUTE_REGION,
    results,
    auto: normalizeAutoSettings(raw.auto),
    ...(lastAutoRun ? { lastAutoRun } : {}),
  };
}

// ---------------------------------------------------------------------------
// 展示
// ---------------------------------------------------------------------------

export interface BackRouteBadge {
  /** 例如 `CN2GIA`、`Softbank->163`。 */
  text: string;
  grade: BackRouteGrade | null;
  /** 悬停说明。 */
  title: string;
}

export function formatBackRouteBadge(
  carrier: BackRouteCarrier,
  entry: BackRouteCarrierResult | undefined,
  node: Pick<BackRouteNodeResult, "at" | "region" | "tool">,
): BackRouteBadge | null {
  if (!entry) return null;
  const info = ROUTE_CODE_INFO[entry.code];
  // 证据不足（未知 / 仅见目的网）不在卡片上硬凑线路名。
  if (!info || info.grade === null) return null;
  const transitName = entry.transit != null ? BACK_ROUTE_TRANSIT_NAMES[entry.transit] : undefined;
  const text = transitName ? `${transitName}->${info.short}` : info.short;
  const date = new Date(node.at * 1000);
  const dateText = Number.isFinite(date.getTime())
    ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
    : "时间未知";
  const transitText = entry.transit != null ? ` · 中转 AS${entry.transit}` : "";
  return {
    text,
    grade: info.grade,
    title: `${BACK_ROUTE_REGION_LABELS[node.region]}${BACK_ROUTE_CARRIER_LABELS[carrier]}回程 ${text}${transitText} · ${node.tool} · ${dateText}`,
  };
}

/** 后台面板用：未知结果也给一个可读的短名。 */
export function describeBackRouteCode(entry: BackRouteCarrierResult | undefined): string {
  if (!entry) return "—";
  const info = ROUTE_CODE_INFO[entry.code];
  if (!info) return "—";
  const transitName = entry.transit != null ? BACK_ROUTE_TRANSIT_NAMES[entry.transit] : undefined;
  return transitName ? `${transitName}->${info.short}` : info.short;
}

/** 从 Ping 任务名推断运营商，例如「广东电信」→ ct。认不出返回 null。 */
export function carrierFromTaskName(name: string): BackRouteCarrier | null {
  const value = name.toLowerCase();
  if (/电信|telecom|chinanet|\bct\b/.test(value)) return "ct";
  if (/联通|unicom|\bcu\b/.test(value)) return "cu";
  if (/移动|mobile|cmcc|\bcm\b/.test(value)) return "cm";
  return null;
}
