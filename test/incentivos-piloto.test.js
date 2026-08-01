import test from "node:test";
import assert from "node:assert/strict";
import { calcularPuntos, rankingPiloto, DEFAULT_PILOTO } from "../src/incentivos/piloto.js";

test("calcularPuntos: 1 pt por unidad + 1 pt por cada $1.000", () => {
  const r = calcularPuntos({ unidades: 320, monto: 4128000 });
  assert.equal(r.ptsUnidad, 320);
  assert.equal(r.ptsMonto, 4128);
  assert.equal(r.total, 4448);
});

test("calcularPuntos: config modificable (2 pts por unidad)", () => {
  const r = calcularPuntos({ unidades: 10, monto: 0 }, { ...DEFAULT_PILOTO, puntosPorUnidad: 2 });
  assert.equal(r.ptsUnidad, 20);
  assert.equal(r.total, 20);
});

test("calcularPuntos: bono por meta", () => {
  const cfg = { ...DEFAULT_PILOTO, bonoMetaCLP: 1000000, bonoPuntos: 500 };
  assert.equal(calcularPuntos({ unidades: 0, monto: 1200000 }, cfg).ptsBono, 500);
  assert.equal(calcularPuntos({ unidades: 0, monto: 900000 }, cfg).ptsBono, 0);
});

test("rankingPiloto: ordena por puntos y asigna ranking", () => {
  const t = rankingPiloto([
    { label: "Ana", unidades: 100, monto: 1000000 },   // 100 + 1000 = 1100
    { label: "Beto", unidades: 50, monto: 3000000 },   // 50 + 3000 = 3050
  ]);
  assert.equal(t[0].label, "Beto");
  assert.equal(t[0].ranking, 1);
  assert.equal(t[0].puntos.total, 3050);
  assert.equal(t[1].label, "Ana");
});
