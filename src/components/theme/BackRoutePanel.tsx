import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { FileText, Radar, Trash2 } from "lucide-react";
import { Flag } from "@/components/ui/Flag";
import { useBackRouteSettings } from "@/hooks/useBackRoutes";
import {
  dispatchBackRouteProbe,
  persistBackRouteSettings,
  waitBackRouteResults,
} from "@/services/backRouteProbe";
import type { AdminClient } from "@/types/komari";
import {
  BACK_ROUTE_CARRIERS,
  BACK_ROUTE_CARRIER_LABELS,
  BACK_ROUTE_REGION_LABELS,
  describeBackRouteCode,
  formatBackRouteBadge,
  type BackRouteNodeResult,
  type BackRouteRegion,
} from "@/utils/backRoute";

type RowStatus = { state: "running" | "ok" | "error"; detail?: string };

const REGIONS: BackRouteRegion[] = ["gd", "sh", "bj"];

/** 大陆节点到国内测速点不经过国际骨干，回程线路没有意义。 */
function isMainlandChina(region: string) {
  const value = region.trim().toUpperCase();
  return value === "CN" || value === "🇨🇳";
}

function formatTestedAt(seconds: number) {
  const date = new Date(seconds * 1000);
  if (!Number.isFinite(date.getTime())) return "时间未知";
  return `${date.getMonth() + 1}-${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function RouteCells({ result }: { result: BackRouteNodeResult | undefined }) {
  if (!result) {
    return <span className="text-[11px] text-[var(--text-tertiary)]">未检测</span>;
  }
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {BACK_ROUTE_CARRIERS.map((carrier) => {
        const badge = formatBackRouteBadge(carrier, result[carrier], result);
        return (
          <span
            key={carrier}
            className="back-route-badge"
            data-grade={badge?.grade ?? "unknown"}
            title={badge?.title}
          >
            {BACK_ROUTE_CARRIER_LABELS[carrier]} {badge?.text ?? describeBackRouteCode(result[carrier])}
          </span>
        );
      })}
      <span className="text-[10.5px] text-[var(--text-tertiary)]">
        {BACK_ROUTE_REGION_LABELS[result.region]} · {formatTestedAt(result.at)}
      </span>
    </span>
  );
}

export function BackRoutePanel({
  theme,
  clients,
  clientsLoading,
}: {
  theme: string | undefined;
  clients: AdminClient[];
  clientsLoading: boolean;
}) {
  const queryClient = useQueryClient();
  const settings = useBackRouteSettings();
  const [region, setRegion] = useState<BackRouteRegion>(settings.region);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [statuses, setStatuses] = useState<Record<string, RowStatus>>({});
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 本次会话的原始回执，只存在内存里，用于排查「无数据 / 隐藏」。
  const [outputs, setOutputs] = useState<Record<string, string>>({});
  const [openOutput, setOpenOutput] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const overseas = useMemo(
    () => clients.filter((client) => !isMainlandChina(client.region)),
    [clients],
  );
  const testedCount = clients.filter((client) => settings.results[client.uuid]).length;

  const toggle = (uuid: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(uuid)) next.delete(uuid);
      else next.add(uuid);
      return next;
    });
  };

  const run = async () => {
    const uuids = [...selected];
    if (!theme || uuids.length === 0 || running) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setError(null);
    setMessage(null);
    setStatuses((current) => {
      const next = { ...current };
      for (const uuid of uuids) next[uuid] = { state: "running" };
      return next;
    });

    const okResults: Record<string, BackRouteNodeResult> = {};
    let failed = 0;
    try {
      const taskId = await dispatchBackRouteProbe(uuids, region, controller.signal);
      await waitBackRouteResults(
        taskId,
        uuids,
        region,
        (uuid, outcome, output) => {
          if (outcome.status === "ok") okResults[uuid] = outcome.result;
          else failed += 1;
          if (output) setOutputs((current) => ({ ...current, [uuid]: output }));
          setStatuses((current) => ({
            ...current,
            [uuid]:
              outcome.status === "ok"
                ? { state: "ok" }
                : { state: "error", detail: outcome.detail },
          }));
        },
        controller.signal,
      );
      const okCount = Object.keys(okResults).length;
      await persistBackRouteSettings(theme, (current) => ({
        region,
        results: { ...current.results, ...okResults },
      }));
      await queryClient.invalidateQueries({ queryKey: ["public"] });
      setMessage(`检测完成：成功 ${okCount} 台${failed ? `，失败 ${failed} 台` : ""}。`);
      setSelected(new Set());
    } catch (runError) {
      if (controller.signal.aborted) return;
      const text = runError instanceof Error ? runError.message : "检测失败";
      setError(`${text}（若后台账号开启了 2FA，Komari 会拒绝远程执行）`);
      setStatuses((current) => {
        const next = { ...current };
        for (const uuid of uuids) {
          if (next[uuid]?.state === "running") next[uuid] = { state: "error", detail: "未完成" };
        }
        return next;
      });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setRunning(false);
    }
  };

  const clearResult = async (uuid: string) => {
    if (!theme || running) return;
    setError(null);
    try {
      await persistBackRouteSettings(theme, (current) => {
        const results = { ...current.results };
        delete results[uuid];
        return { ...current, results };
      });
      await queryClient.invalidateQueries({ queryKey: ["public"] });
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : "清除失败");
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12px] text-[var(--text-secondary)]">检测目标</span>
          <div className="instance-segmented">
            {REGIONS.map((value) => (
              <button
                key={value}
                type="button"
                disabled={running}
                data-active={region === value ? "true" : "false"}
                aria-pressed={region === value}
                onClick={() => setRegion(value)}
              >
                {BACK_ROUTE_REGION_LABELS[value]}
              </button>
            ))}
          </div>
          <span className="text-[11px] text-[var(--text-tertiary)]">
            已检测 {testedCount} 台
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="theme-manage-button"
            disabled={running || overseas.length === 0}
            onClick={() =>
              setSelected((current) =>
                current.size === overseas.length
                  ? new Set()
                  : new Set(overseas.map((client) => client.uuid)),
              )
            }
          >
            {selected.size === overseas.length && overseas.length > 0 ? "取消全选" : "全选境外节点"}
          </button>
          <button
            type="button"
            className="theme-manage-button"
            disabled={!theme || running || selected.size === 0}
            onClick={() => void run()}
          >
            <Radar size={14} />
            {running ? "检测中，约 1-3 分钟…" : `检测选中 ${selected.size} 台`}
          </button>
        </div>
      </div>

      {message && <div className="text-[12px] text-[var(--status-success)]">{message}</div>}
      {error && <div className="text-[12px] text-[var(--status-error)]">{error}</div>}

      <div className="surface-inset max-h-[360px] overflow-y-auto">
        {clientsLoading && (
          <div className="px-3 py-4 text-[12px] text-[var(--text-tertiary)]">载入节点中…</div>
        )}
        {!clientsLoading && clients.length === 0 && (
          <div className="px-3 py-4 text-[12px] text-[var(--text-tertiary)]">没有可用节点。</div>
        )}
        {clients.map((client) => {
          const mainland = isMainlandChina(client.region);
          const status = statuses[client.uuid];
          const result = settings.results[client.uuid];
          return (
            <div key={client.uuid} className="border-b border-[var(--hairline)] px-3 py-2 last:border-b-0">
            <div className="flex items-center justify-between gap-3">
              <label
                className={clsx(
                  "flex min-w-0 shrink-0 items-center gap-2 sm:w-[34%]",
                  mainland ? "cursor-not-allowed opacity-55" : "cursor-pointer",
                )}
                title={mainland ? "中国大陆节点不需要检测回程线路" : undefined}
              >
                <input
                  type="checkbox"
                  disabled={mainland || running}
                  checked={selected.has(client.uuid)}
                  onChange={() => toggle(client.uuid)}
                />
                <Flag region={client.region ?? ""} size={13} />
                <span className="truncate text-[13px] text-[var(--text-primary)]">{client.name}</span>
              </label>
              <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
                {status?.state === "running" ? (
                  <span className="text-[11px] text-[var(--text-tertiary)]">检测中…</span>
                ) : status?.state === "error" ? (
                  <span className="truncate text-[11px] text-[var(--status-error)]" title={status.detail}>
                    {status.detail ?? "失败"}
                  </span>
                ) : (
                  <RouteCells result={result} />
                )}
                {outputs[client.uuid] && (
                  <button
                    type="button"
                    className="shrink-0 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                    title="查看本次检测的原始输出"
                    aria-label={`查看 ${client.name} 的原始输出`}
                    aria-expanded={openOutput === client.uuid}
                    onClick={() =>
                      setOpenOutput((current) => (current === client.uuid ? null : client.uuid))
                    }
                  >
                    <FileText size={13} />
                  </button>
                )}
                {result && !running && (
                  <button
                    type="button"
                    className="shrink-0 text-[var(--text-tertiary)] hover:text-[var(--status-error)]"
                    title="清除该节点的回程结果"
                    aria-label={`清除 ${client.name} 的回程结果`}
                    onClick={() => void clearResult(client.uuid)}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            </div>
            {openOutput === client.uuid && outputs[client.uuid] && (
              <div className="mt-2 flex flex-col gap-1">
                <div className="flex items-center justify-between text-[11px] text-[var(--text-tertiary)]">
                  <span>原始输出（仅本次会话保留，不会保存）</span>
                  <button
                    type="button"
                    className="hover:text-[var(--text-primary)]"
                    onClick={() => void navigator.clipboard?.writeText(outputs[client.uuid] ?? "")}
                  >
                    复制
                  </button>
                </div>
                <pre className="max-h-[240px] overflow-auto rounded-[8px] bg-[color-mix(in_srgb,var(--text-primary)_5%,transparent)] p-2 text-[10.5px] leading-[1.45] text-[var(--text-secondary)]">
                  {outputs[client.uuid]}
                </pre>
              </div>
            )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
