import { test } from "node:test";
import assert from "node:assert/strict";

import {
  getProveedorSeguimiento,
  SeguimientoLog,
  ESTADOS_SEGUIMIENTO,
  ESTADO_PEDIDO_SEGUN_SEGUIMIENTO,
} from "../src/integraciones/SeguimientoPort.js";
import { puedeTransicionar } from "../src/pedidos/estados.js";

const PEDIDO = {
  referencia: "A1B2C3",
  order_id: "665f1e2a3b4c5d6e7f809112",
  destinatario: { nombre: "Cliente", telefono: "+56900000000", email: "c@example.cl" },
  direccion: { linea1: "Calle 123", comuna: "Ñuñoa", region: "RM" },
  bultos: [{ n: 1, peso_kg: 4.2 }],
  total: 24990,
};

// ── La fábrica ──────────────────────────────────────────────────────────────

test("sin proveedor configurado se usa el adapter de log", () => {
  assert.ok(getProveedorSeguimiento() instanceof SeguimientoLog);
  assert.ok(getProveedorSeguimiento({ provider: "log" }) instanceof SeguimientoLog);
});

test("un proveedor declarado sin adapter falla explícito, no en silencio", () => {
  assert.throws(
    () => getProveedorSeguimiento({ provider: "courier-x" }),
    /no implementado/i,
    "debe decir claramente que falta escribir el adapter",
  );
});

// ── El contrato ─────────────────────────────────────────────────────────────

test("todo proveedor implementa los cuatro métodos del contrato", () => {
  const p = getProveedorSeguimiento();
  for (const m of ["enviarPedido", "consultarEstado", "normalizarWebhook", "verificarFirma"]) {
    assert.equal(typeof p[m], "function", `falta ${m}()`);
  }
});

test("enviarPedido devuelve una referencia externa y el estado inicial", async () => {
  const res = await getProveedorSeguimiento().enviarPedido(PEDIDO);
  assert.equal(res.ok, true);
  assert.equal(res.proveedor, "log");
  assert.equal(res.estado, ESTADOS_SEGUIMIENTO.RECIBIDO);
  assert.match(res.ref_externa, /^LOG-/, "el adapter falso marca sus referencias para no confundirlas con reales");
});

test("consultarEstado del adapter falso no inventa novedades", async () => {
  const res = await getProveedorSeguimiento().consultarEstado("LOG-A1B2C3");
  assert.equal(res.estado, ESTADOS_SEGUIMIENTO.DESCONOCIDO);
  assert.deepEqual(res.eventos, []);
});

// ── El webhook ──────────────────────────────────────────────────────────────

test("el webhook traduce los estados del proveedor a nuestro vocabulario", async () => {
  const p = getProveedorSeguimiento();
  const enRuta = await p.normalizarWebhook({ ref_externa: "LOG-1", estado: "in_transit" });
  assert.equal(enRuta.estado, ESTADOS_SEGUIMIENTO.EN_RUTA);
  const entregado = await p.normalizarWebhook({ reference: "LOG-1", status: "delivered" });
  assert.equal(entregado.estado, ESTADOS_SEGUIMIENTO.ENTREGADO);
});

test("un estado que no sabemos mapear no se inventa: queda como desconocido", async () => {
  const r = await getProveedorSeguimiento().normalizarWebhook({ ref_externa: "LOG-1", estado: "ovni" });
  assert.equal(r.estado, ESTADOS_SEGUIMIENTO.DESCONOCIDO);
});

test("un webhook sin referencia no se procesa", async () => {
  const r = await getProveedorSeguimiento().normalizarWebhook({ estado: "delivered" });
  assert.equal(r.ok, false);
});

// ── El proveedor informa, la máquina de estados manda ──────────────────────

test("solo 'en ruta' y 'entregado' mueven el pedido; el resto es informativo", () => {
  assert.equal(ESTADO_PEDIDO_SEGUN_SEGUIMIENTO[ESTADOS_SEGUIMIENTO.EN_RUTA], "shipped");
  assert.equal(ESTADO_PEDIDO_SEGUN_SEGUIMIENTO[ESTADOS_SEGUIMIENTO.ENTREGADO], "delivered");
  for (const e of [
    ESTADOS_SEGUIMIENTO.RECIBIDO,
    ESTADOS_SEGUIMIENTO.FALLIDO,
    ESTADOS_SEGUIMIENTO.DEVUELTO,
    ESTADOS_SEGUIMIENTO.DESCONOCIDO,
  ]) {
    assert.equal(ESTADO_PEDIDO_SEGUN_SEGUIMIENTO[e], null, `${e} no debería mover el pedido`);
  }
});

test("el proveedor no puede saltarse etapas ni resucitar un pedido anulado", () => {
  // "entregado" sobre un pedido que todavía se está preparando: transición inválida.
  assert.equal(
    puedeTransicionar("preparing", ESTADO_PEDIDO_SEGUN_SEGUIMIENTO[ESTADOS_SEGUIMIENTO.ENTREGADO]).ok,
    false,
  );
  // "en ruta" sobre un pedido anulado: imposible.
  assert.equal(
    puedeTransicionar("cancelled", ESTADO_PEDIDO_SEGUN_SEGUIMIENTO[ESTADOS_SEGUIMIENTO.EN_RUTA]).ok,
    false,
  );
  // El camino legítimo sí pasa.
  assert.equal(
    puedeTransicionar("ready", ESTADO_PEDIDO_SEGUN_SEGUIMIENTO[ESTADOS_SEGUIMIENTO.EN_RUTA]).ok,
    true,
  );
});
