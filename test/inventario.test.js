import { test } from "node:test";
import assert from "node:assert/strict";

import { planDeDespacho, cuadra } from "../src/inventario/pick.js";
import { nivelDeStock, disponibleDe, resumenAlertas } from "../src/inventario/alertas.js";
import { MOVEMENT_TYPES, MOVEMENT_FAMILY, MANUAL_MOVEMENT_TYPES } from "../src/utils/constants.js";

// ── Despacho: el stock nunca se descuenta dos veces ─────────────────────────

test("despacho sin faltantes: sale del físico exactamente lo pedido", () => {
  const plan = planDeDespacho([
    { product_id: "a", quantity: 3 },
    { product_id: "b", quantity: 10 },
  ]);
  assert.deepEqual(plan, [
    { product_id: "a", esperado: 3, real: 3, faltante: 0 },
    { product_id: "b", esperado: 10, real: 10, faltante: 0 },
  ]);
  assert.ok(cuadra(plan));
});

test("despacho con faltante: solo sale lo encontrado (lo faltante ya se descontó al reportarlo)", () => {
  const plan = planDeDespacho(
    [{ product_id: "a", quantity: 10 }],
    [{ product_id: "a", qty_real: 4 }],
  );
  assert.deepEqual(plan, [{ product_id: "a", esperado: 10, real: 4, faltante: 6 }]);
  assert.ok(cuadra(plan), "real + faltante debe ser exactamente lo reservado");
});

test("faltante total: no sale nada del físico, se libera todo lo reservado", () => {
  const plan = planDeDespacho(
    [{ product_id: "a", quantity: 5 }],
    [{ product_id: "a", qty_real: 0 }],
  );
  assert.deepEqual(plan, [{ product_id: "a", esperado: 5, real: 0, faltante: 5 }]);
  assert.ok(cuadra(plan));
});

test("un faltante con más unidades de las pedidas no descuenta de más", () => {
  const plan = planDeDespacho(
    [{ product_id: "a", quantity: 5 }],
    [{ product_id: "a", qty_real: 99 }],
  );
  assert.deepEqual(plan, [{ product_id: "a", esperado: 5, real: 5, faltante: 0 }]);
  assert.ok(cuadra(plan));
});

test("un faltante negativo se trata como 0, no como stock a favor", () => {
  const plan = planDeDespacho(
    [{ product_id: "a", quantity: 4 }],
    [{ product_id: "a", qty_real: -3 }],
  );
  assert.deepEqual(plan, [{ product_id: "a", esperado: 4, real: 0, faltante: 4 }]);
  assert.ok(cuadra(plan));
});

test("el faltante de un producto no afecta a los demás ítems del pedido", () => {
  const plan = planDeDespacho(
    [
      { product_id: "a", quantity: 2 },
      { product_id: "b", quantity: 7 },
    ],
    [{ product_id: "b", qty_real: 5 }],
  );
  assert.deepEqual(plan.find((p) => p.product_id === "a"), { product_id: "a", esperado: 2, real: 2, faltante: 0 });
  assert.deepEqual(plan.find((p) => p.product_id === "b"), { product_id: "b", esperado: 7, real: 5, faltante: 2 });
  assert.ok(cuadra(plan));
});

// ── Alertas de stock ────────────────────────────────────────────────────────

test("disponible descuenta lo reservado por carritos y lo comprometido a pedidos", () => {
  assert.equal(disponibleDe({ stock: 100, reserved: 10, allocated: 25 }), 65);
  assert.equal(disponibleDe({ stock: 5, reserved: 10 }), 0, "nunca negativo");
});

test("sin disponible el nivel es quiebre, aunque quede físico comprometido", () => {
  assert.equal(nivelDeStock({ stock: 40, allocated: 40, min_stock: 10 }), "quiebre");
});

test("bajo el punto de reorden el nivel es crítico", () => {
  assert.equal(nivelDeStock({ stock: 10, min_stock: 10 }), "critico");
  assert.equal(nivelDeStock({ stock: 9, min_stock: 10 }), "critico");
});

test("hasta 1,5× el punto de reorden el nivel es bajo; por encima, ok", () => {
  assert.equal(nivelDeStock({ stock: 15, min_stock: 10 }), "bajo");
  assert.equal(nivelDeStock({ stock: 16, min_stock: 10 }), "ok");
});

test("sin punto de reorden se usa el umbral general", () => {
  assert.equal(nivelDeStock({ stock: 8 }, 10), "bajo");
  assert.equal(nivelDeStock({ stock: 11 }, 10), "ok");
});

test("resumen de alertas cuenta cada nivel", () => {
  const r = resumenAlertas(
    [
      { stock: 0 },                      // quiebre
      { stock: 3, min_stock: 5 },        // critico
      { stock: 7, min_stock: 5 },        // bajo
      { stock: 500, min_stock: 5 },      // ok
    ],
    10,
  );
  assert.deepEqual(r, { quiebre: 1, critico: 1, bajo: 1, ok: 1, total: 4 });
});

// ── Kardex: las cuatro familias del negocio ────────────────────────────────

test("cada tipo de movimiento cae en una familia: entrada, salida, ajuste o merma", () => {
  const familias = new Set(Object.values(MOVEMENT_FAMILY));
  assert.deepEqual([...familias].sort(), ["ajuste", "entrada", "merma", "salida"]);
  for (const tipo of Object.values(MOVEMENT_TYPES)) {
    assert.ok(MOVEMENT_FAMILY[tipo], `el tipo "${tipo}" no tiene familia asignada`);
  }
});

test("la merma es un tipo propio y se puede registrar a mano", () => {
  assert.equal(MOVEMENT_TYPES.MERMA, "merma");
  assert.ok(MANUAL_MOVEMENT_TYPES.includes(MOVEMENT_TYPES.MERMA));
  assert.ok(!MANUAL_MOVEMENT_TYPES.includes(MOVEMENT_TYPES.SALE), "una venta no se registra a mano");
});
