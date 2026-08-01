import { test } from "node:test";
import assert from "node:assert/strict";

import { buildTiers, desglosarIva } from "../src/catalogo/precio.js";

test("buildTiers: producto de venta unitaria deja un solo tramo", () => {
  const tiers = buildTiers({ price: 1290, saleUnit: "unidad" });
  assert.deepEqual(tiers, [{ min_qty: 1, price: 1290, label: "unidad" }]);
});

test("buildTiers: el pack agrega un tramo con el precio POR UNIDAD dentro del pack", () => {
  const tiers = buildTiers({ price: 1000, packSize: 6, packPrice: 5400 });
  assert.equal(tiers.length, 2);
  assert.deepEqual(tiers[0], { min_qty: 1, price: 1000, label: "unidad" });
  assert.deepEqual(tiers[1], { min_qty: 6, price: 900, label: "pack de 6" });
});

test("buildTiers: sin precio de pack, el pack no tiene descuento", () => {
  const tiers = buildTiers({ price: 1000, packSize: 4 });
  assert.equal(tiers[1].price, 1000);
});

test("buildTiers: pack_size 1 o 0 no crea tramo de pack", () => {
  assert.equal(buildTiers({ price: 500, packSize: 1 }).length, 1);
  assert.equal(buildTiers({ price: 500, packSize: 0 }).length, 1);
});

test("buildTiers: el tramo de unidad siempre existe, incluso con precio 0", () => {
  const tiers = buildTiers({ price: 0 });
  assert.deepEqual(tiers, [{ min_qty: 1, price: 0, label: "unidad" }]);
});

test("desglosarIva: precio con IVA incluido se separa en neto + IVA", () => {
  const { neto, iva } = desglosarIva(1190, 19);
  assert.equal(neto, 1000);
  assert.equal(iva, 190);
  assert.equal(neto + iva, 1190); // el desglose nunca pierde ni inventa pesos
});

test("desglosarIva: producto exento deja todo en neto", () => {
  assert.deepEqual(desglosarIva(1190, 19, false), { neto: 1190, iva: 0 });
});
