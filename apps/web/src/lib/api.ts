import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";

export class ApiError extends Error {
  status: number;
  issues: { path: string; message: string }[];

  constructor(message: string, status: number, issues: { path: string; message: string }[] = []) {
    super(message);
    this.status = status;
    this.issues = issues;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(body?.error ?? res.statusText, res.status, body?.issues ?? []);
  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) => request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

export function useApi<T>(path: string, options: Partial<UseQueryOptions<T>> = {}) {
  return useQuery<T>({ queryKey: [path], queryFn: () => api.get<T>(path), ...options });
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

export function useCreate<T>(resource: string) {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: (body: unknown) => api.post<T>(`/api/${resource}`, body),
    onSuccess: invalidate,
  });
}

export function useUpdate<T>(resource: string) {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: unknown }) => api.put<T>(`/api/${resource}/${id}`, body),
    onSuccess: invalidate,
  });
}

export function useDelete(resource: string) {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: (id: number) => api.del(`/api/${resource}/${id}`),
    onSuccess: invalidate,
  });
}
