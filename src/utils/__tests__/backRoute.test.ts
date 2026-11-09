import { describe, expect, it } from "vitest";
import {
  buildBackRouteCommand,
  buildBackRouteResult,
  carrierFromTaskName,
  classifyBackRoute,
  findTransitAsn,
  formatBackRouteBadge,
  normalizeBackRouteSettings,
  parseBackRouteOutput,
  resolveBackboneAsn,
  type BackRouteHop,
} from "@/utils/backRoute";

const hops = (...asns: number[][]): BackRouteHop[] =>
  asns.map((list, index) => ({ ttl: index + 1, asns: list }));

function nt(ttl: number, ip: string, asn: string) {
  return `${ttl}|${ip}|host|1.23|${asn}|日本|东京|||Org|0.0|0.0`;
}

const NEXTTRACE_OUTPUT = [
  "__LP_ROUTE_TOOL_nexttrace__",
  "__LP_ROUTE_SECTION_ct__",
  "traceroute to 1.2.3.4, 30 hops max, 52 bytes payload",
  nt(1, "10.0.0.1", ""),
  nt(2, "103.1.1.1", "17676"),
  "3|*||||||",
  nt(4, "202.97.1.1", "4134"),
  nt(5, "202.97.2.2", "4134"),
  nt(6, "113.96.1.1", "4134"),
  "__LP_ROUTE_SECTION_cu__",
  nt(1, "10.0.0.1", ""),
  nt(2, "38.1.1.1", "979"),
  nt(3, "218.105.1.1", "9929"),
  nt(4, "218.105.2.1", "9929"),
  "__LP_ROUTE_SECTION_cm__",
  nt(1, "10.0.0.1", ""),
  nt(2, "223.119.8.1", ""),
  nt(3, "221.183.1.1", "9808"),
].join("\n");

describe("backRoute classification", () => {
  it("resolves backbone ASNs from IPv4 prefixes", () => {
    expect(resolveBackboneAsn("59.43.1.1")).toBe(4809);
    expect(resolveBackboneAsn("223.119.8.1")).toBe(58807);
    expect(resolveBackboneAsn("223.119.50.1")).toBe(58453);
    // 按点分段比对，不会把 111.240.x 误判成 111.24。
    expect(resolveBackboneAsn("111.240.1.1")).toBeNull();
  });

  it("follows the conservative Transit/backtrace rules", () => {
    expect(classifyBackRoute("ct", hops([4809], [4809], [4134]))).toBe("ct_cn2_gia");
    expect(classifyBackRoute("ct", hops([4809], [4134]))).toBe("ct_cn2_mixed");
    expect(classifyBackRoute("ct", hops([4134], [4809], [4809]))).toBe("ct_cn2_gt");
    expect(classifyBackRoute("ct", hops([4134]))).toBe("ct_destination_only");
    expect(classifyBackRoute("cu", hops([4837], [9929]))).toBe("cu_9929_mixed");
    expect(classifyBackRoute("cm", hops([58807], [9808]))).toBe("cm_cmin2");
    expect(classifyBackRoute("cm", hops([58453], [58453]))).toBe("cm_cmi");
  });

  it("finds the last foreign ASN before the China backbone", () => {
    expect(findTransitAsn(hops([], [2497], [], [4837], [4837]))).toBe(2497);
    expect(findTransitAsn(hops([4134], [4134]))).toBeNull();
    expect(findTransitAsn(hops([3356]))).toBeNull();
  });
});

describe("backRoute output parsing", () => {
  it("parses nexttrace raw sections and builds a result", () => {
    const parsed = parseBackRouteOutput(NEXTTRACE_OUTPUT);
    expect(parsed.tool).toBe("nexttrace");
    expect(parsed.carriers.ct?.map((hop) => hop.ttl)).toEqual([1, 2, 4, 5, 6]);

    const outcome = buildBackRouteResult(NEXTTRACE_OUTPUT, "gd", 1_700_000_000);
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.result.ct).toEqual({ code: "ct_163", transit: 17676 });
    expect(outcome.result.cu).toEqual({ code: "cu_9929", transit: 979 });
    expect(outcome.result.cm).toEqual({ code: "cm_cmin2", transit: null });

    const meta = outcome.result;
    expect(formatBackRouteBadge("ct", meta.ct, meta)?.text).toBe("Softbank->163");
    // AS979 不在中转白名单里，只显示骨干。
    expect(formatBackRouteBadge("cu", meta.cu, meta)?.text).toBe("9929");
    expect(formatBackRouteBadge("cm", meta.cm, meta)?.grade).toBe("premium");
  });

  it("parses traceroute fallback output without transit", () => {
    const output = [
      "__LP_ROUTE_TOOL_traceroute__",
      "__LP_ROUTE_SECTION_ct__",
      " 1  10.0.0.1  0.5 ms",
      " 2  59.43.1.1  10 ms",
      " 3  59.43.2.1  11 ms",
      "__LP_ROUTE_SECTION_cu__",
      "__LP_ROUTE_SECTION_cm__",
    ].join("\n");
    const outcome = buildBackRouteResult(output, "sh", 1);
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.result.tool).toBe("traceroute");
    expect(outcome.result.ct).toEqual({ code: "ct_cn2_gia", transit: null });
    expect(outcome.result.cu?.code).toBe("cu_unknown");
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
    // 非法地区回退到默认值，不会把任意字符串拼进命令。
    expect(buildBackRouteCommand("x; rm -rf /" as never)).toBe(buildBackRouteCommand("gd"));
  });
});

describe("backRoute settings", () => {
  it("drops malformed entries", () => {
    const settings = normalizeBackRouteSettings({
      region: "bj",
      results: {
        a: { at: 1, region: "gd", tool: "nexttrace", ct: { code: "ct_163", transit: 17676 } },
        b: { at: "bad" },
        c: { at: 2, ct: { code: "evil" } },
      },
    });
    expect(settings.region).toBe("bj");
    expect(Object.keys(settings.results)).toEqual(["a", "c"]);
    expect(settings.results.c?.ct).toBeUndefined();
  });

  it("maps ping task names to carriers", () => {
    expect(carrierFromTaskName("广东电信")).toBe("ct");
    expect(carrierFromTaskName("广东联通")).toBe("cu");
    expect(carrierFromTaskName("广东移动")).toBe("cm");
    expect(carrierFromTaskName("Tokyo")).toBeNull();
  });
});
