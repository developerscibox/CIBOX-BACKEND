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
//
// Hay DOS cookies, una por cliente web, porque las dos hablan con el mismo host
// (api.cibox.cl) y una cookie con el mismo nombre se pisaría: entrar al panel
// de bodega mataría la sesión de la tienda abierta en la misma pestaña de al
// lado, y al revés. El cliente dice quién es con `x-client-platform`.
const COOKIE_POR_CLIENTE = {
  web: "cibox_rt", // tienda
  panel: "cibox_rt_panel", // panel de bodega
};
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 días

const cookieName = (req) =>
  COOKIE_POR_CLIENTE[String(req?.headers?.["x-client-platform"] || "")] || COOKIE_POR_CLIENTE.web;

const cookieOptions = () => ({
  httpOnly: true,
  secure: env.isProd,
  sameSite: env.isProd ? "none" : "lax",
  path: "/api/auth",
  ...(process.env.REFRESH_COOKIE_DOMAIN
    ? { domain: process.env.REFRESH_COOKIE_DOMAIN }
    : {}),
});

export const setRefreshCookie = (req, res, token) => {
  if (!token) return;
  res.cookie(cookieName(req), token, { ...cookieOptions(), maxAge: MAX_AGE_MS });
};

export const clearRefreshCookie = (req, res) => {
  res.clearCookie(cookieName(req), cookieOptions());
};

export const readRefreshCookie = (req) => {
  const header = req.headers?.cookie;
  if (!header) return null;
  const name = cookieName(req);
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
};
