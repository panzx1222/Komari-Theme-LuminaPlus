import { describe, expect, it } from "vitest";
import {
  buildBackRouteCommand,
  buildBackRouteResult,
  carrierFromTaskName,
  classifyBackRoute,
  findTransitAsn,
  formatBackRouteBadge,
  isBackRouteAutoDue,
  isMainlandChinaRegion,
  nextBackRouteAutoAt,
  normalizeBackRouteSettings,
  parseBackRouteOutput,
  resolveBackboneAsn,
  type BackRouteHop,
} from "@/utils/backRoute";

/** 构造跳点：`[asn, 是否大陆]`，asn 为 null 表示该跳没有 ASN。 */
const hops = (...items: [number | null, boolean?][]): BackRouteHop[] =>
  items.map(([asn, mainland], index) => ({
    ttl: index + 1,
    ip: `10.0.0.${index + 1}`,
    asn,
    mainland: mainland === true,
  }));

/** nexttrace `--raw` 一行：ttl|ip|host|rtt|asn|国家|省|市|区|owner|lat|lng */
function nt(ttl: number, ip: string, asn: string, country = "", province = "", owner = "") {
  return `${ttl}|${ip}|host|1.23|${asn}|${country}|${province}|||${owner}|0.0|0.0`;
}

const NEXTTRACE_OUTPUT = [
  "__LP_ROUTE_TOOL_nexttrace__",
  "__LP_ROUTE_SECTION_ct__",
  "traceroute to 1.2.3.4, 30 hops max, 52 bytes payload",
  nt(1, "10.0.0.1", ""),
  nt(2, "103.1.1.1", "17676", "日本", "东京"),
  "3|*||||||",
  nt(4, "202.97.1.1", "4134", "中国", "广东"),
  nt(4, "202.97.9.9", "4134", "中国", "广东"),
  nt(5, "113.96.1.1", "4134", "中国", "广东"),
  "__LP_ROUTE_SECTION_cu__",
  nt(1, "10.0.0.1", ""),
  nt(2, "38.1.1.1", "979", "美国"),
  nt(3, "218.105.1.1", "9929", "中国", "广东"),
  nt(4, "218.105.2.1", "9929", "中国", "广东"),
  "__LP_ROUTE_SECTION_cm__",
  nt(1, "10.0.0.1", ""),
  nt(2, "223.119.8.1", "58807", "中国", "香港"),
  nt(3, "221.183.1.1", "9808", "中国", "广东"),
  nt(4, "120.1.1.1", "56040", "中国", "广东"),
].join("\n");

