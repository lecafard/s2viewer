import type { Map as MapLibreMap } from 'maplibre-gl';

export const VISIBLE_LEVEL_COUNT = 4;
const ZOOM_STEPS_PER_LEVEL = 1.15;
// MapLibre's GeoJSON source tiles use Web Mercator, whose valid latitude range
// ends here. Clipping before tiling avoids collapsing polar lines into loops.
const MAX_GRID_LATITUDE = 85.05112878;

export type Position = [number, number];
export type LineFeature = {
  type: 'Feature';
  properties: { level: number };
  geometry: { type: 'MultiLineString'; coordinates: Position[][] };
};
export type PolygonFeature = {
  type: 'Feature';
  properties: { level: number };
  geometry: { type: 'Polygon'; coordinates: Position[][] };
};

const stToUv = (s: number) =>
  s >= 0.5 ? (4 * s * s - 1) / 3 : (1 - 4 * (1 - s) * (1 - s)) / 3;

function faceUvToLatLng(face: number, u: number, v: number): Position {
  let x: number;
  let y: number;
  let z: number;

  switch (face) {
    case 0: [x, y, z] = [1, u, v]; break;
    case 1: [x, y, z] = [-u, 1, v]; break;
    case 2: [x, y, z] = [-u, -v, 1]; break;
    case 3: [x, y, z] = [-1, -v, -u]; break;
    case 4: [x, y, z] = [v, -1, -u]; break;
    default: [x, y, z] = [v, u, -1];
  }

  const length = Math.hypot(x, y, z);
  x /= length;
  y /= length;
  z /= length;
  return [Math.atan2(y, x) * (180 / Math.PI), Math.asin(z) * (180 / Math.PI)];
}

function splitAtDateline(points: Position[]): Position[][] {
  if (points.length < 2) return [];
  const segments: Position[][] = [];
  let current: Position[] = [points[0]];

  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1];
    const next = points[i];
    const delta = next[0] - previous[0];
    if (Math.abs(delta) > 180) {
      const adjustedNextLng = next[0] + (delta > 180 ? -360 : 360);
      const edgeLng = adjustedNextLng > previous[0] ? 180 : -180;
      const t = (edgeLng - previous[0]) / (adjustedNextLng - previous[0]);
      const crossingLat = previous[1] + (next[1] - previous[1]) * t;
      current.push([edgeLng, crossingLat]);
      if (current.length > 1) segments.push(current);
      current = [[-edgeLng, crossingLat], next];
    } else {
      current.push(next);
    }
  }

  if (current.length > 1) segments.push(current);
  return segments;
}

function clipAtMercatorLatitude(points: Position[]): Position[][] {
  const segments: Position[][] = [];
  let current: Position[] = [];
  const finish = () => {
    if (current.length > 1) segments.push(current);
    current = [];
  };

  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1];
    const next = points[i];
    const latitudeDelta = next[1] - previous[1];
    let start = 0;
    let end = 1;

    if (latitudeDelta === 0) {
      if (Math.abs(previous[1]) > MAX_GRID_LATITUDE) {
        finish();
        continue;
      }
    } else {
      const lower = (-MAX_GRID_LATITUDE - previous[1]) / latitudeDelta;
      const upper = (MAX_GRID_LATITUDE - previous[1]) / latitudeDelta;
      start = Math.max(0, Math.min(lower, upper));
      end = Math.min(1, Math.max(lower, upper));
      if (start > end || end < 0 || start > 1) {
        finish();
        continue;
      }
      start = Math.max(0, start);
      end = Math.min(1, end);
    }

    const pointAt = (t: number): Position => [
      previous[0] + (next[0] - previous[0]) * t,
      previous[1] + latitudeDelta * t,
    ];
    const clippedStart = pointAt(start);
    const clippedEnd = pointAt(end);
    if (start > 0 || current.length === 0) {
      finish();
      current = [clippedStart];
    }
    current.push(clippedEnd);
    if (end < 1) finish();
  }

  finish();
  return segments;
}

function edgePoints(face: number, start: [number, number], end: [number, number], samples = 4): Position[] {
  const points: Position[] = [];
  for (let step = 0; step <= samples; step += 1) {
    const t = step / samples;
    const u = start[0] + (end[0] - start[0]) * t;
    const v = start[1] + (end[1] - start[1]) * t;
    points.push(faceUvToLatLng(face, u, v));
  }
  return points;
}

function edgeSampleCount(level: number) {
  // Low-level S2 edges cover large arcs and need finer sampling to look smooth
  // when MapLibre bends them over the globe. Small high-level cells need less.
  return level <= 3 ? 24 : level <= 5 ? 12 : 4;
}

export function makeLevelFeatures(level: number): LineFeature[] {
  const cellsPerEdge = 2 ** level;
  const features: LineFeature[] = [];

  for (let face = 0; face < 6; face += 1) {
    for (let i = 0; i < cellsPerEdge; i += 1) {
      for (let j = 0; j < cellsPerEdge; j += 1) {
        features.push(cellFeature(level, face, i, j, cellsPerEdge));
      }
    }
  }
  return features;
}

