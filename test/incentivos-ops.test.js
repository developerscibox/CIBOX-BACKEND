import { test } from "node:test";
import assert from "node:assert/strict";

import { cuadreZ } from "../src/incentivos/cuadreZ.js";
import { alertasStock } from "../src/incentivos/alertasStock.js";
import {
  liquidacionDesdeTablero,
  totalLiquidacion,
} from "../src/incentivos/liquidacion.js";

test("cuadre Z: agrupa por método y por cajero, cuadra el total", () => {
  const ordenes = [
    { total: 31920, payment: { method: "efectivo" }, cajero: "Cajero 1" },
    { total: 10000, payment: { method: "transferencia" }, cajero: "Cajero 1" },
    { total: 5000, payment: { method: "efectivo" }, cajero: "Cajero 2" },
  ];
  const z = cuadreZ(ordenes);
  assert.equal(z.total, 46920);
  assert.equal(z.count, 3);
  assert.equal(z.byMethod.efectivo, 36920);
  assert.equal(z.byMethod.transferencia, 10000);
  assert.equal(z.byCajero[0].cajero, "Cajero 1");
  assert.equal(z.byCajero[0].total, 41920);
});

test("alertas de stock: clasifica negativo / quiebre / crítico y prioriza", () => {
  const productos = [
    { name: "Arroz", stock: 100, reserved: 0, allocated: 0 }, // ok, sin alerta
    { name: "Aceite", stock: 8, reserved: 0, allocated: 0 }, // crítico (<=10)
    { name: "Azúcar", stock: 5, reserved: 5, allocated: 0 }, // quiebre (disp 0)
    { name: "Fideos", stock: 2, reserved: 5, allocated: 0 }, // negativo (disp -3)
  ];
  const a = alertasStock(productos, 10);
  assert.equal(a.length, 3); // arroz no alerta
  assert.equal(a[0].nivel, "negativo");
  assert.equal(a[0].name, "Fideos");
  assert.equal(a[1].nivel, "quiebre");
  assert.equal(a[2].nivel, "critico");
});

test("liquidación: totalPagar = comisión + bono", () => {
  const tablero = [
    { vendedor: "Susana Silva", comision: 170407, bono: 200000 },
    { vendedor: "Matias", comision: 107420, bono: 0 },
  ];
  const liq = liquidacionDesdeTablero(tablero);
  assert.equal(liq[0].totalPagar, 370407);
  assert.equal(liq[1].totalPagar, 107420);
  assert.equal(totalLiquidacion(liq), 477827);
});
