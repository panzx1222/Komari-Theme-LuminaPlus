import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { useIpTypeSettings } from "@/hooks/useIpTypes";
import { usePublicConfig } from "@/hooks/usePublicConfig";
import { getNodes } from "@/services/api";
import { getIpInfo, getIpInfoStatus } from "@/services/ipInfo";
import {
  needsIpTypeProbe,
  readIpTypeLocalState,
  saveIpTypeResults,
  writeIpTypeLocalState,
} from "@/services/ipTypeProbe";
import { getCountryCodeFromRegion } from "@/utils/geo";
import { ipTypeFromLookup, type IpTypeNodeResult } from "@/utils/ipType";

/** 首次检查延后一点，避开页面刚打开时的数据加载高峰，也错开三网回程的定时检测。 */
const FIRST_CHECK_DELAY_MS = 30_000;
const CHECK_INTERVAL_MS = 10 * 60_000;
/** 插件对每个调用方每分钟最多放行 6 次未命中缓存的查询，留点余量。 */
const LOOKUP_GAP_MS = 11_000;
/** 每攒够这么多条结果就保存一次，中途关掉页面也不会白查。 */
const SAVE_EVERY = 5;
/** 被插件限流（含当天额度用完）后暂停多久。 */
const RATE_LIMIT_PAUSE_SECONDS = 3600;
const TAB_LOCK_KEY = "luminaplus:ip-type-auto-lock";
const TAB_LOCK_TTL_MS = 15 * 60_000;

function acquireTabLock(): boolean {
  try {
    const now = Date.now();
    const held = Number(window.localStorage.getItem(TAB_LOCK_KEY) ?? 0);
    if (Number.isFinite(held) && now - held < TAB_LOCK_TTL_MS) return false;
    window.localStorage.setItem(TAB_LOCK_KEY, String(now));
    return true;
  } catch {
    return true;
  }
}

/** 节点多时一轮可能超过锁的有效期，每查一台续一次。 */
function renewTabLock() {
  try {
    window.localStorage.setItem(TAB_LOCK_KEY, String(Date.now()));
  } catch {
    // 忽略。
  }
}

function releaseTabLock() {
  try {
    window.localStorage.removeItem(TAB_LOCK_KEY);
  } catch {
    // 忽略。
  }
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

function cleanIpv4(value: string | null | undefined): string {
  const address = String(value ?? "").trim();
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(address) ? address : "";
}

/**
 * IP 类型自动检测：每台服务器的 IPv4 只查一次（换 IP 后重查），新加入的服务器会被自动
 * 发现。主题没有后端、插件也只对管理员开放，所以由「打开着本站页面的已登录管理员浏览器」
 * 在后台完成，没装插件时什么也不做。不渲染任何内容。
 */
export function IpTypeAutoProbe() {
  const { data: me } = useAuth();
  const { data: config } = usePublicConfig();
  const settings = useIpTypeSettings();
  const queryClient = useQueryClient();
  const runningRef = useRef(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const isAdmin = me?.logged_in === true;
  const theme = config?.theme;

  useEffect(() => {
    if (!isAdmin || !theme) return;
    const controller = new AbortController();
    const { signal } = controller;

    const check = async () => {
      if (runningRef.current) return;
      const local = readIpTypeLocalState();
      if (local.pausedUntil && Date.now() / 1000 < local.pausedUntil) return;
      if (!acquireTabLock()) return;
      runningRef.current = true;
      const pending: Record<string, IpTypeNodeResult> = {};
      const flush = async () => {
        const batch = { ...pending };
        for (const uuid of Object.keys(batch)) delete pending[uuid];
        if (await saveIpTypeResults(theme, batch)) {
          await queryClient.invalidateQueries({ queryKey: ["public"] });
        }
      };
      try {
        const status = await getIpInfoStatus(signal).catch(() => null);
        if (!status?.available) return;

        const nowSeconds = Math.floor(Date.now() / 1000);
        const results = settingsRef.current.results;
        const nodes = (await getNodes({ signal })).flatMap((node) => {
          const ipv4 = cleanIpv4(node.ipv4);
          // 插件不查询中国大陆 IP，地区已知是 CN 的节点直接跳过。
          if (!ipv4 || getCountryCodeFromRegion(node.region) === "CN") return [];
          return needsIpTypeProbe(ipv4, Boolean(results[node.uuid]), local.nodes[node.uuid], nowSeconds)
            ? [{ uuid: node.uuid, ipv4 }]
            : [];
        });

        for (const [index, node] of nodes.entries()) {
          if (index > 0) await sleep(LOOKUP_GAP_MS, signal);
          renewTabLock();
          const at = Math.floor(Date.now() / 1000);
          try {
            const lookup = await getIpInfo(node.uuid, node.ipv4, signal);
            const outcome = ipTypeFromLookup(lookup.data, at);
            local.nodes[node.uuid] = { ip: node.ipv4, status: outcome.status, at };
            if (outcome.status === "ok") pending[node.uuid] = outcome.result;
          } catch (error) {
            if (signal.aborted) throw error;
            // 被插件限流或当天额度用完：保存已查到的结果，暂停一段时间再继续。
            if (error instanceof Error && /:\s*429\b/.test(error.message)) {
              local.pausedUntil = at + RATE_LIMIT_PAUSE_SECONDS;
              break;
            }
            local.nodes[node.uuid] = { ip: node.ipv4, status: "failed", at };
          } finally {
            writeIpTypeLocalState(local);
          }
          if (Object.keys(pending).length >= SAVE_EVERY) await flush();
        }
        writeIpTypeLocalState(local);
        await flush();
      } catch {
        // 下一轮再试；已查到但没保存的结果，本地记录会让它在下一轮重新查询并保存。
        for (const uuid of Object.keys(pending)) delete local.nodes[uuid];
        writeIpTypeLocalState(local);
      } finally {
        runningRef.current = false;
        releaseTabLock();
      }
    };

    const first = window.setTimeout(() => void check(), FIRST_CHECK_DELAY_MS);
    const timer = window.setInterval(() => void check(), CHECK_INTERVAL_MS);
    return () => {
      controller.abort();
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [isAdmin, queryClient, theme]);

  return null;
}
