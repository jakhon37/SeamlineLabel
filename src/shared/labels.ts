type Labelled = { label: string; flags?: Record<string, boolean>; score?: number }

// What the image list shows. AI shapes stay out of the counts until accepted, as in training.
export function summarize(shapes: Labelled[]) {
  const classes: Record<string, number> = {}
  let ai = 0
  let score: number | null = null
  for (const s of shapes) {
    if (s.flags?.ai) {
      ai++
      if (s.score !== undefined) score = score === null ? s.score : Math.min(score, s.score)
    } else {
      classes[s.label] = (classes[s.label] ?? 0) + 1
    }
  }
  return { count: shapes.length - ai, ai, score, classes }
}
