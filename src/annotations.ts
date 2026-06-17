export type CoordinateSpace = "screen" | "image";

export interface CaptureMeta {
  left?: number;
  top?: number;
  scale?: number;
}

export type AnnotationShape = Record<string, any>;

function toScreenX(value: number, meta: CaptureMeta): number {
  return value / (meta.scale ?? 1) + (meta.left ?? 0);
}

function toScreenY(value: number, meta: CaptureMeta): number {
  return value / (meta.scale ?? 1) + (meta.top ?? 0);
}

function toScreenSize(value: number, meta: CaptureMeta): number {
  return value / (meta.scale ?? 1);
}

function convertRect(rect: number[], meta: CaptureMeta): number[] {
  return [
    toScreenX(rect[0], meta),
    toScreenY(rect[1], meta),
    toScreenSize(rect[2], meta),
    toScreenSize(rect[3], meta),
  ];
}

function convertPoint(point: number[], meta: CaptureMeta): number[] {
  return [toScreenX(point[0], meta), toScreenY(point[1], meta)];
}

export function convertShapeToScreen(shape: AnnotationShape, meta: CaptureMeta): AnnotationShape {
  const converted: AnnotationShape = { ...shape };
  delete converted.coordinateSpace;
  delete converted.coords;
  delete converted.mode;

  if (Array.isArray(shape.rect)) converted.rect = convertRect(shape.rect, meta);
  if (Array.isArray(shape.from)) converted.from = convertPoint(shape.from, meta);
  if (Array.isArray(shape.to)) converted.to = convertPoint(shape.to, meta);
  if (Array.isArray(shape.at)) converted.at = convertPoint(shape.at, meta);

  return converted;
}

export function normalizeShapesToScreen(
  shapes: AnnotationShape[],
  meta: CaptureMeta,
  defaultCoordinateSpace: CoordinateSpace = "screen",
): AnnotationShape[] {
  return shapes.map((shape) => {
    const coordinateSpace = (shape.coordinateSpace ?? shape.coords ?? shape.mode ?? defaultCoordinateSpace) as CoordinateSpace;
    return coordinateSpace === "image" ? convertShapeToScreen(shape, meta) : { ...shape };
  });
}
