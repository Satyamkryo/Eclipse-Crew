export interface SamMask { id: number; box: { x1: number; y1: number; x2: number; y2: number }; confidence: number | null; width: number; height: number; area: number; raster: Uint8Array; }
export function validateSamResponse(value: unknown, image: { width: number; height: number }): SamMask[];
