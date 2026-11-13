import { describe, expect, it } from "vitest";
import { needsIpTypeProbe } from "@/services/ipTypeProbe";
import type { IpInfoData } from "@/services/ipInfo";
import { describeIpType, ipTypeFromLookup, normalizeIpTypeSettings } from "@/utils/ipType";

function lookup(overrides: {
  family?: 4 | 6;
  excluded?: boolean;
  country?: string | null;
  registered?: string | null;
  classification?: Partial<NonNullable<IpInfoData["classification"]>> | null;
}): IpInfoData {
  return {
    excluded: overrides.excluded ?? false,
    address: { value: "203.0.113.1", family: overrides.family ?? 4 },
    location: {
      country_code: overrides.country ?? null,
      registered_country_code: overrides.registered ?? null,
    },
    classification:
      overrides.classification === null
        ? undefined
        : {
            type: "unknown",
            label: null,
            geolocated_country_code: null,
            registered_country_code: null,
            confidence: null,
            source: "unavailable",
            ...overrides.classification,
          },
  } as unknown as IpInfoData;
}

describe("ipTypeFromLookup", () => {
  it("compares the geolocated and registered countries like NodeQuality", () => {
    expect(
      ipTypeFromLookup(
        lookup({ classification: { geolocated_country_code: "US", registered_country_code: "US" } }),
        100,
      ),
    ).toEqual({ status: "ok", result: { type: "native", country: "US", registered: "US", at: 100 } });
    expect(
      ipTypeFromLookup(
        lookup({ classification: { geolocated_country_code: "JP", registered_country_code: "GB" } }),
        100,
      ),
    ).toEqual({ status: "ok", result: { type: "broadcast", country: "JP", registered: "GB", at: 100 } });
  });

  it("prefers the country comparison over the provider verdict", () => {
    const outcome = ipTypeFromLookup(
      lookup({
        classification: { type: "native", geolocated_country_code: "HK", registered_country_code: "US" },
      }),
      100,
    );
    expect(outcome.status === "ok" && outcome.result.type).toBe("broadcast");
  });

  it("falls back to the location fields and then to the provider verdict", () => {
    const fromLocation = ipTypeFromLookup(lookup({ country: "de", registered: "DE", classification: null }), 1);
    expect(fromLocation.status === "ok" && fromLocation.result.type).toBe("native");
    expect(ipTypeFromLookup(lookup({ classification: { type: "broadcast" } }), 1)).toEqual({
      status: "ok",
      result: { type: "broadcast", at: 1 },
    });
  });

  it("skips anycast without countries, excluded and IPv6 addresses", () => {
    expect(ipTypeFromLookup(lookup({ classification: { type: "anycast" } }), 1).status).toBe("unknown");
    expect(ipTypeFromLookup(lookup({ excluded: true }), 1).status).toBe("excluded");
    expect(
      ipTypeFromLookup(
        lookup({ family: 6, classification: { geolocated_country_code: "US", registered_country_code: "US" } }),
        1,
      ).status,
    ).toBe("unknown");
  });
});

describe("normalizeIpTypeSettings", () => {
  it("re-derives the type from stored countries and drops invalid entries", () => {
    expect(
      normalizeIpTypeSettings({
        results: {
          a: { type: "native", country: "JP", registered: "GB", at: 5 },
          b: { type: "broadcast", at: 6 },
          c: { type: "anycast", at: 7 },
          d: "bad",
        },
      }),
    ).toEqual({
      results: {
        a: { type: "broadcast", country: "JP", registered: "GB", at: 5 },
        b: { type: "broadcast", at: 6 },
      },
    });
    expect(normalizeIpTypeSettings(undefined)).toEqual({ results: {} });
  });

  it("describes the result for the tooltip", () => {
    expect(describeIpType({ type: "broadcast", country: "JP", registered: "GB", at: 0 })).toBe(
      "IPv4 广播IP · 使用地 JP · 注册地 GB",
    );
    expect(describeIpType({ type: "native", at: 0 })).toBe("IPv4 原生IP");
  });
});

describe("needsIpTypeProbe", () => {
  const ip = "203.0.113.1";

  it("probes each node once and again only after its IPv4 changes", () => {
    expect(needsIpTypeProbe(ip, false, undefined, 0)).toBe(true);
    expect(needsIpTypeProbe(ip, true, undefined, 0)).toBe(false);
    expect(needsIpTypeProbe(ip, true, { ip, status: "ok", at: 0 }, 0)).toBe(false);
    expect(needsIpTypeProbe(ip, true, { ip: "203.0.113.9", status: "ok", at: 0 }, 0)).toBe(true);
    expect(needsIpTypeProbe("", false, undefined, 0)).toBe(false);
  });

  it("waits before retrying failed, unknown or excluded nodes", () => {
    expect(needsIpTypeProbe(ip, false, { ip, status: "failed", at: 0 }, 3600)).toBe(false);
    expect(needsIpTypeProbe(ip, false, { ip, status: "failed", at: 0 }, 6 * 3600)).toBe(true);
    expect(needsIpTypeProbe(ip, false, { ip, status: "unknown", at: 0 }, 86400)).toBe(false);
    expect(needsIpTypeProbe(ip, false, { ip, status: "excluded", at: 0 }, 7 * 86400)).toBe(false);
  });
});