describe("backRoute classification (NodeQuality rules)", () => {
  it("resolves backbone ASNs from IPv4 prefixes", () => {
    expect(resolveBackboneAsn("59.43.1.1")).toBe(4809);
    expect(resolveBackboneAsn("223.119.8.1")).toBe(58807);
    expect(resolveBackboneAsn("223.119.50.1")).toBe(58453);
    // 按点分段比对，不会把 111.240.x 误判成 111.24。
    expect(resolveBackboneAsn("111.240.1.1")).toBeNull();
  });

  it("names the line after the first mainland hop", () => {
    expect(classifyBackRoute("ct", hops([3356], [4134, true], [4134, true]))).toBe("163");
    // 只有一跳 AS4134 也按 NodeQuality 判 163，不再显示「163?」。
    expect(classifyBackRoute("ct", hops([2914], [4134, true], [4812, true]))).toBe("163");
    expect(classifyBackRoute("ct", hops([979], [4809, true], [4809, true]))).toBe("CN2GIA");
    // 境外的 AS4134（电信美洲）不算 163；大陆境内的 163 在 CN2 之前才判 CN2GT。
    expect(classifyBackRoute("ct", hops([4134], [4809, true], [4809, true]))).toBe("CN2GIA");
    expect(
      classifyBackRoute("ct", hops([2914], [4812, true], [4134, true], [4809, true], [4812, true])),
    ).toBe("CN2GT");
    expect(classifyBackRoute("cu", hops([2497], [4837, true], [4837, true]))).toBe("4837");
    expect(classifyBackRoute("cu", hops([10099], [4837, true], [17816, true]))).toBe("10099");
    expect(classifyBackRoute("cm", hops([3356], [58453, true], [9808, true]))).toBe("CMI");
    expect(classifyBackRoute("cm", hops([58807], [9808, true], [56040, true]))).toBe("CMIN2");
  });

  it("skips Softbank on the border hop", () => {
    expect(classifyBackRoute("ct", hops([2914], [17676, true], [4134, true], [4134, true]))).toBe("163");
  });

  it("falls back to any backbone ASN when the first mainland hop is provincial", () => {
    expect(classifyBackRoute("ct", hops([2914], [4812, true], [4134, true], [4812, true]))).toBe("163");
    expect(classifyBackRoute("cm", hops([3356], [56040, true], [58453, true], [56040, true]))).toBe("CMI");
    expect(classifyBackRoute("ct", hops([2914], [4812, true], [4812, true]))).toBe("NoData");
  });

  it("reports hidden routes when nothing inside the mainland is visible", () => {
    expect(classifyBackRoute("ct", hops([2914], [null], [4812, true]))).toBe("Hidden");
    expect(classifyBackRoute("ct", hops([2914], [null]))).toBe("Hidden");
  });

  it("uses backbone ASNs as the mainland entry when there is no geo data", () => {
    expect(classifyBackRoute("ct", hops([null], [4809], [4809], [4134]))).toBe("CN2GIA");
  });

  it("finds the last foreign ASN before the mainland", () => {
    expect(findTransitAsn(hops([null], [2497], [null], [4837, true], [4837, true]))).toBe(2497);
    expect(findTransitAsn(hops([4134, true], [4134, true]))).toBeNull();
    expect(findTransitAsn(hops([3356]))).toBeNull();
  });
});

describe("backRoute output parsing", () => {
  it("parses nexttrace raw sections and builds a result", () => {
    const parsed = parseBackRouteOutput(NEXTTRACE_OUTPUT);
    expect(parsed.tool).toBe("nexttrace");
    // 同一跳的第二条记录被忽略，"*" 跳被跳过。
    expect(parsed.carriers.ct?.map((hop) => hop.ttl)).toEqual([1, 2, 4, 5]);
    // 香港不算中国大陆。
    expect(parsed.carriers.cm?.map((hop) => hop.mainland)).toEqual([false, false, true, true]);

    const outcome = buildBackRouteResult(NEXTTRACE_OUTPUT, "gd", 1_700_000_000);
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.result.ct).toEqual({ code: "163", transit: 17676 });
    expect(outcome.result.cu).toEqual({ code: "9929", transit: 979 });
    expect(outcome.result.cm).toEqual({ code: "CMIN2", transit: null });

    const meta = outcome.result;
    expect(formatBackRouteBadge("ct", meta.ct, meta)?.text).toBe("Softbank->163");
    // AS979 不在中转白名单里，只显示骨干。
    expect(formatBackRouteBadge("cu", meta.cu, meta)?.text).toBe("9929");
    expect(formatBackRouteBadge("cm", meta.cm, meta)?.grade).toBe("premium");
  });

  it("treats 59.43.* hops as CN2 and CTGNet owners as AS23764", () => {
    const output = [
      "__LP_ROUTE_TOOL_nexttrace__",
      "__LP_ROUTE_SECTION_ct__",
      nt(1, "10.0.0.1", ""),
      nt(2, "69.194.1.1", "", "美国", "", "CTGNet"),
      nt(3, "59.43.1.1", "", "中国", "广东"),
      nt(4, "59.43.2.1", "", "中国", "广东"),
    ].join("\n");
    expect(parseBackRouteOutput(output).carriers.ct?.map((hop) => hop.asn)).toEqual([
      null,
      23764,
      4809,
      4809,
    ]);
    const outcome = buildBackRouteResult(output, "gd", 1);
    expect(outcome.status === "ok" && outcome.result.ct?.code).toBe("CTGGIA");
  });

  it("parses traceroute fallback output without transit", () => {
    const output = [
      "__LP_ROUTE_TOOL_traceroute__",
      "__LP_ROUTE_SECTION_ct__",
      " 1  10.0.0.1  0.5 ms",
      " 2  59.43.1.1  10 ms",
      " 3  59.43.2.1  11 ms",
      " 4  113.96.1.1  12 ms",
      "__LP_ROUTE_SECTION_cu__",
      "__LP_ROUTE_SECTION_cm__",
    ].join("\n");
    const outcome = buildBackRouteResult(output, "sh", 1);
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.result.tool).toBe("traceroute");
    expect(outcome.result.ct).toEqual({ code: "CN2GIA", transit: null });
    expect(outcome.result.cu?.code).toBe("Hidden");
  });

  it("reports agent-side failures distinctly", () => {
    expect(buildBackRouteResult("Remote control is disabled.", "gd", 1).status).toBe("remote-disabled");
    expect(buildBackRouteResult("__LP_ROUTE_NO_TOOL__\n", "gd", 1).status).toBe("no-tool");
    // 三网都没认出骨干时判失败，不覆盖旧结果。
    expect(
      buildBackRouteResult("__LP_ROUTE_TOOL_nexttrace__\n__LP_ROUTE_SECTION_ct__\n", "gd", 1).status,
    ).toBe("failed");
  });
});

