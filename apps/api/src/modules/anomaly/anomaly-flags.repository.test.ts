import { describe, expect, it } from "vitest";

import { findingKey } from "./anomaly-flags.repository.js";

describe("findingKey", () => {
  it("distinguishes positions in the same wallet by positionId + checkId", () => {
    expect(findingKey({ walletId: "w", positionId: "POS-1", checkId: "drift" })).toBe("w|POS-1|drift");
    expect(findingKey({ walletId: "w", positionId: "POS-2", checkId: "drift" })).toBe("w|POS-2|drift");
  });

  it("account-level finding (null wallet/position) is stable", () => {
    expect(findingKey({ checkId: "start_zero" })).toBe("||start_zero");
    expect(findingKey({ walletId: null, positionId: null, checkId: "start_zero" })).toBe("||start_zero");
  });
});
