import { test } from "node:test";
import assert from "node:assert/strict";

import { ordenarFEFO } from "../src/wms/fefo.js";

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