describe("backRoute command", () => {
  it("only contains fixed targets for the chosen region", () => {
    const command = buildBackRouteCommand("gd");
    expect(command).toContain("gd-ct-v4.ip.zstaticcdn.com");
    expect(command).toContain("gd-cm-v4.ip.zstaticcdn.com");
    expect(command).not.toContain("sh-ct");
    // NodeQuality 同款：遇到限流提示会重试。
    expect(command).toContain("try again later");
    // 非法地区回退到默认值，不会把任意字符串拼进命令。
    expect(buildBackRouteCommand("x; rm -rf /" as never)).toBe(buildBackRouteCommand("gd"));
  });
});

describe("backRoute settings", () => {
  it("drops malformed entries and keeps older codes readable", () => {
    const settings = normalizeBackRouteSettings({
      region: "bj",
      results: {
        a: { at: 1, region: "gd", tool: "nexttrace", ct: { code: "163", transit: 17676 } },
        b: { at: "bad" },
        c: { at: 2, ct: { code: "evil" } },
        d: { at: 3, ct: { code: "ct_destination_only", transit: null } },
      },
    });
    expect(settings.region).toBe("bj");
    expect(Object.keys(settings.results)).toEqual(["a", "c", "d"]);
    expect(settings.results.c?.ct).toBeUndefined();
    const legacy = settings.results.d!;
    // 旧版的「163?」现在直接显示 163。
    expect(formatBackRouteBadge("ct", legacy.ct, legacy)?.text).toBe("163");
  });

  it("maps ping task names to carriers", () => {
    expect(carrierFromTaskName("广东电信")).toBe("ct");
    expect(carrierFromTaskName("广东联通")).toBe("cu");
    expect(carrierFromTaskName("广东移动")).toBe("cm");
    expect(carrierFromTaskName("Tokyo")).toBeNull();
  });
});

