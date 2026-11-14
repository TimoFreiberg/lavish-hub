export async function runCaptureWorkers(jobs, concurrency, capture) {
  const results = await Promise.allSettled(Array.from({ length: concurrency }, async () => {
    while (jobs.length) await capture(jobs.shift());
  }));
  const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
  if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join('; '));
}
