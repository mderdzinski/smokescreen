import { useQuery } from "@tanstack/react-query";

import { api } from "./api";

export function useExtendedStats() {
  return useQuery({
    queryKey: ["extended-stats"],
    queryFn: api.getExtendedStats,
  });
}

export function useOptOuts() {
  return useQuery({
    queryKey: ["opt-outs"],
    queryFn: api.listOptOuts,
  });
}