describe("backRoute schedule", () => {
  const base = normalizeBackRouteSettings({ auto: { enabled: true, intervalHours: 24 } });

  it("normalizes schedule settings with safe defaults", () => {
    expect(normalizeBackRouteSettings({}).auto).toEqual({ enabled: false, intervalHours: 24, scope: "all" });
    const custom = normalizeBackRouteSettings({
      auto: { enabled: true, intervalHours: 6, scope: "tested" },
      lastAutoRun: { startedAt: 100, finishedAt: 200, ok: 3, failed: 1 },
    });
    expect(custom.auto).toEqual({ enabled: true, intervalHours: 6, scope: "tested" });
    expect(custom.lastAutoRun).toEqual({ startedAt: 100, finishedAt: 200, ok: 3, failed: 1 });
    // 不在可选列表里的间隔回退为默认值。
    expect(normalizeBackRouteSettings({ auto: { intervalHours: 1 } }).auto.intervalHours).toBe(24);
  });

  it("is due only when enabled and the interval has passed", () => {
    expect(isBackRouteAutoDue({ ...base, auto: { ...base.auto, enabled: false } }, 1000)).toBe(false);
    expect(isBackRouteAutoDue(base, 1000)).toBe(true);
    const ran = { ...base, lastAutoRun: { startedAt: 0, finishedAt: 60 } };
    expect(isBackRouteAutoDue(ran, 23 * 3600)).toBe(false);
    expect(isBackRouteAutoDue(ran, 24 * 3600)).toBe(true);
    expect(nextBackRouteAutoAt(ran)).toBe(24 * 3600);
  });

  it("waits for an unfinished run before retrying", () => {
    const unfinished = { ...base, auto: { ...base.auto, intervalHours: 6 }, lastAutoRun: { startedAt: 0 } };
    expect(isBackRouteAutoDue(unfinished, 10 * 60)).toBe(false);
    expect(isBackRouteAutoDue(unfinished, 6 * 3600)).toBe(true);
  });

  it("recognizes mainland China nodes", () => {
    expect(isMainlandChinaRegion("CN")).toBe(true);
    expect(isMainlandChinaRegion("🇨🇳")).toBe(true);
    expect(isMainlandChinaRegion("HK")).toBe(false);
  });
});

