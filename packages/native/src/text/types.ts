/** Result of slicing a line by visible column range. */
export interface SliceResult {
  /** The extracted text (may include ANSI codes). */
  text: string;
  /** Visible width of the extracted slice in terminal cells. */
  width: number;
}

/** Result of extracting before/after segments around an overlay. */
export interface ExtractSegmentsResult {
  /** Text content before the overlay region. */
  before: string;
  /** Visible width of the `before` segment. */
  beforeWidth: number;
  /** Text content after the overlay region. */
  after: string;
  /** Visible width of the `after` segment. */
  afterWidth: number;
}

/** Ellipsis style for truncation. */
export enum EllipsisKind {
  /** Unicode ellipsis character: \u2026 (width 1) */
  Unicode = 0,
  /** ASCII ellipsis: "..." (width 3) */
  Ascii = 1,
  /** No ellipsis (hard truncate) */
  None = 2,
}
