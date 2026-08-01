import { test } from "node:test";
import assert from "node:assert/strict";

import { ordenarFEFO } from "../src/wms/fefo.js";
import { arqueoCaja } from "../src/wms/arqueo.js";

test("FEFO: ordena por vencimiento más próximo, sin-vencimiento al final", () => {
  const lotes = [
    { producto: "A", expiry_date: "2026-09-01" },
    { producto: "B", expiry_date: null },
    { producto: "C", expiry_date: "2026-07-01" },
    { producto: "D", expiry_date: "2026-08-01" },
  ];
  const orden = ordenarFEFO(lotes).map((l) => l.producto);
  assert.deepEqual(orden, ["C", "D", "A", "B"]);
});

test("arqueo de caja: cuadra / sobrante / faltante", () => {
  assert.equal(arqueoCaja(100000, 100000).estado, "cuadra");
  assert.equal(arqueoCaja(100000, 105000).estado, "sobrante");
  const falt = arqueoCaja(100000, 97000);
  assert.equal(falt.estado, "faltante");
  assert.equal(falt.diferencia, -3000);
});
