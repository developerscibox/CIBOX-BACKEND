import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { markEmittedSchema } from "../src/validators/taxDocumentValidators.js";

/**
 * QUÉ CUIDA ESTA PRUEBA
 *
 * La emisión automática al SII está apagada (SII_ENABLED=false). Igual queda
 * registrado un documento tributario por cada venta pagada, pero con
 * `folio: null` y `status: "pending"`. Ya pasó con una venta real de $108.985:
 * la boleta la emite una persona en el portal del SII y después anota el folio
 * en el panel, con POST /api/tax-documents/admin/:id/emitida.
 *
 * Ese folio es el número del documento real ante el SII. Si entrara vacío,
 * recortado a medias, con un tipo que no es texto, o con una fecha de emisión
 * que no existe, el registro contable quedaría apuntando a una boleta que no
 * se puede encontrar. Todo lo que sigue prueba el validador del body, que es
 * la única barrera antes de que eso se guarde.
 *
 * Nada de acá toca Mongo: se prueba el esquema puro.
 */

const parsear = (body) => markEmittedSchema.parse(body);
const falla = (body) => markEmittedSchema.safeParse(body).success === false;

test("el folio es obligatorio: sin folio no se marca nada como emitido", () => {
  assert.ok(falla({}));
  assert.ok(falla({ emitted_at: "2026-09-29T14:30:00.000Z" }));
  assert.ok(falla({ folio: null }));
  assert.ok(falla({ folio: undefined }));
});

test("un folio en blanco no cuenta como folio", () => {
  // Es el caso del dedo resbalado: se aprieta guardar con el campo vacío o con
  // solo espacios. Si pasara, el documento quedaría marcado como emitido sin
  // número, que es peor que dejarlo pendiente.
  assert.ok(falla({ folio: "" }));
  assert.ok(falla({ folio: "   " }));
  assert.ok(falla({ folio: "\t\n" }));
});

test("el folio se guarda tal cual lo escribió la persona, solo recortado", () => {
  // No se normaliza: ni mayúsculas, ni ceros de relleno, ni guiones. Lo que
  // quedó impreso en la boleta del SII es lo que tiene que quedar acá.
  assert.equal(parsear({ folio: "  0000123-a  " }).folio, "0000123-a");
  assert.equal(parsear({ folio: "108985" }).folio, "108985");
  assert.equal(parsear({ folio: "B-00042" }).folio, "B-00042");
});

test("el folio tope 40 caracteres: 40 entra, 41 no", () => {
  assert.equal(parsear({ folio: "9".repeat(40) }).folio, "9".repeat(40));
  assert.ok(falla({ folio: "9".repeat(41) }));
  // El recorte va antes del largo: 40 caracteres entre espacios siguen siendo 40.
  assert.equal(parsear({ folio: "  " + "7".repeat(40) + "  " }).folio, "7".repeat(40));
});

test("el folio tiene que ser texto, no un número ni un objeto", () => {
  // Que llegue un objeto es el patrón de inyección que ya cuida seguridad.test.js
  // en el login; acá además un folio numérico se guardaría distinto de como se ve.
  assert.ok(falla({ folio: 108985 }));
  assert.ok(falla({ folio: { $ne: null } }));
  assert.ok(falla({ folio: ["123"] }));
  assert.ok(falla({ folio: true }));
});

test("emitted_at es opcional: sin fecha, la decide el servidor", () => {
  // Cuando no viene, el controlador pone la fecha y hora del momento. Lo que
  // importa acá es que el validador no la exija ni la invente.
  const r = parsear({ folio: "123" });
  assert.equal(r.emitted_at, undefined);
  assert.ok(!("emitted_at" in r) || r.emitted_at === undefined);
});

test("emitted_at acepta las tres formas ISO que manda de verdad una pantalla", () => {
  // datetime-local (sin zona ni segundos), toISOString() y con desfase horario.
  assert.equal(
    parsear({ folio: "1", emitted_at: "2026-09-29T14:30" }).emitted_at,
    "2026-09-29T14:30",
  );
  assert.equal(
    parsear({ folio: "1", emitted_at: "2026-09-29T14:30:00.000Z" }).emitted_at,
    "2026-09-29T14:30:00.000Z",
  );
  assert.equal(
    parsear({ folio: "1", emitted_at: "2026-09-29T14:30:00-03:00" }).emitted_at,
    "2026-09-29T14:30:00-03:00",
  );
  // Y lo que pase el validador tiene que ser una fecha que el controlador pueda
  // convertir sin quedarse con un Invalid Date.
  for (const v of ["2026-09-29T14:30", "2026-09-29T14:30:00.000Z", "2026-09-29T14:30:00-03:00"]) {
    assert.ok(!Number.isNaN(new Date(parsear({ folio: "1", emitted_at: v }).emitted_at).getTime()));
  }
});

