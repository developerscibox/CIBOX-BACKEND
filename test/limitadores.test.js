import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * QUÉ CUIDA ESTA PRUEBA
 *
 * El 16-sep-2026 alguien del equipo quedó sin poder entrar ni recuperar su
 * contraseña. La causa: /auth/refresh, /auth/login, /auth/register y
 * /auth/reset-password compartían un mismo cupo de 10 intentos cada 15 minutos
 * por IP. La renovación de sesión no la pide una persona — la dispara el
 * navegador solo cuando la sesión vence, y al fallar con 401 gastaba el cupo.
 * Diez vencimientos (varias pestañas, o varias personas tras la misma IP de
 * oficina) dejaban la puerta cerrada para todos.
 *
 * Nadie lo vio venir porque compartir un limitador no se nota leyendo el
 * código: hay que caer en que `rateLimit()` crea UNA instancia con UN contador,
 * y que usarla en dos rutas las une. Esta prueba lo vuelve explícito.
 */

const leer = (ruta) => readFileSync(new URL(ruta, import.meta.url), "utf8");
const rutas = leer("../src/routes/authRoutes.js");
const limitadores = leer("../src/middlewares/rateLimiters.js");

/**
 * Nombre del limitador que protege una ruta de /api/auth. Se lee el archivo
 * como texto, sin expresiones frágiles: la declaración puede ocupar una línea
 * o varias, y lo único que importa es qué `xxxLimiter` aparece antes del `);`
 * que la cierra.
 */
const limitadorDe = (metodo, ruta) => {
  const lineas = rutas.split("\n");
  const marcaRuta = '"' + ruta + '"';
  const marcaRouter = "router." + metodo + "(";
  for (let i = 0; i < lineas.length; i++) {
    if (!lineas[i].includes(marcaRuta)) continue;
    // La ruta puede ir en la misma linea del router.post( o en la siguiente.
    const esDeEsteMetodo =
      lineas[i].includes(marcaRouter) ||
      (i > 0 && lineas[i - 1].trimEnd().endsWith(marcaRouter));
    if (!esDeEsteMetodo) continue;
    let bloque = "";
    for (let j = i; j < Math.min(i + 8, lineas.length); j++) {
      bloque += lineas[j] + "\n";
      if (lineas[j].includes(");")) break;
    }
    const m = bloque.match(/\b(\w+Limiter)\b/);
    return m ? m[1] : "sin-limitador";
  }
  return null;
};

test("la renovación de sesión NO comparte cupo con el inicio de sesión", () => {
  const refresh = limitadorDe("post", "/refresh");
  const login = limitadorDe("post", "/login");
  assert.equal(refresh, "refreshLimiter", "/auth/refresh debe usar su propio limitador");
  assert.notEqual(
    refresh,
    login,
    "Si comparten limitador, los reintentos automáticos del navegador vuelven a dejar a la gente sin poder entrar",
  );
});

test("el cambio de contraseña NO comparte cupo con el inicio de sesión", () => {
  const reset = limitadorDe("post", "/reset-password");
  const login = limitadorDe("post", "/login");
  assert.equal(reset, "resetPasswordLimiter");
  assert.notEqual(
    reset,
    login,
    "Compartirlo deja a quien pidió recuperar su clave sin poder usar el enlace del correo",
  );
});

test("las cuatro rutas sensibles tienen limitador", () => {
  for (const ruta of ["/login", "/register", "/refresh", "/reset-password"]) {
    const l = limitadorDe("post", ruta);
    assert.ok(l && l !== "sin-limitador", ruta + " quedó sin limitador");
  }
});

test("el cupo de la renovación es holgado: acota el abuso, no a las personas", () => {
  // En /auth/refresh no hay secreto que adivinar: el token es un valor
  // aleatorio largo que viaja en cookie httpOnly. Un tope estrecho solo daña.
  const bloque = limitadores.match(/export const refreshLimiter = rateLimit\(\{([\s\S]*?)\}\);/);
  assert.ok(bloque, "no se encontró refreshLimiter");
  const max = Number(bloque[1].match(/max:\s*(\d+)/)[1]);
  assert.ok(max >= 40, "el tope de renovación quedó en " + max + ": vuelve a bloquear gente real");
  assert.match(
    bloque[1],
    /skipSuccessfulRequests:\s*true/,
    "sin skipSuccessfulRequests las renovaciones exitosas también gastan cupo",
  );
});

test("pedir el correo de recuperación y usar el enlace no comparten cupo", () => {
  // Son dos pasos de la MISMA gestión: con un contador común, pedir el correo
  // dos veces impediría completar el cambio de contraseña.
  assert.notEqual(limitadorDe("post", "/forgot-password"), limitadorDe("post", "/reset-password"));
});
