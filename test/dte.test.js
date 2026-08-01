import { test } from "node:test";
import assert from "node:assert/strict";

import { getDteEmitter, SandboxDteEmitter } from "../src/dte/DteEmitter.js";
import { conciliar } from "../src/dte/conciliacion.js";

test("DteEmitter: sandbox emite un resultado marcado como NO válido ante SII", async () => {
  const emisor = getDteEmitter(); // sin proveedor → sandbox
  assert.ok(emisor instanceof SandboxDteEmitter);
  const r = await emisor.emitir({ tipo: "boleta", total: 31920 });
  assert.equal(r.ok, true);
  assert.equal(r.entorno, "sandbox");
  assert.equal(r.estado, "no-valido-ante-sii");
});

test("DteEmitter: un proveedor real sin adapter falla explícito (B7), no en silencio", () => {
  assert.throws(() => getDteEmitter({ provider: "openfactura" }), /B7|no implementado/);
});

test("conciliación parallel-run: detecta faltantes y diferencias de monto", () => {
  const ksa = [
    { folio: "1", total: 1000 },
    { folio: "2", total: 2000 },
    { folio: "3", total: 3000 },
  ];
  const previo = [
    { folio: "1", total: 1000 },
    { folio: "2", total: 2500 }, // monto distinto
    { folio: "4", total: 4000 }, // solo en el sistema anterior
  ];
  const r = conciliar(ksa, previo, (x) => x.folio, (x) => x.total);
  assert.equal(r.ok, false);
  assert.deepEqual(r.soloEnKsa, ["3"]);
  assert.deepEqual(r.soloEnPrevio, ["4"]);
  assert.equal(r.montoDistinto.length, 1);
  assert.equal(r.montoDistinto[0].key, "2");
});

test("conciliación: datasets idénticos → ok", () => {
  const a = [{ folio: "1", total: 1000 }];
  const r = conciliar(a, a, (x) => x.folio, (x) => x.total);
  assert.equal(r.ok, true);
});
