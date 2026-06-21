import { useQuery } from "@tanstack/react-query";

import { api, type BrokerStatus } from "./api";

export function useExtendedStats() {
  return useQuery({
    queryKey: ["extended-stats"],
    queryFn: api.getExtendedStats,
  });
}

export function useBrokers() {
  return useQuery({
    queryKey: ["brokers"],
    queryFn: api.listBrokers,
  });
}

export function useOptOuts(status?: BrokerStatus) {
  return useQuery({
    queryKey: ["opt-outs", status ?? "all"],
    queryFn: () => api.listOptOuts(status),
  });
}
