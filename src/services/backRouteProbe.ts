import { z } from "zod";
import { ApiRequestError, getPublic, saveThemeSettings } from "@/services/api";
import { fetchWithTimeout } from "@/utils/abort";
import {
  BACK_ROUTE_SETTINGS_KEY,
  buildBackRouteCommand,
  buildBackRouteResult,
  isBackRouteAutoDue,
  normalizeBackRouteSettings,
  type BackRouteNodeResult,
  type BackRouteProbeOutcome,
  type BackRouteRegion,
  type BackRouteSettings,
} from "@/utils/backRoute";

const REQUEST_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 4_000;
/** 三网并行、每家最多 5 次 ×（60s + 5s 间隔），再留一点下载 nexttrace 的余量。 */
const PROBE_TIMEOUT_MS = 420_000;

const ExecResponseSchema = z
  .object({ task_id: z.string().min(1) })
  .passthrough();

const TaskResultSchema = z
  .object({
    client: z.string(),
    result: z.string().nullable().optional(),
    exit_code: z.number().nullable().optional(),
    finished_at: z.string().nullable().optional(),
  })
  .passthrough();

function unwrapEnvelope(json: unknown, path: string, status: number): unknown {
  if (json && typeof json === "object" && !Array.isArray(json)) {
    const envelope = json as Record<string, unknown>;
    if (typeof envelope.status === "string" && envelope.status.toLowerCase() === "error") {
      throw new ApiRequestError(
        typeof envelope.message === "string" && envelope.message ? envelope.message : `Request ${path} failed`,
        status,
        path,
      );
    }
    if ("data" in envelope) return envelope.data;
  }
  return json;
}

async function requestJson(path: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
  const resp = await fetchWithTimeout(
    path,
    {
      credentials: "include",
      ...init,
      headers: { Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}) },
    },
    REQUEST_TIMEOUT_MS,
    signal,
  );
  let json: unknown = null;
  try {
    json = await resp.json();
  } catch {
    // 非 JSON 回执交给下面按状态码处理。
  }
  if (!resp.ok) {
    const message =
      json && typeof json === "object" && typeof (json as { message?: unknown }).message === "string"
        ? (json as { message: string }).message
        : `Request ${path} failed: ${resp.status}`;
    throw new ApiRequestError(message, resp.status, path);
  }
  return unwrapEnvelope(json, path, resp.status);
}

