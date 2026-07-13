// Shared blueprint types.
//
// A place's blueprint is a to-scale, top-down storage layout: a rectangular room (in feet) with
// labeled zones (pegboard, shelf, rack, …) placed on it. Both the BlueprintEditor (drawing) and
// the vision client (AI generation) produce this same shape, so it lives in one type-only module
// to avoid a React component <-> lib circular import.

/** Normalized rect (0..1 of the room footprint) for one storage zone. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Zone {
  id: string;
  name: string;
  type: string;
  rect: Rect;
}

export interface Blueprint {
  roomFt: { w: number; d: number };
  zones: Zone[];
}

/** The storage-zone kinds a blueprint can contain — each a recognizable furniture strip. */
export const ZONE_TYPES = ["pegboard", "shelf", "cabinet", "rack", "drawer", "bin"] as const;
