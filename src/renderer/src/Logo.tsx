const PLATE = 'M174.27 0L337.73 0C387.91 0 413 0 440.01 8.54C469.5 19.27 492.73 42.5 503.46 71.99C512 99 512 124.09 512 174.27L512 337.73C512 387.91 512 413 503.46 440.01C492.73 469.5 469.5 492.73 440.01 503.46C413 512 387.91 512 337.73 512L174.27 512C124.09 512 99 512 71.99 503.46C42.5 492.73 19.27 469.5 8.54 440.01C0 413 0 387.91 0 337.73L0 174.27C0 124.09 0 99 8.54 71.99C19.27 42.5 42.5 19.27 71.99 8.54C99 0 124.09 0 174.27 0Z'
const SEAM = 'M322 -24C230 18 148 72 148 150C148 216 200 236 256 256C312 276 364 296 364 362C364 440 282 494 190 536'

// Below 40 px the handles would turn to noise, so the small drawing drops them and thickens the line
export default function Logo({ size }: { size: number }) {
  const small = size < 40
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden="true">
      <clipPath id="seamline-plate"><path d={PLATE} /></clipPath>
      <g clipPath="url(#seamline-plate)">
        <rect width="512" height="512" fill="#4f8cff" />
        <path d={`${SEAM}L536 536L536 -24Z`} fill="#1f49ad" />
        <path d={SEAM} fill="none" stroke="#14161a" strokeWidth={small ? 30 : 22} />
      </g>
      {!small && [[148, 150], [256, 256], [364, 362]].map(([x, y]) => (
        <circle key={x} cx={x} cy={y} r="25" fill="#fff" stroke="#14161a" strokeWidth="11" />
      ))}
    </svg>
  )
}
