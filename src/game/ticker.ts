/**
 * Like setInterval, but keeps firing in background tabs. Browsers throttle page timers there,
 * but not timers inside a worker. Returns a function that stops it.
 */
export function workerInterval(fn: () => void, ms: number): () => void {
  const worker = new Worker(
    URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${ms})`], { type: "text/javascript" })),
  );
  worker.onmessage = fn;
  return () => worker.terminate();
}
