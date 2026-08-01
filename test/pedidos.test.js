import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ORDER_STATUS,
  VALID_TRANSITIONS,
  TERMINAL_STATUSES,
  puedeTransicionar,
  siguientesEstados,
  caminoDe,
  lineaDeTiempo,
  avancePct,
} from "../src/pedidos/estados.js";

// ── La máquina de estados ───────────────────────────────────────────────────

test("el camino feliz con despacho pasa por todas las etapas, sin atajos", () => {
  const camino = caminoDe("delivery");
  for (let i = 0; i < camino.length - 1; i++) {
    const r = puedeTransicionar(camino[i], camino[i + 1], { deliveryMethod: "delivery" });
    assert.ok(r.ok, `${camino[i]} → ${camino[i + 1]} debería ser válida: ${r.motivo}`);
  }
});

test("un pedido con despacho no puede saltarse 'en camino'", () => {
  const r = puedeTransicionar(ORDER_STATUS.READY, ORDER_STATUS.DELIVERED, { deliveryMethod: "delivery" });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /en camino/);
});

test("un retiro en tienda sí va de listo a entregado (no hay reparto)", () => {
  assert.ok(puedeTransicionar(ORDER_STATUS.READY, ORDER_STATUS.DELIVERED, { deliveryMethod: "pickup" }).ok);
});

test("no se puede preparar un pedido sin pagar", () => {
  assert.equal(puedeTransicionar(ORDER_STATUS.PENDING, ORDER_STATUS.PREPARING).ok, false);
});

test("no se puede saltar de preparación a en camino sin empacar", () => {
  assert.equal(puedeTransicionar(ORDER_STATUS.PREPARING, ORDER_STATUS.SHIPPED).ok, false);
});

test("no se puede retroceder un pedido", () => {
  assert.equal(puedeTransicionar(ORDER_STATUS.DELIVERED, ORDER_STATUS.SHIPPED).ok, false);
  assert.equal(puedeTransicionar(ORDER_STATUS.READY, ORDER_STATUS.PREPARING).ok, false);
  assert.equal(puedeTransicionar(ORDER_STATUS.PAID, ORDER_STATUS.PENDING).ok, false);
});

test("los estados terminales no llevan a ninguna parte", () => {
  for (const t of TERMINAL_STATUSES) {
    assert.deepEqual(VALID_TRANSITIONS[t], [], `${t} debería ser terminal`);
  }
});

test("se puede anular en cualquier etapa anterior a la entrega, pero no después", () => {
  for (const s of [ORDER_STATUS.PENDING, ORDER_STATUS.PAID, ORDER_STATUS.PREPARING, ORDER_STATUS.READY]) {
    assert.ok(puedeTransicionar(s, ORDER_STATUS.CANCELLED).ok, `${s} debería poder anularse`);
  }
  assert.equal(puedeTransicionar(ORDER_STATUS.SHIPPED, ORDER_STATUS.CANCELLED).ok, false);
  assert.equal(puedeTransicionar(ORDER_STATUS.DELIVERED, ORDER_STATUS.CANCELLED).ok, false);
});

test("un pedido entregado solo puede reembolsarse", () => {
  assert.deepEqual(siguientesEstados(ORDER_STATUS.DELIVERED), [ORDER_STATUS.REFUNDED]);
});

test("un estado desconocido nunca transiciona", () => {
  const r = puedeTransicionar("inventado", ORDER_STATUS.PAID);
  assert.equal(r.ok, false);
  assert.match(r.motivo, /desconocido/);
});

// ── Seguimiento del cliente ─────────────────────────────────────────────────

const historia = [
  { status: "pending", changed_at: "2026-08-01T10:00:00Z", changed_by: { label: "cliente" } },
  { status: "paid", changed_at: "2026-08-01T10:05:00Z", changed_by: { label: "webpay" } },
  { status: "preparing", changed_at: "2026-08-01T11:00:00Z", changed_by: { label: "Ana" } },
];

test("la línea de tiempo marca lo cumplido, lo actual y lo que falta", () => {
  const pasos = lineaDeTiempo({ status: "preparing", delivery_method: "delivery", status_history: historia });
  assert.equal(pasos.length, 6); // pending → paid → preparing → ready → shipped → delivered
  assert.deepEqual(pasos.map((p) => p.cumplido), [true, true, true, false, false, false]);
  assert.equal(pasos.find((p) => p.actual).estado, "preparing");
});

test("cada etapa cumplida dice cuándo fue y quién la hizo", () => {
  const pasos = lineaDeTiempo({ status: "preparing", delivery_method: "delivery", status_history: historia });
  const prep = pasos.find((p) => p.estado === "preparing");
  assert.equal(prep.por, "Ana");
  assert.equal(prep.fecha, "2026-08-01T11:00:00Z");
  const futuro = pasos.find((p) => p.estado === "shipped");
  assert.equal(futuro.fecha, null);
  assert.equal(futuro.por, null);
});

test("el retiro en tienda no muestra la etapa 'en camino'", () => {
  const pasos = lineaDeTiempo({ status: "ready", delivery_method: "pickup", status_history: historia });
  assert.equal(pasos.length, 5);
  assert.ok(!pasos.some((p) => p.estado === "shipped"));
});

test("un pedido anulado agrega su etapa al final, marcada como anómala", () => {
  const pasos = lineaDeTiempo({
    status: "cancelled",
    delivery_method: "delivery",
    status_history: [...historia, { status: "cancelled", changed_at: "2026-08-01T12:00:00Z", changed_by: { label: "soporte" } }],
  });
  const ultimo = pasos[pasos.length - 1];
  assert.equal(ultimo.estado, "cancelled");
  assert.equal(ultimo.anomalo, true);
  assert.equal(ultimo.por, "soporte");
});

test("el avance va de 0 a 100 y un pedido anulado no muestra avance", () => {
  assert.equal(avancePct({ status: "pending", delivery_method: "delivery" }), 0);
  assert.equal(avancePct({ status: "delivered", delivery_method: "delivery" }), 100);
  assert.equal(avancePct({ status: "ready", delivery_method: "pickup" }), 75);
  assert.equal(avancePct({ status: "cancelled", delivery_method: "delivery" }), 0);
});
