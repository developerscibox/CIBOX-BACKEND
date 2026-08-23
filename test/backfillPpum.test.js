import test from "node:test";
import assert from "node:assert/strict";

import { contenidoDesdeNombre } from "../scripts/backfillPpum.js";

test("lee la medida escrita en el nombre", () => {
  assert.deepEqual(contenidoDesdeNombre("GALLETA AGUA COSTA 175G"), {
    value: 175, unit: "g", origen: "medida en el nombre",
  });
  assert.equal(contenidoDesdeNombre("ACEITE MARAVILLA COLISEO 900CC").unit, "ml");
  assert.equal(contenidoDesdeNombre("AGUA TONICA NORDIC 1.5 L").value, 1.5);
  assert.equal(contenidoDesdeNombre("AZUCAR BLANCA IANSA 25K").value, 25);
});

test("NxM multiplica: es el papel higiénico del art. 11 n°5", () => {
  assert.deepEqual(contenidoDesdeNombre("PAPEL HIGIENICO SUAV Y ROLL JUMBO 6X300M"), {
    value: 1800, unit: "m", origen: "6 x 300 m",
  });
  assert.equal(contenidoDesdeNombre("PAPEL HIGIENICO ELITE DOB HOJA 4X50MT").value, 200);
});

test("la letra de formato sola vale por 1 de esa unidad", () => {
  assert.deepEqual(contenidoDesdeNombre("PAN RALLADO K"), { value: 1, unit: "kg", origen: 'formato "K"' });
  assert.equal(contenidoDesdeNombre("VINAGRE BLANCO RICO L").unit, "L");
  assert.equal(contenidoDesdeNombre("AJO CABEZA U").unit, "un");
  assert.equal(contenidoDesdeNombre("CEREAL CORNFLAKES K ECONOMICO").unit, "kg");
});

test("frutas y verduras traen el formato entre paréntesis", () => {
  assert.equal(contenidoDesdeNombre("Tomate Mediano (kg)").unit, "kg");
  assert.equal(contenidoDesdeNombre("Lechuga Costina (c/u)").unit, "un");
  assert.equal(contenidoDesdeNombre("Cebollín (Paquete)").unit, "un");
});

test("medida Y conteo sueltos quedan ambiguos, no se adivina", () => {
  // "8G X500U" son 500 sachets de 8 g, pero "650G 8 U" son 8 panes que pesan
  // 650 g en total. Publicar el caso equivocado sería publicar un precio falso.
  assert.deepEqual(contenidoDesdeNombre("PAN HAMBURGUESA FUCH 650G 8 U"), { ambiguo: true });
  assert.deepEqual(contenidoDesdeNombre("GALLETA ALFAJOR GRAN VALLE 700G 100U"), { ambiguo: true });
});

test("un nombre sin medida no inventa nada", () => {
  assert.equal(contenidoDesdeNombre("CEPILLO DENTAL FLEXI COLGATE"), null);
  assert.equal(contenidoDesdeNombre("TOFU"), null);
  assert.equal(contenidoDesdeNombre(""), null);
});