test("emitted_at rechaza lo que no es una fecha ISO", () => {
  for (const v of [
    "ayer",
    "29-09-2026",
    "29/09/2026 14:30",
    "2026-09-29",          // solo el día, sin hora
    "2026-09-29 14:30",    // espacio en vez de T
    "",
    "2026-09-29T14:30:00.000Zextra",
  ]) {
    assert.ok(falla({ folio: "1", emitted_at: v }), `debía rechazar: ${v}`);
  }
});

test("emitted_at rechaza fechas que no existen en el calendario", () => {
  // Date.parse NO avisa de esto: "2026-02-31T10:00:00Z" lo corre solo al 3 de
  // marzo. Si se colara, la boleta quedaría fechada un día distinto del que
  // dice el documento del SII, y eso es lo que se revisa en una fiscalización.
  assert.ok(falla({ folio: "1", emitted_at: "2026-02-31T10:00:00Z" }));
  assert.ok(falla({ folio: "1", emitted_at: "2026-04-31T10:00:00Z" }));
  assert.ok(falla({ folio: "1", emitted_at: "2026-13-01T10:00:00Z" }));
  assert.ok(falla({ folio: "1", emitted_at: "2026-09-29T25:00:00Z" }));
  // 2028 sí es bisiesto, 2026 no.
  assert.ok(falla({ folio: "1", emitted_at: "2026-02-29T10:00:00Z" }));
  assert.equal(
    parsear({ folio: "1", emitted_at: "2028-02-29T10:00:00Z" }).emitted_at,
    "2028-02-29T10:00:00Z",
  );
});

test("emitted_at tampoco puede ser un número ni un objeto", () => {
  assert.ok(falla({ folio: "1", emitted_at: Date.now() }));
  assert.ok(falla({ folio: "1", emitted_at: new Date() }));
  assert.ok(falla({ folio: "1", emitted_at: { $gt: 0 } }));
});

test("el body no deja tocar nada más del documento", () => {
  // El estado, el total y el stub los pone el controlador. Si el esquema dejara
  // pasar estos campos, desde la pantalla se podría cambiar el monto de una
  // boleta o marcarla anulada, que es justo lo que no puede pasar.
  const r = parsear({
    folio: "123",
    status: "voided",
    total: 1,
    neto: 1,
    iva: 0,
    stub: true,
    order_id: "aaaaaaaaaaaaaaaaaaaaaaaa",
    type: "factura",
  });
  assert.deepEqual(Object.keys(r).sort(), ["folio"]);
});

/**
 * La ruta tiene que quedar protegida. Se lee el archivo como texto —igual que
 * limitadores.test.js— porque montar el router pediría base de datos, y lo que
 * se quiere cuidar es que nadie borre un middleware al editar: sin requireAdmin
 * cualquier cliente registrado podría marcar boletas como emitidas.
 */
test("POST /admin/:id/emitida va con protect, requireAdmin y el validador", () => {
  const rutas = readFileSync(new URL("../src/routes/taxDocumentRoutes.js", import.meta.url), "utf8");
  const i = rutas.indexOf('"/admin/:id/emitida"');
  assert.ok(i > 0, "la ruta /admin/:id/emitida tiene que existir");
  const bloque = rutas.slice(i, rutas.indexOf(");", i));
  assert.match(bloque, /\bprotect\b/);
  assert.match(bloque, /\brequireAdmin\b/);
  assert.match(bloque, /markEmittedSchema/);
  assert.match(bloque, /taxDocumentIdParamsSchema/);
  assert.match(bloque, /markDocumentEmitted/);
});

test('el estado de "emitido" es el que acepta el modelo, no uno inventado', () => {
  // El controlador escribe status = "accepted". Si alguien renombrara el enum
  // del modelo, el save fallaría en producción con un error de validación de
  // Mongoose y la boleta nunca quedaría marcada.
  const modelo = readFileSync(new URL("../src/models/TaxDocument.js", import.meta.url), "utf8");
  const enumLinea = /TAX_DOC_STATUSES = \[([^\]]+)\]/.exec(modelo);
  assert.ok(enumLinea, "no se encontró el enum de estados en el modelo");
  const estados = enumLinea[1].split(",").map((s) => s.trim().replace(/"/g, ""));
  assert.ok(estados.includes("accepted"), "el estado de emitido cambió de nombre");
  assert.ok(estados.includes("pending"));
  assert.ok(estados.includes("voided"));

  const controlador = readFileSync(
    new URL("../src/controllers/taxDocumentController.js", import.meta.url),
    "utf8",
  );
  const i = controlador.indexOf("markDocumentEmitted");
  assert.ok(i > 0);
  const bloque = controlador.slice(i, controlador.indexOf("export const voidDocument", i));
  assert.match(bloque, /doc\.status = "accepted"/);
  assert.match(bloque, /doc\.stub = false/);
});