describe("backRoute CN2 refinement", () => {
  const trace = (...lines: string[]) =>
    ["__LP_ROUTE_TOOL_nexttrace__", "__LP_ROUTE_SECTION_ct__", ...lines].join("\n");
  const codeOf = (output: string) => {
    const outcome = buildBackRouteResult(output, "gd", 1);
    return outcome.status === "ok" ? outcome.result.ct?.code : outcome.status;
  };

  it("reports CN2GIA when CN2 runs into the provincial network", () => {
    expect(
      codeOf(
        trace(
          nt(1, "10.0.0.1", ""),
          nt(2, "59.43.1.1", "4809", "中国", "广东"),
          nt(3, "59.43.2.1", "4809", "中国", "广东"),
          nt(4, "14.18.1.1", "4134", "中国", "广东"),
        ),
      ),
    ).toBe("CN2GIA");
  });

  it("reports CN2GT only when the 163 backbone carries the route to another province", () => {
    expect(
      codeOf(
        trace(
          nt(1, "10.0.0.1", ""),
          nt(2, "59.43.1.1", "4809", "中国", "上海"),
          nt(3, "202.97.1.1", "4134", "中国", "上海"),
          nt(4, "202.97.2.1", "4134", "中国", "广东省"),
        ),
      ),
    ).toBe("CN2GT");
    // 同省的 202.97 只是交给省网时的交接点；「广东」与「广东省」视为同一省份。
    expect(
      codeOf(
        trace(
          nt(1, "10.0.0.1", ""),
          nt(2, "59.43.1.1", "4809", "中国", "广东"),
          nt(3, "202.97.1.1", "4134", "中国", "广东省"),
          nt(4, "202.97.2.1", "4134", "中国", "广东"),
        ),
      ),
    ).toBe("CN2GIA");
  });

  it("falls back to CN2GIA when provinces are unknown", () => {
    expect(
      codeOf(
        trace(
          nt(1, "10.0.0.1", ""),
          nt(2, "59.43.1.1", "4809", "中国"),
          nt(3, "202.97.1.1", "4134", "中国", "北京"),
          nt(4, "202.97.2.1", "4134", "中国", "北京"),
        ),
      ),
    ).toBe("CN2GIA");
  });

  it("refines CN2 in the fallback path too", () => {
    // 第一跳是省网 ASN（认不出），但路由里经过了 CN2。
    expect(
      codeOf(
        trace(
          nt(1, "10.0.0.1", ""),
          nt(2, "112.1.1.1", "17621", "中国", "上海"),
          nt(3, "59.43.1.1", "4809", "中国", "上海"),
          nt(4, "202.97.1.1", "4134", "中国", "广东"),
          nt(5, "112.1.2.1", "17621", "中国", "广东"),
        ),
      ),
    ).toBe("CN2GT");
    expect(
      codeOf(
        trace(
          nt(1, "10.0.0.1", ""),
          nt(2, "59.43.1.1", "4809", "中国", "香港"),
          nt(3, "112.1.1.1", "17621", "中国", "广东"),
          nt(4, "112.1.2.1", "17621", "中国", "广东"),
        ),
      ),
    ).toBe("CN2GIA");
    expect(
      codeOf(
        trace(
          nt(1, "10.0.0.1", ""),
          nt(2, "69.194.1.1", "", "美国", "", "CTGNet"),
          nt(3, "59.43.1.1", "4809", "中国", "香港"),
          nt(4, "112.1.1.1", "17621", "中国", "广东"),
          nt(5, "112.1.2.1", "17621", "中国", "广东"),
        ),
      ),
    ).toBe("CTGGIA");
  });

  // 以下路由取自两份 NodeQuality 报告（洛杉矶 AS142111 / AS979，电信均判 CN2GIA）。
  describe("Los Angeles CN2 routes via China Telecom Americas", () => {
    const section = (carrier: "ct" | "cu" | "cm", ...lines: string[]) => {
      const output = ["__LP_ROUTE_TOOL_nexttrace__", `__LP_ROUTE_SECTION_${carrier}__`, ...lines].join("\n");
      const outcome = buildBackRouteResult(output, "gd", 1);
      return outcome.status === "ok" ? outcome.result[carrier]?.code : outcome.status;
    };
    const losAngeles = [
      nt(1, "38.105.1.1", "142111", "美国", "加利福尼亚"),
      nt(2, "10.0.0.1", ""),
      nt(4, "218.30.1.1", "4134", "美国", "加利福尼亚"),
    ];

    it("ignores the overseas AS4134 hop before CN2", () => {
      expect(
        section(
          "ct",
          ...losAngeles,
          nt(5, "59.43.1.1", "4809", "中国", "上海"),
          nt(9, "101.95.1.1", "4812", "中国", "上海"),
          nt(15, "101.226.1.1", "4812", "中国", "上海"),
        ),
      ).toBe("CN2GIA");
    });

    it("treats a same-province 202.97 hand-off as CN2GIA", () => {
      expect(
        section(
          "ct",
          nt(1, "38.244.1.1", "979", "美国", "加利福尼亚州"),
          nt(2, "10.14.1.1", ""),
          nt(4, "192.48.1.1", "", "美国", "伊利诺伊州"),
          nt(6, "59.43.1.1", "4809", "中国", "广东"),
          nt(9, "202.97.1.1", "4134", "中国", "广东"),
          nt(10, "113.96.1.1", "4134", "中国", "广东"),
          nt(16, "14.22.1.1", "58466", "中国", "广东省"),
        ),
      ).toBe("CN2GIA");
    });

    it("keeps CN2GT for China Telecom when 163 carries the route across provinces", () => {
      expect(
        section(
          "ct",
          ...losAngeles,
          nt(5, "59.43.1.1", "4809", "中国", "上海"),
          nt(9, "202.97.1.1", "4134", "中国", "北京"),
          nt(11, "219.141.1.1", "4847", "中国", "北京"),
          nt(14, "106.37.1.1", "4847", "中国", "北京"),
        ),
      ).toBe("CN2GT");
    });

    it("does not treat 202.97 as CN2GT on the way to Unicom or Mobile", () => {
      expect(
        section(
          "cu",
          ...losAngeles,
          nt(6, "59.43.1.1", "4809", "中国", "上海"),
          nt(10, "202.97.1.1", "4134", "中国", "北京"),
          nt(12, "219.158.1.1", "4837", "中国", "北京"),
          nt(13, "123.126.1.1", "4808", "中国", "北京"),
        ),
      ).toBe("CN2GIA");
      expect(
        section(
          "cm",
          ...losAngeles,
          nt(5, "59.43.1.1", "4809", "中国", "香港"),
          nt(7, "59.43.2.1", "4809", "中国", "广东"),
          nt(8, "202.97.1.1", "4134", "中国", "广东"),
          nt(12, "221.183.1.1", "9808", "中国", "广东"),
          nt(13, "120.198.1.1", "56040", "中国", "广东"),
        ),
      ).toBe("CN2GIA");
    });
  });
});
