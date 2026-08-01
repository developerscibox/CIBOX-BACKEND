import { test } from "node:test";
import assert from "node:assert/strict";

import {
  agingCuentasPorCobrar,
  aQuienLlamarHoy,
  chequesPorVencer,
} from "../src/cobranza/aging.js";

const HOY = "2026-06-25";

const DEUDAS = [
  { cliente: "Almacén A", documento: "F1", fecha_vencimiento: "2026-06-30", monto: 100000 }, // vigente
  { cliente: "Almacén B", documento: "F2", fecha_vencimiento: "2026-06-10", monto: 200000 }, // 15 días → 0-30
  { cliente: "Almacén C", documento: "F3", fecha_vencimiento: "2026-05-01", monto: 300000 }, // 55 días → 31-60
  { cliente: "Almacén D", documento: "F4", fecha_vencimiento: "2026-02-01", monto: 400000 }, // +90
];

test("aging: clasifica por tramo y suma el total", () => {
  const { total, buckets } = agingCuentasPorCobrar(DEUDAS, HOY);
  assert.equal(total, 1_000_000);
  assert.equal(buckets.vigente, 100000);
  assert.equal(buckets["0-30"], 200000);
  assert.equal(buckets["31-60"], 300000);
  assert.equal(buckets["+90"], 400000);
});

test("a quién llamar hoy: solo vencidas, más atrasada primero", () => {
  const lista = aQuienLlamarHoy(DEUDAS, HOY);
  assert.equal(lista.length, 3); // la vigente no entra
  assert.equal(lista[0].cliente, "Almacén D"); // la más vencida
  assert.ok(lista[0].diasVencida > lista[1].diasVencida);
});

test("cheques por vencer: dentro de la ventana de días", () => {
  const cheques = [
    { cliente: "A", numero: "001", monto: 50000, fecha_vencimiento: "2026-06-27" }, // en 2 días
    { cliente: "B", numero: "002", monto: 80000, fecha_vencimiento: "2026-07-20" }, // lejos
    { cliente: "C", numero: "003", monto: 30000, fecha_vencimiento: "2026-06-25" }, // hoy
  ];
  const proximos = chequesPorVencer(cheques, HOY, 7);
  assert.equal(proximos.length, 2);
  assert.equal(proximos[0].numero, "003"); // hoy primero
  assert.equal(proximos[1].numero, "001");
});
