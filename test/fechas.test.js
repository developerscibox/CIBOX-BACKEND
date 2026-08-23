import { test } from "node:test";
import assert from "node:assert/strict";

import { ymdChile, inicioDiaChile, finDiaChile } from "../src/utils/fechas.js";

// El servidor corre en UTC y el negocio en Chile (UTC-4 en invierno, UTC-3 en
// verano). Toda la aritmética de fechas de los reportes depende de que esto sea
// exacto: cuando no lo era, el tablero mostraba "Ventas del día: $0" desde las
// 20:00 y los reportes perdían la tarde del último día.

test("las 22:00 de Chile siguen siendo el mismo día, aunque en UTC ya sea el siguiente", () => {
  // 2026-08-14T02:00Z = 13 de agosto, 22:00 en Chile
  assert.equal(ymdChile(new Date("2026-08-14T02:00:00.000Z")), "2026-08-13");
});

test("el día chileno empieza y termina en el instante UTC correcto (invierno, UTC-4)", () => {
  assert.equal(inicioDiaChile("2026-08-13").toISOString(), "2026-08-13T04:00:00.000Z");
  assert.equal(finDiaChile("2026-08-13").toISOString(), "2026-08-14T03:59:59.999Z");
});

test("respeta el horario de verano austral (enero, UTC-3)", () => {
  assert.equal(inicioDiaChile("2026-01-15").toISOString(), "2026-01-15T03:00:00.000Z");
  assert.equal(finDiaChile("2026-01-15").toISOString(), "2026-01-16T02:59:59.999Z");
});

test("un día dura exactamente 24 horas", () => {
  for (const dia of ["2026-08-13", "2026-01-15", "2026-03-10", "2026-12-31"]) {
    const ms = finDiaChile(dia) - inicioDiaChile(dia) + 1;
    assert.equal(ms / 3600000, 24, `el día ${dia} no dura 24 h`);
  }
});

test("una venta de las 21:00 en Chile cae dentro de su propio día", () => {
  // Este es el caso que rompía los reportes: en UTC ya es el día siguiente.
  const venta = new Date("2026-08-14T01:00:00.000Z"); // 21:00 del 13 en Chile
  assert.ok(venta >= inicioDiaChile("2026-08-13"));
  assert.ok(venta <= finDiaChile("2026-08-13"));
});

test("los bordes del día no se solapan ni dejan huecos", () => {
  const finDe13 = finDiaChile("2026-08-13");
  const inicioDe14 = inicioDiaChile("2026-08-14");
  assert.equal(inicioDe14 - finDe13, 1, "entre el fin de un día y el inicio del siguiente debe haber 1 ms");
});
