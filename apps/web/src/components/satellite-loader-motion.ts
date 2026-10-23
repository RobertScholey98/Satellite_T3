/** Motion approved in satellite-loader (7).svg and the matching completion lab.
 * The disabled chase effects and lab-only controls are intentionally omitted.
 * Geometry stays separate from playback so a finish can start at any loop phase.
 */
export const satelliteLoaderPreset = {
  duration: 1.6,
  orbit: 32,
  bounce: 0.13,
  stretch: 0.01,
  lag: -12,
  hold: 0.04,
  finishDuration: 0.85,
  finishTurns: 1.4,
  finishPull: 1,
  finishShrink: 0.8,
  finishSoften: 0.8,
} as const;

type Point = [number, number];
export interface SatelliteLoaderFrame {
  path: string;
  x: number;
  y: number;
  rotation: number;
  squareScale: number;
  opacity: number;
}

export const satelliteLoaderStill: SatelliteLoaderFrame = {
  path: "M9 27h14v14h14v14H9V27Z",
  x: 48,
  y: 16,
  rotation: 0,
  squareScale: 1,
  opacity: 1,
};

const round = (value: number) => Number(value.toFixed(3));
const wrap = (value: number) => ((value % 1) + 1) % 1;
const clamp = (value: number) => Math.max(0, Math.min(1, value));
export function smoothLoaderProgress(value: number) {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
}
const toAxis = ([x, y]: Point): Point => [(x - y) / Math.SQRT2, (x + y - 64) / Math.SQRT2];
const fromAxis = ([along, across]: Point): Point => [
  32 + (along + across) / Math.SQRT2,
  32 + (across - along) / Math.SQRT2,
];

function straightHalf(vertices: Point[]) {
  const points = vertices.map(toAxis);
  return [points[0]!, ...points.slice(1).flatMap((point, index) => [points[index]!, point, point])];
}
const normalHalf = straightHalf([
  [9, 55],
  [37, 55],
  [37, 41],
  [23, 41],
]);
const oppositeHalf = normalHalf.toReversed().map(([along, across]): Point => [-along, across]);

function middleHalf(length: number, width: number) {
  const points: Point[] = [[-length, 0]];
  const handle = (4 / 3) * Math.tan(Math.PI / 12);
  for (let segment = 0; segment < 3; segment++) {
    const first = Math.PI - (segment * Math.PI) / 3;
    const last = Math.PI - ((segment + 1) * Math.PI) / 3;
    const a: Point = [length * Math.cos(first), width * Math.sin(first)];
    const b: Point = [length * Math.cos(last), width * Math.sin(last)];
    points.push(
      [a[0] + handle * length * Math.sin(first), a[1] - handle * width * Math.cos(first)],
      [b[0] - handle * length * Math.sin(last), b[1] + handle * width * Math.cos(last)],
      segment === 2 ? [length, 0] : b,
    );
  }
  return points;
}
function reflectHalf(half: Point[]) {
  const reflected = half
    .slice(0, -1)
    .toReversed()
    .map(([along, across]): Point => [along, -across]);
  return [...half, ...reflected].map(fromAxis);
}
function pointsPath(points: Point[]) {
  return `M${points[0]!.map(round).join(" ")} C${points
    .slice(1)
    .map((point) => point.map(round).join(" "))
    .join(" ")} Z`;
}

