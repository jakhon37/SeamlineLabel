import mark from './assets/seamtag-mark.svg'
import markSmall from './assets/seamtag-mark-small.svg'

// Below 64 px the mark's detail would turn to noise, so the small drawing keeps only the two sides, the shadow and a firmer rim
export default function Logo({ size }: { size: number }) {
  return <img src={size < 64 ? markSmall : mark} width={size} height={size} alt="" draggable={false} />
}
