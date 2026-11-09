import { useMemo } from "react";
import { usePublicConfig } from "@/hooks/usePublicConfig";
import {
  BACK_ROUTE_SETTINGS_KEY,
  normalizeBackRouteSettings,
  type BackRouteNodeResult,
  type BackRouteSettings,
} from "@/utils/backRoute";

export function useBackRouteSettings(): BackRouteSettings {
  const { data: config } = usePublicConfig();
  const raw = config?.theme_settings?.[BACK_ROUTE_SETTINGS_KEY];
  return useMemo(() => normalizeBackRouteSettings(raw), [raw]);
}

export function useNodeBackRoute(uuid: string): BackRouteNodeResult | undefined {
  return useBackRouteSettings().results[uuid];
}
