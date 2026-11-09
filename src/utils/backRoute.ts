/**
 * 三网回程线路：采集命令、输出解析、线路判定与展示格式。
 *
 * 判定规则移植自 yyy622hhh/komari-theme-transit 的 `src/utils/routeClassification.ts`
 * （MIT License, Copyright (c) 2026 yyy622hhh; Copyright (c) 2025 Tony Liu），
 * 其规则又来自 oneclickvirt/backtrace（NodeQuality 三网回程检测底层用的同一套）。
 *
 * 与 Transit 的差异：采集优先使用 nexttrace `--raw`，它逐跳给出 ASN，因此还能识别
 * 进入国内骨干前最后一个境外中转商（Softbank / IIJ / Level3 等），展示为
 * `Softbank→163`。只有中转商在白名单里才显示，例如 AS979 → CN2GIA 只显示 `CN2GIA`。
 * 节点没有 nexttrace 且无法下载时回退到系统 traceroute，此时只能判骨干、不判中转。
 *
 * 浏览器拿不到逐跳信息，traceroute 只能在节点上跑：主题通过 Komari 的
 * `admin:exec` 下发下面的固定命令，再把 stdout 拿回来解析。
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

/** 境外中转商白名单：只有这些出现在国内骨干之前时才显示 `中转→骨干`。 */
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
 * 2. 三网并行追踪，nexttrace 被 API 限流时重试一次。
 * 3. 都没有时回退到 traceroute（ICMP 优先，失败再 UDP）。
 */
export function buildBackRouteCommand(region: BackRouteRegion): string {
  const safeRegion: BackRouteRegion = isBackRouteRegion(region) ? region : DEFAULT_BACK_ROUTE_REGION;
  const targets = regionTargets(safeRegion);
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
    ...BACK_ROUTE_CARRIERS.map(
      (carrier) =>
        `  ( timeout 90 "$NT" -4 --tcp -p 80 -q 3 -m 30 --raw ${targets[carrier]} >"$D/${carrier}" 2>&1; ` +
        `grep -q '|' "$D/${carrier}" || { sleep 5; timeout 90 "$NT" -4 --tcp -p 80 -q 3 -m 30 --raw ${targets[carrier]} >"$D/${carrier}" 2>&1; } ) &`,
    ),
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
  /** 该跳出现过的 ASN（nexttrace 给出的 + 骨干前缀兜底），去重。 */
  asns: number[];
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

function addHop(hops: Map<number, Set<number>>, ttl: number, asns: (number | null)[]) {
  let set = hops.get(ttl);
  if (!set) {
    set = new Set();
    hops.set(ttl, set);
  }
  for (const asn of asns) if (asn != null) set.add(asn);
}

const TRACEROUTE_HOP_PATTERN = /^\s*(\d+)\s+((?:\d{1,3}\.){3}\d{1,3})\b/;

/** 解析 nexttrace `--raw`（`ttl|ip|host|rtt|asn|...`）或 traceroute `-n` 的输出。 */
export function parseBackRouteOutput(output: string): ParsedBackRouteOutput {
  const result: ParsedBackRouteOutput = { tool: null, carriers: {} };
  let current: BackRouteCarrier | null = null;
  let hops = new Map<number, Set<number>>();

  const flush = () => {
    if (!current) return;
    result.carriers[current] = [...hops.entries()]
      .sort(([left], [right]) => left - right)
      .map(([ttl, asns]) => ({ ttl, asns: [...asns] }));
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
      if (!Number.isInteger(ttl) || ttl <= 0 || !ip || ip === "*") continue;
      addHop(hops, ttl, [parseAsn(fields[4]), resolveBackboneAsn(ip)]);
      continue;
    }
    const matched = TRACEROUTE_HOP_PATTERN.exec(line);
    if (matched) {
      addHop(hops, Number(matched[1]), [resolveBackboneAsn(matched[2]!)]);
    }
  }
  flush();
  return result;
}

// ---------------------------------------------------------------------------
// 线路判定（移植自 Transit / backtrace，code 与上游一致）
// ---------------------------------------------------------------------------

interface RouteCodeInfo {
  /** 卡片上显示的短名，省略运营商前缀（行名已经是「广东电信」）。 */
  short: string;
  grade: BackRouteGrade | null;
}

const ROUTE_CODE_INFO: Readonly<Record<string, RouteCodeInfo>> = {
  ct_cn2_gia: { short: "CN2GIA", grade: "premium" },
  ct_cn2_gt: { short: "CN2GT", grade: "good" },
  ct_cn2_mixed: { short: "CN2混合", grade: "good" },
  ct_ctgnet: { short: "CTGNET", grade: "premium" },
  ct_163: { short: "163", grade: "normal" },
  ct_destination_only: { short: "163?", grade: null },
  ct_unknown: { short: "未知", grade: null },
  cu_9929: { short: "9929", grade: "premium" },
  cu_9929_mixed: { short: "9929混合", grade: "good" },
  cu_cug: { short: "CUG", grade: "good" },
  cu_4837: { short: "4837", grade: "normal" },
  cu_destination_only: { short: "4837?", grade: null },
  cu_unknown: { short: "未知", grade: null },
  cm_cmin2: { short: "CMIN2", grade: "premium" },
  cm_cmin2_mixed: { short: "CMIN2混合", grade: "good" },
  cm_cmi: { short: "CMI", grade: "normal" },
  cm_cmnet: { short: "CMNET", grade: "normal" },
  cm_unknown: { short: "未知", grade: null },
};