/** 下发固定的回程采集命令，返回 Komari 任务 ID。 */
export async function dispatchBackRouteProbe(
  uuids: string[],
  region: BackRouteRegion,
  signal?: AbortSignal,
): Promise<string> {
  const path = "/api/admin/task/exec";
  const data = await requestJson(
    path,
    {
      method: "POST",
      body: JSON.stringify({ command: buildBackRouteCommand(region), clients: uuids }),
    },
    signal,
  );
  const parsed = ExecResponseSchema.safeParse(data);
  if (!parsed.success) throw new Error("远程执行接口返回了无法识别的结果");
  return parsed.data.task_id;
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

/**
 * 轮询任务结果，每有一台节点完成就回调一次。超时仍未完成的节点以 `failed` 回调。
 */
export async function waitBackRouteResults(
  taskId: string,
  uuids: string[],
  region: BackRouteRegion,
  onResult: (uuid: string, outcome: BackRouteProbeOutcome, output: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const path = `/api/admin/task/${encodeURIComponent(taskId)}/result`;
  const pending = new Set(uuids);
  const deadline = Date.now() + PROBE_TIMEOUT_MS;
  while (pending.size > 0 && Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS, signal);
    let rows: z.infer<typeof TaskResultSchema>[] = [];
    try {
      const data = await requestJson(path, { method: "GET" }, signal);
      rows = Array.isArray(data)
        ? data.flatMap((row) => {
            const parsed = TaskResultSchema.safeParse(row);
            return parsed.success ? [parsed.data] : [];
          })
        : [];
    } catch (error) {
      if (signal?.aborted) throw error;
      // 结果还没写入时 Komari 可能返回 404，继续等。
      if (error instanceof ApiRequestError && error.status === 404) continue;
      throw error;
    }
    for (const row of rows) {
      if (!pending.has(row.client) || !row.finished_at) continue;
      pending.delete(row.client);
      const output = row.result ?? "";
      if (output.trim() === "Client offline!") {
        onResult(row.client, { status: "failed", detail: "节点离线" }, output);
        continue;
      }
      onResult(row.client, buildBackRouteResult(output, region, Math.floor(Date.now() / 1000)), output);
    }
  }
  for (const uuid of pending) {
    onResult(uuid, { status: "failed", detail: "等待超时，节点可能仍在执行" }, "");
  }
}

/**
 * 保存接口接收整份设置；先取服务端最新值，只改 `backRoute` 这一项，
 * 避免覆盖其他页面刚保存的配置。
 */
export async function persistBackRouteSettings(
  theme: string,
  update: (current: BackRouteSettings) => BackRouteSettings,
): Promise<BackRouteSettings>;
export async function persistBackRouteSettings(
  theme: string,
  update: (current: BackRouteSettings) => BackRouteSettings | null,
): Promise<BackRouteSettings | null>;
/** `update` 返回 null 时不写入，并返回 null。 */
export async function persistBackRouteSettings(
  theme: string,
  update: (current: BackRouteSettings) => BackRouteSettings | null,
): Promise<BackRouteSettings | null> {
  const latest = await getPublic();
  if (latest.theme !== theme) {
    throw new Error("站点主题已切换，请刷新页面后重试。");
  }
  const current = normalizeBackRouteSettings(latest.theme_settings?.[BACK_ROUTE_SETTINGS_KEY]);
  const next = update(current);
  if (!next) return null;
  await saveThemeSettings(theme, { ...(latest.theme_settings ?? {}), [BACK_ROUTE_SETTINGS_KEY]: next });
  return next;
}

export interface BackRouteRunSummary {
  ok: number;
  failed: number;
}

/**
 * 检测一批节点并把成功的结果合并保存。失败的节点保留旧结果，不会被覆盖。
 * 手动检测和定时检测共用这一个入口。
 */
export async function probeAndSaveBackRoutes(
  theme: string,
  uuids: string[],
  region: BackRouteRegion,
  options: {
    signal?: AbortSignal;
    onResult?: (uuid: string, outcome: BackRouteProbeOutcome, output: string) => void;
  } = {},
): Promise<BackRouteRunSummary> {
  const okResults: Record<string, BackRouteNodeResult> = {};
  let failed = 0;
  const taskId = await dispatchBackRouteProbe(uuids, region, options.signal);
  await waitBackRouteResults(
    taskId,
    uuids,
    region,
    (uuid, outcome, output) => {
      if (outcome.status === "ok") okResults[uuid] = outcome.result;
      else failed += 1;
      options.onResult?.(uuid, outcome, output);
    },
    options.signal,
  );
  if (Object.keys(okResults).length > 0) {
    await persistBackRouteSettings(theme, (current) => ({
      ...current,
      results: { ...current.results, ...okResults },
    }));
  }
  return { ok: Object.keys(okResults).length, failed };
}

/**
 * 定时检测「占位」：重新读取服务端最新设置，确认确实到期后先写入本轮开始时间，
 * 让其他打开着页面的管理员浏览器不会同时再跑一轮。返回 null 表示不需要检测。
 */
export async function claimBackRouteAutoRun(
  theme: string,
  nowSeconds: number,
): Promise<BackRouteSettings | null> {
  return persistBackRouteSettings(theme, (current) =>
    isBackRouteAutoDue(current, nowSeconds)
      ? { ...current, lastAutoRun: { startedAt: nowSeconds } }
      : null,
  );
}

/** 记录定时检测的结果。只更新本轮（startedAt 相同）的记录。 */
export async function finishBackRouteAutoRun(
  theme: string,
  startedAt: number,
  outcome: { ok: number; failed: number } | { error: string },
): Promise<void> {
  await persistBackRouteSettings(theme, (current) => {
    if (current.lastAutoRun?.startedAt !== startedAt) return null;
    return {
      ...current,
      lastAutoRun: { startedAt, finishedAt: Math.floor(Date.now() / 1000), ...outcome },
    };
  });
}
