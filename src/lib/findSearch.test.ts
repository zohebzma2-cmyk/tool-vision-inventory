import { describe, it, expect } from "vitest";
import { normalizeQuery, rankItems, spokenAnswer } from "./findSearch";

describe("normalizeQuery", () => {
  it("strips filler words and punctuation", () => {
    expect(normalizeQuery("where's my chalk line?").needles).toEqual(["chalk", "line"]);
    expect(normalizeQuery("find me the torque wrench").needles).toEqual(["torque", "wrench"]);
  });
  it("drops tokens shorter than 3 chars", () => {
    // "3" and "in" fall out; only "socket" survives
    expect(normalizeQuery("3 in socket").needles).toEqual(["socket"]);
  });
  it("falls back to the whole cleaned string when no token survives", () => {
    const n = normalizeQuery("saw");
    expect(n.needles).toEqual(["saw"]);
  });
  it("returns empty needles for an all-filler / empty query", () => {
    expect(normalizeQuery("where's my").needles).toEqual([]);
    expect(normalizeQuery("   ").needles).toEqual([]);
  });
});

describe("rankItems", () => {
  const items = [
    { name: "Chalk Line", category: "marking tools" },
    { name: "Torque Wrench", category: "wrenches" },
    { name: "Marking Chalk", category: "marking tools" },
  ];
  it("ranks name matches above category-only matches", () => {
    const out = rankItems(items, ["chalk"]);
    expect(out[0].name).toBe("Chalk Line"); // name hit (2) beats...
    expect(out.map((i) => i.name)).toContain("Marking Chalk"); // ...name hit too
    // Torque Wrench (no chalk anywhere) ranks last
    expect(out[out.length - 1].name).toBe("Torque Wrench");
  });
  it("respects the limit", () => {
    expect(rankItems(items, ["marking"], 1)).toHaveLength(1);
  });
});

describe("spokenAnswer", () => {
  it("reports the bin, category, and shelf of the top hit", () => {
    const s = spokenAnswer("chalk line", [{ name: "Chalk Line", category: "Marking Tools", bin: "Bin 3", shelf: "6.5qt Bin Wall" }]);
    expect(s).toBe("Chalk Line is in Bin 3, in Marking Tools, on 6.5qt Bin Wall.");
  });
  it("handles an item not yet filed in a bin", () => {
    expect(spokenAnswer("caliper", [{ name: "Caliper", category: null, bin: null, shelf: null }]))
      .toBe("Caliper is in the inventory, but it isn't filed in a bin yet.");
  });
  it("mentions additional matches", () => {
    const s = spokenAnswer("chalk", [
      { name: "Chalk Line", category: "Marking", bin: "Bin 3", shelf: null },
      { name: "Marking Chalk", category: "Marking", bin: "Bin 3", shelf: null },
    ]);
    expect(s).toContain("Chalk Line is in Bin 3");
    expect(s).toContain("1 other match too.");
  });
  it("pluralizes multiple extra matches", () => {
    const hits = Array.from({ length: 3 }, (_, i) => ({ name: `Item ${i}`, category: null, bin: "Bin 1", shelf: null }));
    expect(spokenAnswer("x", hits)).toContain("2 other matches too.");
  });
  it("reports nothing found", () => {
    expect(spokenAnswer("unicorn", [])).toBe("I couldn't find anything matching unicorn.");
  });
});
