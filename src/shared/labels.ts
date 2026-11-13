import { isAi, scoreOf, type Shape } from './labelfile'

export type Summary = {
  /** Accepted shapes. AI shapes stay out of the counts until accepted, as in training. */
  count: number
  ai: number
  /** The least certain AI shape's score */
  score: number | null
  classes: Record<string, number>
  /** A label file exists, so the image has been looked at: zero shapes means truly empty */
  labelled: boolean
}

// What the image list shows
export function summarize(shapes: Shape[], labelled = true): Summary {
  const classes: Record<string, number> = {}
  let ai = 0
  let score: number | null = null
  for (const s of shapes) {
    if (isAi(s)) {
      ai++
      const v = scoreOf(s)
      if (v !== undefined) score = score === null ? v : Math.min(score, v)
    } else {
      classes[s.label] = (classes[s.label] ?? 0) + 1
    }
  }
  return { count: shapes.length - ai, ai, score, classes, labelled }
}

export const EMPTY_SUMMARY: Summary = { count: 0, ai: 0, score: null, classes: {}, labelled: false }

/** Does the shape cover pixels, as a model learns from it? Lines and points don't, nor a shape short of points. */
export function hasArea(s: Shape) {
  const n = s.points.length
  if (s.shape_type === 'polygon' || s.shape_type === 'oriented_rectangle') return n >= 3
  if (s.shape_type === 'rectangle' || s.shape_type === 'circle') return n >= 2
  return s.shape_type === 'mask' && n >= 2 && !!s.mask
}
