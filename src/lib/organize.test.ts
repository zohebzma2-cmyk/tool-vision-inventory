import { describe, it, expect, beforeEach } from "vitest";
import { buildOrgReport } from "./organize";

// buildOrgReport reads localStorage for dismissals; keep every test on a clean slate.
beforeEach(() => localStorage.clear());

type L = Parameters<typeof buildOrgReport>[0][number];
type I = Parameters<typeof buildOrgReport>[1][number];

const loc = (over: Partial<L> & { id: string; name: string; type: string }): L => ({
  category: null, capacity: null, grid_rows: null, grid_cols: null,
  is_slot: false, parent_location_id: null, ...over,
});
const item = (over: Partial<I> & { id: string; name: string; category: string }): I => ({
  brand: null, ...over,
});

/**
 * A realistic shape: Garage (space) > Bin Wall (shelf) > two categorized bins.
 * A "power tools" item is sitting in the fasteners bin, so it should be flagged as misplaced.
 */
function garage() {
  const locations = [
    loc({ id: "garage", name: "Garage", type: "space", category: "power tools" }),
    loc({ id: "wall", name: "Bin Wall", type: "shelf", category: "power tools", parent_location_id: "garage" }),
    loc({ id: "bin1", name: "Bin 1", type: "bin", category: "fasteners", parent_location_id: "wall" }),
    loc({ id: "bin2", name: "Bin 2", type: "bin", category: "power tools", parent_location_id: "wall" }),
  ];
  const items = [item({ id: "drill", name: "Drill", category: "power tools" })];
  const placements = [{ item_id: "drill", location_id: "bin1", quantity: 1 }];
  return { locations, items, placements };
}

describe("buildOrgReport — misplaced item homes", () => {
  it("suggests a leaf bin, never the space or the shelf above it", () => {
    const { locations, items, placements } = garage();
    const r = buildOrgReport(locations, items, placements);
    const m = r.suggestions.find((s) => s.kind === "misplaced");
    expect(m).toBeDefined();
    // "Garage" and "Bin Wall" both carry category "power tools" and both sort BEFORE "Bin 2",
    // so a first-match-wins scan over unordered rows would pick one of them.
    expect(m!.suggestedLocationId).toBe("bin2");
    expect(m!.suggestedLocationName).toBe("Bin 2");
  });

  it("is deterministic regardless of the order Postgres returns rows in", () => {
    const { locations, items, placements } = garage();
    const forward = buildOrgReport(locations, items, placements);
    const reversed = buildOrgReport([...locations].reverse(), items, placements);
    const pick = (r: ReturnType<typeof buildOrgReport>) =>
      r.suggestions.find((s) => s.kind === "misplaced")?.suggestedLocationId;
    expect(pick(forward)).toBe(pick(reversed));
  });

  it("offers no target at all rather than a container one", () => {
    // Only the space itself matches the category — better to say nothing than to suggest "Garage".
    const locations = [
      loc({ id: "garage", name: "Garage", type: "space", category: "power tools" }),
      loc({ id: "bin1", name: "Bin 1", type: "bin", category: "fasteners", parent_location_id: "garage" }),
    ];
    const items = [item({ id: "drill", name: "Drill", category: "power tools" })];
    const r = buildOrgReport(locations, items, [{ item_id: "drill", location_id: "bin1", quantity: 1 }]);
    const m = r.suggestions.find((s) => s.kind === "misplaced");
    expect(m).toBeDefined();
    expect(m!.suggestedLocationId).toBeUndefined();
  });

  it("still flags a genuinely homeless item", () => {
    const { locations } = garage();
    const items = [item({ id: "saw", name: "Saw", category: "power tools" })];
    const r = buildOrgReport(locations, items, []);
    expect(r.suggestions.some((s) => s.kind === "homeless" && s.itemId === "saw")).toBe(true);
    expect(r.counts.homeless).toBe(1);
  });
});
