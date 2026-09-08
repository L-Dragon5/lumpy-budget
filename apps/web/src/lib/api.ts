import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { treaty } from "@elysiajs/eden";
import type { App } from "@lumpy/api";
import { EDEN_OPTIONS } from "./eden-options";

/**
 * Same origin: Vite proxies /api to the API in dev, and in a build the two are
 * served together. The client's types come from the server's own route types,
 * so a renamed route or a changed column is a typecheck failure here.
 * EDEN_OPTIONS is load-bearing, not cosmetic -- see eden-options.ts.
 */
export const eden = treaty<App>(window.location.origin, EDEN_OPTIONS);

/** The shape Elysia returns for a 422. Recorded in services/api/test/fixtures/validation-error.json. */
type ValidationBody = { errors?: { path?: unknown; message?: string }[]; message?: string };

export class ApiError extends Error {
  status: number;
  issues: { path: string; message: string }[];

  constructor(message: string, status: number, issues: { path: string; message: string }[] = []) {
    super(message);
    this.status = status;
    this.issues = issues;
  }

  /** Takes an Eden failure ({ status, value }) exactly as it comes off a call. */
  static from(failure: unknown): ApiError {
    const { status, value } = (failure ?? {}) as { status?: unknown; value?: unknown };
    const code = typeof status === "number" ? status : 0;
    const body = (value ?? failure ?? {}) as ValidationBody & { error?: string };
    const issues = (Array.isArray(body.errors) ? body.errors : []).map((e) => ({
      path: Array.isArray(e.path) ? e.path.join(".") : String(e.path ?? ""),
      message: e.message ?? "is invalid",
    }));
    return new ApiError(body.error ?? body.message ?? `request failed (${code})`, code, issues);
  }
}

/** The most specific thing we can say about a failure: the field, then the message. */
export function errorText(error: unknown, fallback = "Could not save. Try again."): string {
  const issues = error instanceof ApiError ? error.issues : [];
  if (issues.length > 0) return issues.map((i) => `${i.path}: ${i.message}`).join("; ");
  return error instanceof Error ? error.message : fallback;
}

type EdenResponse = { data: unknown; error: unknown; status: number };
type Payload<R> = R extends { data: infer D } ? Exclude<D, null> : never;

/** Eden hands failures back in `error`; react-query needs a throw to see them. */
async function unwrap<R extends EdenResponse>(call: Promise<R>): Promise<Payload<R>> {
  const res = await call;
  if (res.error) throw ApiError.from(res.error);
  return res.data as Payload<R>;
}

/**
 * keepPreviousData is why changing a filter does not blink. A new key (another
 * month, another bucket) is a cache miss, so without it `isLoading` goes true and
 * every page's `if (isLoading) return <Loading />` tears the whole screen down to
 * a spinner and rebuilds it. Holding the last key's data keeps `isLoading` true
 * only on a genuine first load; the numbers swap in place when the fetch lands.
 */
export function useApi<R extends EdenResponse>(key: readonly unknown[], call: () => Promise<R>) {
  return useQuery<Payload<R>, ApiError>({
    queryKey: key,
    queryFn: () => unwrap(call()),
    placeholderData: keepPreviousData,
  });
}

/**
 * Every write invalidates everything. The whole dataset is a few hundred rows,
 * and a stale "available to spend" is worse than a redundant refetch.
 * ponytail: narrow the invalidation the day a page feels slow.
 */
export function useInvalidateAll() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries();
}

/**
 * One mutation hook instead of a create/update/delete trio: the call site passes
 * the Eden call itself, so the body type is checked against the server's schema.
 *
 *   const create = useMutate((body: FixedCostInput) => eden.api["fixed-costs"].post(body))
 *   const update = useMutate((v: { id: number; body: FixedCostInput }) => eden.api["fixed-costs"]({ id: v.id }).put(v.body))
 *   const remove = useMutate((id: number) => eden.api["fixed-costs"]({ id }).delete())
 */
export function useMutate<V, R extends EdenResponse>(call: (vars: V) => Promise<R>) {
  const invalidate = useInvalidateAll();
  return useMutation<Payload<R>, ApiError, V>({
    mutationFn: (vars) => unwrap(call(vars)),
    onSuccess: invalidate,
  });
}
