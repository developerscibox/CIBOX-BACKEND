import { test } from "node:test";
import assert from "node:assert/strict";

import { planDeDespacho, cuadra } from "../src/inventario/pick.js";

// Reglas del faltante, que es donde el inventario se descuadraba solo:
// registrarFaltante ajusta el físico al reportar, y el despacho NO debe volver a
// descontar esas unidades. Estas pruebas fijan la aritmética que usan tanto el
// despacho como la reposición al cancelar/reembolsar/eliminar.

const item = (id, qty) => ({ product_id: id, quantity: qty });

test("sin faltantes, sale del estante todo lo pedido", () => {
  const plan = planDeDespacho([item("a", 10), item("b", 3)], []);
  assert.deepEqual(plan.map((p) => p.real), [10, 3]);
  assert.deepEqual(plan.map((p) => p.faltante), [0, 0]);
  assert.ok(cuadra(plan));
});

test("con faltante, del estante sale solo lo encontrado", () => {
  const plan = planDeDespacho([item("a", 10)], [{ product_id: "a", qty_real: 6 }]);
  assert.equal(plan[0].real, 6, "salen 6 del físico");
  assert.equal(plan[0].faltante, 4, "las otras 4 solo se liberan de lo reservado");
  assert.ok(cuadra(plan), "real + faltante debe ser siempre lo esperado");
});

test("reportar el mismo faltante dos veces no cambia el plan", () => {
  // La idempotencia real vive en registrarFaltante (que ajusta solo la
  // diferencia), pero el plan tampoco puede duplicar: se queda con el último
  // qty_real reportado para el producto.
  const dosVeces = planDeDespacho(
    [item("a", 10)],
    [
      { product_id: "a", qty_real: 6 },
      { product_id: "a", qty_real: 6 },
    ],
  );
  assert.equal(dosVeces[0].real, 6);
  assert.equal(dosVeces[0].faltante, 4);
  assert.ok(cuadra(dosVeces));
});

test("un faltante corregido después manda el último valor", () => {
  const plan = planDeDespacho(
    [item("a", 10)],
    [
      { product_id: "a", qty_real: 3 },
      { product_id: "a", qty_real: 8 }, // apareció más mercadería
    ],
  );
  assert.equal(plan[0].real, 8);
  assert.equal(plan[0].faltante, 2);
});

test("un faltante mayor que lo pedido no genera cantidades negativas", () => {
  const plan = planDeDespacho([item("a", 5)], [{ product_id: "a", qty_real: 99 }]);
  assert.equal(plan[0].real, 5, "no puede salir más de lo pedido");
  assert.equal(plan[0].faltante, 0);
  assert.ok(cuadra(plan));
});

test("faltante total: no sale nada del físico", () => {
  const plan = planDeDespacho([item("a", 4)], [{ product_id: "a", qty_real: 0 }]);
  assert.equal(plan[0].real, 0);
  assert.equal(plan[0].faltante, 4);
  assert.ok(cuadra(plan));
});

test("la reposición al cancelar devuelve solo lo que salió del estante", () => {
  // Es el mismo plan el que decide cuánto se repone: las unidades faltantes
  // nunca estuvieron físicamente, así que devolverlas inventaría stock.
  const plan = planDeDespacho([item("a", 10), item("b", 5)], [{ product_id: "a", qty_real: 6 }]);
  const aReponer = new Map(plan.map((p) => [p.product_id, p.real]));
  assert.equal(aReponer.get("a"), 6, "de 'a' se repone lo que salió, no lo pedido");
  assert.equal(aReponer.get("b"), 5, "'b' no tuvo faltante: se repone completo");
});
