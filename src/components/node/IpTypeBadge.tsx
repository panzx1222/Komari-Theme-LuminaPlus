import { useNodeIpType } from "@/hooks/useIpTypes";
import { describeIpType, IP_TYPE_LABELS } from "@/utils/ipType";

/** 服务器名称后方的 IP 类型标签（仅 IPv4）。还没检测出结果时不渲染。 */
export function IpTypeBadge({ uuid }: { uuid: string }) {
  const result = useNodeIpType(uuid);
  if (!result) return null;
  return (
    <span className="ip-type-badge" data-ip-type={result.type} title={describeIpType(result)}>
      {IP_TYPE_LABELS[result.type]}
    </span>
  );
}
