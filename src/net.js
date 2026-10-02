const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/**
 * fetch has no timeout of its own, and on a flaky connection a request can
 * stall forever. Each attempt is bounded and retried with backoff; the
 * caller's signal still cancels everything at once.
 */
export async function fetchBuffer(url, { signal, timeout = 8000, retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const cancel = () => ctrl.abort(signal.reason);
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => ctrl.abort(new Error(`timed out: ${url}`)), timeout);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
      return await res.arrayBuffer();
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err;
      if (attempt >= retries) throw err;
      await sleep(400 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  }
}

/** Runs `worker` over `items` with at most `limit` in flight; stops on first failure. */
export async function pooled(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  let failed = false;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length && !failed) {
        const i = next++;
        try {
          results[i] = await worker(items[i], i);
        } catch (err) {
          failed = true;
          throw err;
        }
      }
    })
  );
  return results;
}
