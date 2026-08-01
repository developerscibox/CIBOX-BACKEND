import { env } from "../config/env.js";

// Cookie httpOnly para el refresh token: inaccesible a JavaScript (mitiga el
// robo del refresh por XSS). El access token de corta vida sigue en el body.
//
// En PRODUCCIÓN (HTTPS), si la tienda y el API están en subdominios distintos
// (tudominio.cl ↔ api.tudominio.cl), SameSite=None + Secure permite enviar la
// cookie en peticiones cross-site; con REFRESH_COOKIE_DOMAIN=.tudominio.cl se
// comparte entre subdominios.
// En DEV (HTTP, cross-origin por puerto distinto) la cookie NO se envía en XHR
// cross-origin → el flujo cae al refreshToken del body (fallback). Por eso el
// backend lee cookie OR body, sin romper el desarrollo local.
const COOKIE_NAME = "b12_rt";
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 días

const cookieOptions = () => ({
  httpOnly: true,
  secure: env.isProd,
  sameSite: env.isProd ? "none" : "lax",
  path: "/api/auth",
  ...(process.env.REFRESH_COOKIE_DOMAIN
    ? { domain: process.env.REFRESH_COOKIE_DOMAIN }
    : {}),
});

export const setRefreshCookie = (res, token) => {
  if (!token) return;
  res.cookie(COOKIE_NAME, token, { ...cookieOptions(), maxAge: MAX_AGE_MS });
};

export const clearRefreshCookie = (res) => {
  res.clearCookie(COOKIE_NAME, cookieOptions());
};

export const readRefreshCookie = (req) => {
  const header = req.headers?.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === COOKIE_NAME) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
};
