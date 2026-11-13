import { useMemo } from "react";
import { usePublicConfig } from "@/hooks/usePublicConfig";
import {
  IP_TYPE_SETTINGS_KEY,
  normalizeIpTypeSettings,
  type IpTypeNodeResult,
  type IpTypeSettings,
} from "@/utils/ipType";

export function useIpTypeSettings(): IpTypeSettings {
  const { data: config } = usePublicConfig();
  const raw = config?.theme_settings?.[IP_TYPE_SETTINGS_KEY];
  return useMemo(() => normalizeIpTypeSettings(raw), [raw]);
}

export function useNodeIpType(uuid: string): IpTypeNodeResult | undefined {
  return useIpTypeSettings().results[uuid];
}