export function isKnownRouteCode(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(ROUTE_CODE_INFO, code);
}

/** 返回 `[首次出现的位置, 出现的跳数]`，未出现为 `[-1, 0]`。 */
function asnPosition(hops: readonly BackRouteHop[], target: number): [number, number] {
  let first = -1;
  let count = 0;
  hops.forEach((hop, index) => {
    if (!hop.asns.includes(target)) return;
    if (first < 0) first = index;
    count += 1;
  });
  return [first, count];
}

function classifyTelecom(hops: readonly BackRouteHop[]): string {
  const [cn2Index, cn2Hops] = asnPosition(hops, 4809);
  const [ct163Index, ct163Hops] = asnPosition(hops, 4134);
  const [ctgIndex] = asnPosition(hops, 23764);
  if (cn2Index >= 0) {
    // 只出现一跳 CN2 不足以和 GT 区分。
    if (cn2Hops < 2) return "ct_cn2_mixed";
    if (ct163Index < 0 || (cn2Index < ct163Index && ct163Hops <= 1)) return "ct_cn2_gia";
    if (cn2Index < ct163Index) return "ct_cn2_mixed";
    return "ct_cn2_gt";
  }
  if (ctgIndex >= 0) return "ct_ctgnet";
  if (ct163Index >= 0) {
    // 单独一跳 AS4134 更可能是目的网交付跳。
    return ct163Hops <= 1 ? "ct_destination_only" : "ct_163";
  }
  return "ct_unknown";
}

function classifyUnicom(hops: readonly BackRouteHop[]): string {
  const [cu9929Index] = asnPosition(hops, 9929);
  const [cugIndex] = asnPosition(hops, 10099);
  const [cu4837Index, cu4837Hops] = asnPosition(hops, 4837);
  if (cu9929Index >= 0) {
    return cu4837Index >= 0 && cu4837Index < cu9929Index ? "cu_9929_mixed" : "cu_9929";
  }
  if (cugIndex >= 0) return "cu_cug";
  if (cu4837Index >= 0) return cu4837Hops <= 1 ? "cu_destination_only" : "cu_4837";
  return "cu_unknown";
}

function classifyMobile(hops: readonly BackRouteHop[]): string {
  const [cmin2Index] = asnPosition(hops, 58807);
  const [cmiIndex] = asnPosition(hops, 58453);
  const [cmnetIndex] = asnPosition(hops, 9808);
  if (cmin2Index >= 0) {
    return cmiIndex >= 0 && cmiIndex < cmin2Index ? "cm_cmin2_mixed" : "cm_cmin2";
  }
  if (cmiIndex >= 0) return "cm_cmi";
  if (cmnetIndex >= 0) return "cm_cmnet";
  return "cm_unknown";
}

export function classifyBackRoute(carrier: BackRouteCarrier, hops: readonly BackRouteHop[]): string {
  if (carrier === "ct") return classifyTelecom(hops);
  if (carrier === "cu") return classifyUnicom(hops);
  return classifyMobile(hops);
}

/**
 * 进入国内骨干前最后一个境外 ASN（NetQuality 同款口径）。没进入国内骨干、或之前
 * 没有任何带 ASN 的境外跳时返回 null。
 */
export function findTransitAsn(hops: readonly BackRouteHop[]): number | null {
  const cnIndex = hops.findIndex((hop) => hop.asns.some((asn) => CHINA_BACKBONE_ASNS.has(asn)));
  if (cnIndex <= 0) return null;
  for (let index = cnIndex - 1; index >= 0; index--) {
    const foreign = hops[index]!.asns.find((asn) => !CHINA_BACKBONE_ASNS.has(asn));
    if (foreign != null) return foreign;
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

export interface BackRouteSettings {
  region: BackRouteRegion;
  results: Record<string, BackRouteNodeResult>;
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
  return {
    region: isBackRouteRegion(raw.region) ? raw.region : DEFAULT_BACK_ROUTE_REGION,
    results,
  };
}

// ---------------------------------------------------------------------------
// 展示
// ---------------------------------------------------------------------------

export interface BackRouteBadge {
  /** 例如 `CN2GIA`、`Softbank→163`。 */
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
  const text = transitName ? `${transitName}→${info.short}` : info.short;
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
  return transitName ? `${transitName}→${info.short}` : info.short;
}

/** 从 Ping 任务名推断运营商，例如「广东电信」→ ct。认不出返回 null。 */
export function carrierFromTaskName(name: string): BackRouteCarrier | null {
  const value = name.toLowerCase();
  if (/电信|telecom|chinanet|\bct\b/.test(value)) return "ct";
  if (/联通|unicom|\bcu\b/.test(value)) return "cu";
  if (/移动|mobile|cmcc|\bcm\b/.test(value)) return "cm";
  return null;
}
