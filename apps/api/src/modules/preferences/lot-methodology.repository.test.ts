import { describe, expect, it } from "vitest";

import { coerceMethodology } from "./lot-methodology.repository.js";

describe("coerceMethodology", () => {
  it("passes through valid methodologies", () => {
    expect(coerceMethodology("FIFO")).toBe("FIFO");
    expect(coerceMethodology("LIFO")).toBe("LIFO");
    expect(coerceMethodology("WAC")).toBe("WAC");
    expect(coerceMethodology("HIFO")).toBe("HIFO");
  });

  it("falls back to FIFO for null / unknown", () => {
    expect(coerceMethodology(null)).toBe("FIFO");
    expect(coerceMethodology(undefined)).toBe("FIFO");
    expect(coerceMethodology("")).toBe("FIFO");
    expect(coerceMethodology("garbage")).toBe("FIFO");
    expect(coerceMethodology("fifo")).toBe("FIFO"); // case-sensitive
  });
});
