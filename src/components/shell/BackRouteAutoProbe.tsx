import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { useBackRouteSettings } from "@/hooks/useBackRoutes";
import { usePublicConfig } from "@/hooks/usePublicConfig";
import { getAdminClients } from "@/services/api";
import {
  claimBackRouteAutoRun,
  finishBackRouteAutoRun,
  probeAndSaveBackRoutes,
} from "@/services/backRouteProbe";
import { isBackRouteAutoDue, isMainlandChinaRegion } from "@/utils/backRoute";

/** 首次检查延后一点，避开页面刚打开时的数据加载高峰。 */
const FIRST_CHECK_DELAY_MS = 20_000;
const CHECK_INTERVAL_MS = 5 * 60_000;
/** 同一浏览器多个标签页之间的互斥，避免各自都去占位。 */
const TAB_LOCK_KEY = "luminaplus:back-route-auto-lock";
const TAB_LOCK_TTL_MS = 10 * 60_000;

function acquireTabLock(): boolean {
  try {
    const now = Date.now();
    const held = Number(window.localStorage.getItem(TAB_LOCK_KEY) ?? 0);
    if (Number.isFinite(held) && now - held < TAB_LOCK_TTL_MS) return false;
    window.localStorage.setItem(TAB_LOCK_KEY, String(now));
    return true;
  } catch {
    // 存储不可用（隐私模式等）时不做标签页互斥，仍由服务端占位兜底。
    return true;
  }
}

function releaseTabLock() {
  try {
    window.localStorage.removeItem(TAB_LOCK_KEY);
  } catch {
    // 忽略。
  }
}

/**
 * 三网回程定时检测。主题没有后端，Komari 也不能定时下发远程执行，所以由「打开着
 * 本站页面的已登录管理员浏览器」来驱动：每 5 分钟看一次是否到期，到期就检测并保存。
 * 不渲染任何内容。
 */
export function BackRouteAutoProbe() {
  const { data: me } = useAuth();
  const { data: config } = usePublicConfig();
  const settings = useBackRouteSettings();
  const queryClient = useQueryClient();
  const runningRef = useRef(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const isAdmin = me?.logged_in === true;
  const theme = config?.theme;
  const enabled = settings.auto.enabled;

  useEffect(() => {
    if (!isAdmin || !theme || !enabled) return;
    const controller = new AbortController();

    const check = async () => {
      if (runningRef.current) return;
      const nowSeconds = Math.floor(Date.now() / 1000);
      // 先用本地缓存粗筛，没到期就不发任何请求。
      if (!isBackRouteAutoDue(settingsRef.current, nowSeconds)) return;
      if (!acquireTabLock()) return;
      runningRef.current = true;
      let startedAt: number | null = null;
      try {
        const claimed = await claimBackRouteAutoRun(theme, nowSeconds);
        if (!claimed) return;
        startedAt = nowSeconds;
        await queryClient.invalidateQueries({ queryKey: ["public"] });

        const clients = await getAdminClients({ signal: controller.signal });
        const uuids = clients
          .filter((client) => !isMainlandChinaRegion(client.region))
          .filter((client) => claimed.auto.scope === "all" || claimed.results[client.uuid])
          .map((client) => client.uuid);
        if (uuids.length === 0) {
          await finishBackRouteAutoRun(theme, startedAt, { ok: 0, failed: 0 });
          return;
        }
        const summary = await probeAndSaveBackRoutes(theme, uuids, claimed.region, {
          signal: controller.signal,
        });
        await finishBackRouteAutoRun(theme, startedAt, summary);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (startedAt != null) {
          const message = error instanceof Error ? error.message : "定时检测失败";
          await finishBackRouteAutoRun(theme, startedAt, { error: message }).catch(() => undefined);
        }
      } finally {
        runningRef.current = false;
        releaseTabLock();
        if (!controller.signal.aborted) {
          void queryClient.invalidateQueries({ queryKey: ["public"] });
        }
      }
    };

    const first = window.setTimeout(() => void check(), FIRST_CHECK_DELAY_MS);
    const timer = window.setInterval(() => void check(), CHECK_INTERVAL_MS);
    return () => {
      controller.abort();
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [enabled, isAdmin, queryClient, theme]);

  return null;
}
