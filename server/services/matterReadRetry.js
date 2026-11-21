const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Only idempotent subscription reads use this policy. Pause/resume POSTs keep
// their existing timeout and are never retried here.
export async function readMatterGet(client, path, config = {}, { sleep = delay } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await client.get(path, { ...config, timeout: 30000 });
    } catch (error) {
      const status = error.response?.status;
      const transient = status ? [429, 502, 503, 504].includes(status)
        : ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'].includes(error.code);
      if (attempt || !transient) throw error;
      const retryAfter = error.response?.headers?.['retry-after'];
      const retryMs = retryAfter === undefined ? 500 : /^\d+(\.\d+)?$/.test(String(retryAfter))
        ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
      // Never ignore a long rate-limit window or wait without a finite bound.
      if (!Number.isFinite(retryMs) || retryMs > 2000) throw error;
      await sleep(Math.max(0, retryMs));
    }
  }
}
