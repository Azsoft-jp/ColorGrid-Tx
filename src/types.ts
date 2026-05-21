export type GridProfileId = "XS" | "S" | "M" | "L" | "XL";

export interface GridProfile {
  id: GridProfileId;
  name: string;
  size: number;
  finderSize: number;
  headerCellCount: number;
  recommendedCellSizes: number[];
}

export const GRID_PROFILES: Record<GridProfileId, GridProfile> = {
  XS: { id: "XS", name: "Micro", size: 45, finderSize: 7, headerCellCount: 64, recommendedCellSizes: [8, 10, 12, 16] },
  S: { id: "S", name: "Small", size: 89, finderSize: 7, headerCellCount: 64, recommendedCellSizes: [5, 6, 7, 8] },
  M: { id: "M", name: "Medium", size: 121, finderSize: 7, headerCellCount: 64, recommendedCellSizes: [4, 5, 6] },
  L: { id: "L", name: "Large", size: 145, finderSize: 7, headerCellCount: 64, recommendedCellSizes: [4, 5] },
  XL: { id: "XL", name: "Extra Large", size: 177, finderSize: 7, headerCellCount: 64, recommendedCellSizes: [3, 4, 5, 6] },
};

export interface Point {
  x: number;
  y: number;
}

export interface Mat3 {
  m: number[]; // length 9
}

export interface PayloadMeta {
  type: "text" | "file";
  filename?: string;
  mimeType?: string;
}

export interface DecodedChunk {
  chunkIndex: number;
  totalChunks: number;
  payload: Uint8Array;
  meta?: PayloadMeta;
  profileId: GridProfileId;
  gridSize: number;
}

export interface DecodeDebugInfo {
  finderPoints?: Point[];
  corners?: Point[];
  clockValue?: number;
  sampledCells?: Point[];
  detectedProfileId?: GridProfileId;
  estimatedGridSize?: number;
  estimatedCellSizePx?: number;
  crcOk?: boolean;
}

export interface DecodeResult {
  ok: boolean;
  reason?: string;
  chunk?: DecodedChunk;
  debug?: DecodeDebugInfo;
}
