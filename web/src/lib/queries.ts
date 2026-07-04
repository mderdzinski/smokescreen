import { useQuery } from "@tanstack/react-query";

import { api, type OptOutStatusFilter } from "./api";

export function useExtendedStats() {
  return useQuery({
    queryKey: ["extended-stats"],
    queryFn: api.getExtendedStats,
  });
}

export function useAppVersion() {
  return useQuery({
    queryKey: ["app-version"],
    queryFn: api.getVersion,
    staleTime: Infinity,
    retry: false,
  });
}

export function useBrokers() {
  return useQuery({
    queryKey: ["brokers"],
    queryFn: api.listBrokers,
  });
}

export function useBrokerSelections() {
  return useQuery({
    queryKey: ["broker-selections"],
    queryFn: api.getBrokerSelections,
  });
}

export function useSettings() {
  return useQuery({
    queryKey: ["settings"],
    queryFn: api.getSettings,
  });
}

export function useAdvancedSettings() {
  return useQuery({
    queryKey: ["settings", "advanced"],
    queryFn: api.getAdvancedSettings,
  });
}

export function useVerificationProfile() {
  return useQuery({
    queryKey: ["settings", "verification-profile"],
    queryFn: api.getVerificationProfile,
  });
}

export function useOptOuts(status?: OptOutStatusFilter, options: { includeDisabled?: boolean } = {}) {
  const includeDisabled = options.includeDisabled ?? false;
  return useQuery({
    queryKey: ["opt-outs", status ?? "all", includeDisabled ? "include-disabled" : "enabled-only"],
    queryFn: () => api.listOptOuts(status, { includeDisabled }),
  });
}

export function useWhitelist() {
  return useQuery({
    queryKey: ["whitelist"],
    queryFn: api.listWhitelist,
  });
}

export function usePendingWhitelist() {
  return useQuery({
    queryKey: ["pending-whitelist"],
    queryFn: api.listPendingWhitelist,
  });
}
