import { useQuery } from "@tanstack/react-query";

import { adminTechAuditApi } from "./api";

export function useTechAuditReport() {
  return useQuery({
    queryKey: ["admin", "tech-audit"] as const,
    queryFn: () => adminTechAuditApi.report(),
  });
}