function cellFeature(level: number, face: number, i: number, j: number, cellsPerEdge: number): LineFeature {
  const u0 = stToUv(i / cellsPerEdge);
  const u1 = stToUv((i + 1) / cellsPerEdge);
  const v0 = stToUv(j / cellsPerEdge);
  const v1 = stToUv((j + 1) / cellsPerEdge);
  const samples = edgeSampleCount(level);
  const sides = [
    edgePoints(face, [u0, v0], [u1, v0], samples),
    edgePoints(face, [u1, v0], [u1, v1], samples),
    edgePoints(face, [u1, v1], [u0, v1], samples),
    edgePoints(face, [u0, v1], [u0, v0], samples),
  ];
  return {
    type: 'Feature',
    properties: { level },
    geometry: {
      type: 'MultiLineString',
      coordinates: sides.flatMap((side) => clipAtMercatorLatitude(side).flatMap(splitAtDateline)),
    },
  };
}

function latLngToFaceCell(lat: number, lng: number, level: number) {
  const phi = lat * (Math.PI / 180);
  const theta = lng * (Math.PI / 180);
  const cosPhi = Math.cos(phi);
  const x = cosPhi * Math.cos(theta);
  const y = cosPhi * Math.sin(theta);
  const z = Math.sin(phi);
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const az = Math.abs(z);
  let face: number;
  let u: number;
  let v: number;

  if (ax >= ay && ax >= az) {
    if (x >= 0) { face = 0; u = y / x; v = z / x; }
    else { face = 3; u = z / x; v = y / x; }
  } else if (ay >= az) {
    if (y >= 0) { face = 1; u = -x / y; v = z / y; }
    else { face = 4; u = z / y; v = -x / y; }
  } else if (z >= 0) {
    face = 2; u = -x / z; v = -y / z;
  } else {
    face = 5; u = y / -z; v = x / -z;
  }

  const uvToSt = (value: number) => value >= 0
    ? 0.5 * Math.sqrt(1 + 3 * value)
    : 1 - 0.5 * Math.sqrt(1 - 3 * value);
  const n = 2 ** level;
  const s = Math.max(0, Math.min(1 - Number.EPSILON, uvToSt(u)));
  const t = Math.max(0, Math.min(1 - Number.EPSILON, uvToSt(v)));
  return { face, i: Math.floor(s * n), j: Math.floor(t * n) };
}

export function selectedCellFeature(lat: number, lng: number, level: number): PolygonFeature {
  const { face, i, j } = latLngToFaceCell(lat, lng, level);
  const cellsPerEdge = 2 ** level;
  const u0 = stToUv(i / cellsPerEdge);
  const u1 = stToUv((i + 1) / cellsPerEdge);
  const v0 = stToUv(j / cellsPerEdge);
  const v1 = stToUv((j + 1) / cellsPerEdge);
  const samples = edgeSampleCount(level);
  const edges = [
    edgePoints(face, [u0, v0], [u1, v0], samples),
    edgePoints(face, [u1, v0], [u1, v1], samples),
    edgePoints(face, [u1, v1], [u0, v1], samples),
    edgePoints(face, [u0, v1], [u0, v0], samples),
  ];
  const ring = edges.flatMap((edge) => edge.slice(0, -1)).map(([edgeLng, edgeLat]) => [
    edgeLng + 360 * Math.round((lng - edgeLng) / 360),
    edgeLat,
  ] as Position);
  ring.push(ring[0]);

  return {
    type: 'Feature',
    properties: { level },
    geometry: { type: 'Polygon', coordinates: [ring] },
  };
}

function viewportLevelFeatures(level: number, map: MapLibreMap): LineFeature[] {
  const { clientWidth: width, clientHeight: height } = map.getContainer();
  const cellsPerEdge = 2 ** level;
  const cells = new Map<string, [number, number, number]>();
  const columns = 38;
  const rows = 26;

  // Sample across the rendered map, then add a one-cell halo so the lines
  // continue naturally at the viewport edge while panning.
  for (let row = -1; row <= rows; row += 1) {
    for (let column = -1; column <= columns; column += 1) {
      const point = map.unproject([
        (column / columns) * width,
        (row / rows) * height,
      ]);
      const cell = latLngToFaceCell(point.lat, point.lng, level);
      for (let di = -1; di <= 1; di += 1) {
        for (let dj = -1; dj <= 1; dj += 1) {
          const i = cell.i + di;
          const j = cell.j + dj;
          if (i < 0 || j < 0 || i >= cellsPerEdge || j >= cellsPerEdge) continue;
          cells.set(`${cell.face}/${i}/${j}`, [cell.face, i, j]);
        }
      }
    }
  }

  return [...cells.values()].map(([face, i, j]) => cellFeature(level, face, i, j, cellsPerEdge));
}

export function worldGrid(levels: number[], map?: MapLibreMap) {
  return {
    type: 'FeatureCollection' as const,
    features: levels.flatMap((level) => map && level > 5
      ? viewportLevelFeatures(level, map)
      : makeLevelFeatures(level)),
  };
}

export function visibleLevels(zoom: number): number[] {
  const count = Math.max(1, Math.min(31, Math.floor(VISIBLE_LEVEL_COUNT)));
  const maxFirstLevel = Math.min(18, 31 - count);
  const first = Math.max(0, Math.min(
    maxFirstLevel,
    Math.floor((zoom - 2.25) / ZOOM_STEPS_PER_LEVEL) + 1,
  ));
  return Array.from({ length: count }, (_, index) => first + index);
}

export function zoomForFirstVisibleLevel(level: number): number {
  return level === 0
    ? 1.2
    : 2.25 + (level - 1) * ZOOM_STEPS_PER_LEVEL + 0.2;
}
