import { describe, it, expect } from "vitest";
import { parseQty, parseCorrection, classifyCommand } from "./voiceCommands";

describe("parseQty", () => {
  it("defaults to 1", () => {
    expect(parseQty("yes")).toBe(1);
    expect(parseQty("label it")).toBe(1);
  });
  it("reads digits", () => {
    expect(parseQty("yes 3")).toBe(3);
    expect(parseQty("add 12")).toBe(12);
  });
  it("reads number words", () => {
    expect(parseQty("yes two")).toBe(2);
    expect(parseQty("add five of them")).toBe(5);
    expect(parseQty("ten please")).toBe(10);
  });
  it("clamps low values and ignores >2-digit numbers", () => {
    expect(parseQty("add 0")).toBe(1);        // 0 clamps up to 1
    expect(parseQty("add 250")).toBe(1);      // 3 digits: no 1–2 digit word-boundary match → default 1
    expect(parseQty("add 99")).toBe(99);
  });
});

describe("parseCorrection", () => {
  it("extracts a corrected name and title-cases it", () => {
    expect(parseCorrection("no it's a chalk line")).toBe("Chalk Line");
    expect(parseCorrection("actually a torque wrench")).toBe("Torque Wrench");
    expect(parseCorrection("that's a caliper")).toBe("Caliper");
  });
  it("handles 'its' without apostrophe", () => {
    expect(parseCorrection("no its an angle grinder")).toBe("Angle Grinder");
  });
  it("returns null when there's no correction", () => {
    expect(parseCorrection("yes")).toBeNull();
    expect(parseCorrection("skip")).toBeNull();
    expect(parseCorrection("done")).toBeNull();
  });
  it("returns null for too-short corrections", () => {
    expect(parseCorrection("it's a")).toBeNull();
  });
});

describe("classifyCommand", () => {
  it("detects done with highest precedence", () => {
    expect(classifyCommand("done").kind).toBe("done");
    expect(classifyCommand("that's it").kind).toBe("done");
    // "done" wins even if other words are present
    expect(classifyCommand("yes done").kind).toBe("done");
  });
  it("detects undo", () => {
    expect(classifyCommand("undo").kind).toBe("undo");
    expect(classifyCommand("remove last").kind).toBe("undo");
  });
  it("treats a correction as a yes carrying the corrected name", () => {
    const p = classifyCommand("no it's a chalk line");
    expect(p.kind).toBe("yes");
    expect(p.correctedName).toBe("Chalk Line");
  });
  it("detects a plain yes with quantity", () => {
    const p = classifyCommand("yes two");
    expect(p.kind).toBe("yes");
    expect(p.qty).toBe(2);
    expect(p.correctedName).toBeNull();
  });
  it("detects skip", () => {
    expect(classifyCommand("skip").kind).toBe("skip");
    expect(classifyCommand("no").kind).toBe("skip");
    expect(classifyCommand("next").kind).toBe("skip");
  });
  it("falls back to unclear", () => {
    expect(classifyCommand("hmm what was that").kind).toBe("unclear");
    expect(classifyCommand("").kind).toBe("unclear");
  });
});