function bodyPoints(phase: number) {
  const halfPhase = wrap(phase - satelliteLoaderPreset.lag / 100) * 2;
  const leg = Math.floor(halfPhase);
  const progress = clamp(
    (halfPhase - leg - satelliteLoaderPreset.hold / 2) / (1 - satelliteLoaderPreset.hold),
  );
  const tension = satelliteLoaderPreset.bounce * 3.4;
  const x = progress * 2;
  const eased =
    progress < 0.5
      ? (x * x * ((tension + 1) * x - tension)) / 2
      : ((x - 2) ** 2 * ((tension + 1) * (x - 2) + tension) + 2) / 2;
  const amount = leg === 0 ? eased : 1 - eased;
  const morph = clamp(amount);
  const envelope = 4 * morph * (1 - morph);
  const length = 18 + satelliteLoaderPreset.stretch * 12;
  const middle = middleHalf(length, 588 / (Math.PI * length));
  const overshoot = amount - morph;
  const extension = 1 + Math.abs(overshoot) * 1.2;
  const centreAlong = ((2 * morph - 1) * 34 * Math.SQRT2) / 3;
  const half = normalHalf.map((point, index): Point => {
    const target = oppositeHalf[index]!;
    const middlePoint = middle[index]!;
    const interpolate = (axis: 0 | 1) => {
      const value = point[axis];
      return (
        value +
        (target[axis] - value) * morph +
        envelope * (middlePoint[axis] - (value + target[axis]) / 2)
      );
    };
    const interpolated: Point = [interpolate(0), interpolate(1)];
    return [
      centreAlong + (interpolated[0] - centreAlong) * extension + overshoot * 32,
      interpolated[1] / extension,
    ];
  });
  // Derive both arms from the same contour to preserve the approved symmetry.
  return reflectHalf(half);
}

export function satelliteLoaderLoopFrame(
  phase: number,
): SatelliteLoaderFrame & { points: Point[] } {
  const angle = wrap(phase) * Math.PI * 2;
  const across = (satelliteLoaderPreset.orbit / Math.SQRT2) * Math.sin(angle);
  const points = bodyPoints(phase);
  return {
    points,
    path: pointsPath(points),
    x: round(32 + 16 * Math.cos(angle) + across),
    y: round(32 - 16 * Math.cos(angle) + across),
    rotation: 0,
    squareScale: 1,
    opacity: 1,
  };
}

const compactBody = reflectHalf(middleHalf(Math.sqrt(588 / Math.PI), Math.sqrt(588 / Math.PI)));

export function satelliteLoaderExitFrame(
  progress: number,
  startPhase: number,
): SatelliteLoaderFrame {
  const t = clamp(progress);
  // Integrate a falling loop speed: no phase reset or sudden stop at exit entry.
  const travelTime = t - t * t + (t * t * t) / 3;
  const frame = satelliteLoaderLoopFrame(
    startPhase +
      (satelliteLoaderPreset.finishDuration / satelliteLoaderPreset.duration) * travelTime,
  );
  const angle = satelliteLoaderPreset.finishTurns * Math.PI * 2 * t * t;
  const radius = 1 - smoothLoaderProgress(t ** (2.2 - satelliteLoaderPreset.finishPull * 1.6));
  const size =
    1 -
    smoothLoaderProgress(
      (t - satelliteLoaderPreset.finishShrink) / (1 - satelliteLoaderPreset.finishShrink),
    );
  const rotate = ([x, y]: Point): Point => [
    32 + x * Math.cos(angle) - y * Math.sin(angle),
    32 + x * Math.sin(angle) + y * Math.cos(angle),
  ];
  const anchors = [0, 3, 6, 9, 12, 15].map((index) => frame.points[index]!);
  const centreAxis = (axis: 0 | 1) =>
    anchors.reduce((sum, point) => sum + point[axis], 0) / anchors.length;
  const centre: Point = [centreAxis(0), centreAxis(1)];
  const softness = satelliteLoaderPreset.finishSoften * smoothLoaderProgress(t / 0.75);
  const points = frame.points.map((point, index) => {
    const compact = compactBody[index]!;
    const localAxis = (axis: 0 | 1) => {
      const offset = point[axis] - centre[axis];
      return offset + (compact[axis] - 32 - offset) * softness;
    };
    const local: Point = [localAxis(0), localAxis(1)];
    return rotate([
      (centre[0] - 32) * radius + local[0] * size,
      (centre[1] - 32) * radius + local[1] * size,
    ]);
  });
  const square = rotate([(frame.x - 32) * radius, (frame.y - 32) * radius]);
  return {
    path: pointsPath(points),
    x: round(square[0]),
    y: round(square[1]),
    rotation: (angle * 180) / Math.PI,
    squareScale: size,
    opacity: 1 - smoothLoaderProgress((t - 0.8) / 0.2),
  };
}
