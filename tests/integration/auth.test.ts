import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from '../helpers/app.js';
import { errorCode, request } from '../helpers/http.js';
import { TEST_PASSWORD, login, seedClinic } from '../helpers/fixtures.js';
import type { ComposedApp } from '@/composition.js';

describe('auth', () => {
  let ctx: ComposedApp;

  beforeAll(async () => {
    ctx = await startTestApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('issues an access token and a refresh cookie on login', async () => {
    const clinic = await seedClinic();
    const response = await request<{
      accessToken: string;
      refreshToken: string;
      user: { role: string; email: string };
    }>(ctx.app, {
      method: 'POST',
      url: '/v1/auth/login',
      body: { email: clinic.patient.email, password: TEST_PASSWORD },
    });

    expect(response.status).toBe(200);
    expect(response.body.accessToken.length).toBeGreaterThan(20);
    expect(response.body.user.role).toBe('PATIENT');
    expect(response.body.user.email).toBe(clinic.patient.email);
    expect(response.cookies).toMatch(/careflow_refresh=/);
    expect(response.body.refreshToken.length).toBeGreaterThan(20);
  });

  it('returns the same error for an unknown email and a wrong password', async () => {
    const clinic = await seedClinic();

    const unknown = await request(ctx.app, {
      method: 'POST',
      url: '/v1/auth/login',
      body: { email: 'nobody@careflow.test', password: TEST_PASSWORD },
    });
    const wrong = await request(ctx.app, {
      method: 'POST',
      url: '/v1/auth/login',
      body: { email: clinic.patient.email, password: 'definitely-not-the-password' },
    });

    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(errorCode(unknown)).toBe('INVALID_CREDENTIALS');
    expect(errorCode(wrong)).toBe(errorCode(unknown));
  });

  it('rotates the refresh token and rejects a reused family member', async () => {
    const clinic = await seedClinic();
    const first = await request<{ accessToken: string }>(ctx.app, {
      method: 'POST',
      url: '/v1/auth/login',
      body: { email: clinic.patient.email, password: TEST_PASSWORD },
    });
    const originalCookie = first.cookies;

    const rotated = await request<{ accessToken: string }>(ctx.app, {
      method: 'POST',
      url: '/v1/auth/refresh',
      cookies: originalCookie,
      body: {},
    });

    expect(rotated.status).toBe(200);
    expect(rotated.cookies).toMatch(/careflow_refresh=/);
    expect(rotated.cookies).not.toBe(originalCookie);

    // Presenting the retired token is reuse-detection: the whole family is revoked so a stolen
    // cookie that lost the rotation race cannot keep minting sessions.
    const reused = await request(ctx.app, {
      method: 'POST',
      url: '/v1/auth/refresh',
      cookies: originalCookie,
      body: {},
    });

    expect(reused.status).toBe(401);
  });

  it('identifies the caller on GET /v1/me and rejects a missing token', async () => {
    const clinic = await seedClinic();
    const session = await login(ctx.app, clinic.therapist.email);

    const me = await request<{ role: string; therapistId?: string }>(ctx.app, {
      method: 'GET',
      url: '/v1/me',
      token: session.token,
    });

    expect(me.status).toBe(200);
    expect(me.body.role).toBe('THERAPIST');
    expect(me.body.therapistId).toBe(clinic.therapist.therapistId);

    const anonymous = await request(ctx.app, { method: 'GET', url: '/v1/me' });
    expect(anonymous.status).toBe(401);
    expect(errorCode(anonymous)).toBe('AUTHENTICATION_REQUIRED');
  });

  it('clears the session on logout so a subsequent refresh fails', async () => {
    const clinic = await seedClinic();
    const session = await login(ctx.app, clinic.patient.email);

    const logout = await request(ctx.app, {
      method: 'POST',
      url: '/v1/auth/logout',
      cookies: session.cookies,
      token: session.token,
      body: {},
    });
    expect(logout.status).toBe(204);

    const refresh = await request(ctx.app, {
      method: 'POST',
      url: '/v1/auth/refresh',
      cookies: session.cookies,
      body: {},
    });
    expect(refresh.status).toBe(401);

    const stillAuthed = await request(ctx.app, {
      method: 'GET',
      url: '/v1/me',
      token: session.token,
    });
    expect(stillAuthed.status).toBe(401);
    expect(errorCode(stillAuthed)).toBe('AUTHENTICATION_REQUIRED');
  });

  it('refreshes from the JSON body when no cookie is sent', async () => {
    const clinic = await seedClinic();
    const first = await request<{ accessToken: string; refreshToken: string }>(ctx.app, {
      method: 'POST',
      url: '/v1/auth/login',
      body: { email: clinic.patient.email, password: TEST_PASSWORD },
    });

    const rotated = await request<{ accessToken: string; refreshToken: string }>(ctx.app, {
      method: 'POST',
      url: '/v1/auth/refresh',
      body: { refreshToken: first.body.refreshToken },
    });

    expect(rotated.status).toBe(200);
    expect(rotated.body.accessToken.length).toBeGreaterThan(20);
    expect(rotated.body.refreshToken).not.toBe(first.body.refreshToken);

    const reused = await request(ctx.app, {
      method: 'POST',
      url: '/v1/auth/refresh',
      body: { refreshToken: first.body.refreshToken },
    });
    expect(reused.status).toBe(401);
  });
});
