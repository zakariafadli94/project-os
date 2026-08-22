export interface DropboxAttemptResult {
  ok: boolean;
  status: number;
  body: string;
}

export interface DropboxRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  random?: () => number;
}

export function isTransientDropboxFailure(status: number, body: string): boolean {
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return true;
  return body.includes("too_many_write_operations") || body.includes("internal_error");
}

export async function retryDropboxWrite<T extends DropboxAttemptResult>(
  operation: (attempt: number) => Promise<T>,
  options: DropboxRetryOptions = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 250;
  const sleep = options.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const random = options.random ?? Math.random;

  if (maxAttempts < 1) throw new Error("maxAttempts must be at least 1");

  let result!: T;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    result = await operation(attempt);
    if (result.ok || !isTransientDropboxFailure(result.status, result.body) || attempt === maxAttempts) {
      return result;
    }

    const exponential = baseDelayMs * (2 ** (attempt - 1));
    const jitter = Math.floor(exponential * 0.5 * random());
    await sleep(exponential + jitter);
  }

  return result;
}
