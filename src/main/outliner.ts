import { parentPort } from 'worker_threads'
import { type LabelMap, outlineClasses } from './outline'

// Pre-labelling's worker thread: label maps in, one image after another, their polygons out (see outline() in prelabel.ts)
parentPort!.on('message', (map: LabelMap) => parentPort!.postMessage(outlineClasses(map)))
