export interface LoadOptions {
  durationMs: number;
  concurrency: number;
}

export interface LoadResult {
  sent: number;
  errors: number;
}

/**
 * Fires continuous /work traffic at the proxy for the given duration, using
 * `concurrency` parallel workers each looping request-after-request (not a
 * fixed rate) — good enough to generate the sample volume the statistical
 * test needs during a stage's hold period, without pretending to model a
 * particular real-world request-rate distribution.
 */
export async function runLoad(proxyUrl: string, opts: LoadOptions): Promise<LoadResult> {
  const deadline = Date.now() + opts.durationMs;
  let sent = 0;
  let errors = 0;

  async function worker(): Promise<void> {
    while (Date.now() < deadline) {
      sent++;
      try {
        const response = await fetch(`${proxyUrl}/work`);
        if (!response.ok) errors++;
        await response.arrayBuffer();
      } catch {
        errors++;
      }
    }
  }

  await Promise.all(Array.from({ length: opts.concurrency }, () => worker()));
  return { sent, errors };
}
