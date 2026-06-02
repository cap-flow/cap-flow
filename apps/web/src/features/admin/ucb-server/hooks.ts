import { useMutation } from "@tanstack/react-query";

import { adminUcbApi, type Methodology } from "./api";

export function useUcbCompute() {
  return useMutation({
    mutationFn: ({ account, methodology }: { account: string; methodology: Methodology }) =>
      adminUcbApi.compute(account, methodology),
  });
}
