import type { CareflowApp } from '@/shared/http/types.js';

export interface TestResponse<T = unknown> {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: T;
  readonly cookies: string;
}

const cookieHeader = (setCookie: string | string[] | undefined): string => {
  if (setCookie === undefined) return '';
  const values = Array.isArray(setCookie) ? setCookie : [setCookie];
  return values.map((entry) => entry.split(';')[0]).join('; ');
};

export const request = async <T = unknown>(
  app: CareflowApp,
  options: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    url: string;
    token?: string;
    body?: Record<string, unknown> | unknown[];
    headers?: Record<string, string>;
    cookies?: string;
  },
): Promise<TestResponse<T>> => {
  const headers: Record<string, string> = { ...options.headers };

  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  if (options.token !== undefined) {
    headers.authorization = `Bearer ${options.token}`;
  }
  if (options.cookies !== undefined && options.cookies.length > 0) {
    headers.cookie = options.cookies;
  }

  const response = await app.inject({
    method: options.method,
    url: options.url,
    headers,
    payload: options.body,
  });

  const parsed = (response.body.length === 0 ? null : JSON.parse(response.body)) as T;

  return {
    status: response.statusCode,
    headers: response.headers as Record<string, string | string[] | undefined>,
    body: parsed,
    cookies: cookieHeader(response.headers['set-cookie']),
  };
};

export const errorCode = (response: TestResponse): string | undefined => {
  const body = response.body as { error?: { code?: string } } | null;
  return body?.error?.code;
};
