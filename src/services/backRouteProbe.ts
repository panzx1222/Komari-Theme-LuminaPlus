import { z } from "zod";
import { ApiRequestError, getPublic, saveThemeSettings } from "@/services/api";
import { fetchWithTimeout } from "@/utils/abort";
import {
  BACK_ROUTE_SETTINGS_KEY,
  buildBackRouteCommand,
  buildBackRouteResult,
  normalizeBackRouteSettings,
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
): Promise<BackRouteSettings> {
  const latest = await getPublic();
  if (latest.theme !== theme) {
    throw new Error("站点主题已切换，请刷新页面后重试。");
  }
  const current = normalizeBackRouteSettings(latest.theme_settings?.[BACK_ROUTE_SETTINGS_KEY]);
  const next = update(current);
  await saveThemeSettings(theme, { ...(latest.theme_settings ?? {}), [BACK_ROUTE_SETTINGS_KEY]: next });
  return next;
}
