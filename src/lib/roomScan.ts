import { registerPlugin, Capacitor } from "@capacitor/core";

/** One wall segment from a LiDAR room scan, in millimetres on the floor plane. */
export interface ScanWall {
  x1Mm: number; z1Mm: number;
  x2Mm: number; z2Mm: number;
  widthMm: number; heightMm: number;
}

export interface ScanObject {
  category: string;
  xMm: number; zMm: number;
  widthMm: number; depthMm: number; heightMm: number;
}

export interface RoomScanResult {
  walls: ScanWall[];
  objects: ScanObject[];
  footprint: {
    minXMm: number; maxXMm: number;
    minZMm: number; maxZMm: number;
    widthMm: number; lengthMm: number; heightMm: number;
  };
}

interface RoomScanPlugin {
  isAvailable(): Promise<{ available: boolean }>;
  scan(): Promise<RoomScanResult>;
}

const RoomScan = registerPlugin<RoomScanPlugin>("RoomScan");

/** LiDAR scanning exists only in the native iOS app on a LiDAR device. */
export async function isRoomScanAvailable(): Promise<boolean> {
  if (Capacitor.getPlatform() !== "ios") return false;
  try {
    const { available } = await RoomScan.isAvailable();
    return available;
  } catch {
    return false;
  }
}

/** Run Apple's RoomPlan capture and return the room's walls, objects, and real dimensions. */
export async function scanRoom(): Promise<RoomScanResult> {
  return RoomScan.scan();
}

/** Project a scan's walls into normalized floor-plan coordinates (0..1 of the footprint). */
export function wallsToPlan(result: RoomScanResult): { x1: number; y1: number; x2: number; y2: number }[] {
  const { minXMm, minZMm, widthMm, lengthMm } = result.footprint;
  if (!widthMm || !lengthMm) return [];
  return result.walls.map((w) => ({
    x1: (w.x1Mm - minXMm) / widthMm,
    y1: (w.z1Mm - minZMm) / lengthMm,
    x2: (w.x2Mm - minXMm) / widthMm,
    y2: (w.z2Mm - minZMm) / lengthMm,
  }));
}
