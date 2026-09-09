import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import mongoose from "mongoose";

import { trackingLookupSchema } from "../src/validators/trackingValidators.js";

// Consulta PÚBLICA del seguimiento de un pedido, para el que compró sin cuenta.
//
// Lo que se está protegiendo aquí es que el número de pedido SOLO no alcance. El
// folio son los últimos 6 del ObjectId de Mongo, o sea el contador que sube de a
// uno por documento: los pedidos consecutivos tienen folios consecutivos y se
// enumeran caminando hacia arriba. Detrás de ese número hay qué compró la
// persona, cuándo y por cuánto. Por eso se exige el correo con el que compró, y
// por eso el error tiene que ser EL MISMO cuando el pedido no existe y cuando el
// correo no calza: si se distinguieran, ese endpoint sería una forma gratis de
// averiguar qué números de pedido son válidos.

/* ─────────────────── doble del modelo Order (sin base) ──────────────────────
   Imita lo justo de Mongoose: el encadenado find/sort/limit/lean y —esto es lo
   importante— que los campos con `select: false` NO vengan salvo que se los pida
   a mano con `.select("+campo")`. Justamente ahí estaba el bug que dejaba muerto
   el seguimiento por token, así que el doble tiene que ser fiel en eso o la
   prueba de regresión no probaría nada.                                        */

const CAMPOS_OCULTOS = ["guest_token_hash"];

const consultaFalsa = (docs) => {
  let pedidos = [];
  const q = {
    select: (s) => {
      pedidos = String(s).split(/\s+/).filter(Boolean);
      return q;
    },
    sort: () => q,
    limit: (n) => {
      if (Array.isArray(docs)) docs = docs.slice(0, n);
      return q;
    },
    lean: async () => {
      const proyectar = (d) => {
        if (!d) return d;
        const out = { ...d };
        for (const campo of CAMPOS_OCULTOS) {
          if (!pedidos.includes(`+${campo}`)) delete out[campo];
        }
        return out;
      };
      return Array.isArray(docs) ? docs.map(proyectar) : proyectar(docs);
    },
  };
  return q;
};

const instalarModelo = (pedidos) => {
  mongoose.models.Order = {
    findById: (id) =>
      consultaFalsa(pedidos.find((o) => String(o._id) === String(id)) || null),
    find: (filtro) => {
      const correo = filtro?.["customer.email"];
      const encontrados = pedidos
        .filter((o) => o.customer?.email === correo)
        // el servicio ordena del más nuevo al más viejo; el doble hace lo mismo
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      return consultaFalsa(encontrados);
    },
  };
};

// El servicio se importa DESPUÉS de dejar el modelo instalado; igual lo resuelve
// perezoso en cada llamada, así que reinstalarlo entre pruebas funciona.
instalarModelo([]);
const tracking = await import("../src/services/trackingService.js");

/* ──────────────────────────── pedidos de prueba ──────────────────────────── */

const CORREO = "ana.perez@example.cl";
const OTRO_CORREO = "otra.persona@example.cl";

// Los últimos 6 del id son el folio que se le muestra al cliente.
const ID_ANA = "6aa0ba046b852eec1dccb517"; // folio CCB517
const ID_ANA_VIEJO = "aaaaaaaaaaaaaaaaaaccb517"; // MISMO folio, pedido anterior
const ID_AJENO = "bbbbbbbbbbbbbbbbbbccb517"; // MISMO folio, de otra persona
const ID_SIN_CORREO = "ccccccccccccccccccaa1234"; // folio AA1234, customer.email null

const TOKEN_INVITADO = "1ef3811d4c9b47f2a0d6e5c3b8a71f92";
const HASH_TOKEN = crypto
  .createHash("sha256")
  .update(TOKEN_INVITADO)
  .digest("hex");

const pedidoBase = (extra = {}) => ({
  _id: ID_ANA,
  user_id: null,
  guest_id: "db67a93e-a562-4ad9-a028-377d87678fce",
  guest_token_hash: HASH_TOKEN,
  status: "preparing",
  delivery_method: "delivery",
  created_at: "2026-09-01T12:00:00Z",
  delivered_at: null,
  total: 24990,
  subtotal: 21990,
  shipping_amount: 3000,
  customer: {
    fullName: "Ana Pérez",
    email: CORREO,
    phone: "+56911112222",
    rut: "11.111.111-1",
  },
  shipping: {
    carrier: "cibox_reparto",
    tracking_number: "CBX-000123",
    shipment_status: null,
    estimated_delivery: null,
    address: "Calle Falsa 123",
    reference: "casa azul",
    city: "Machalí",
    region: "O'Higgins",
  },
  status_history: [
    { status: "pending", changed_at: "2026-09-01T12:00:00Z", changed_by: { label: "cliente" } },
    { status: "paid", changed_at: "2026-09-01T12:05:00Z", changed_by: { label: "webpay" } },
    { status: "preparing", changed_at: "2026-09-01T13:00:00Z", changed_by: { label: "Marcela Soto" } },
  ],
  items: [
    { product_id: "p1", name: "Arroz grado 1 kg", quantity: 2, unit_price: 1490, subtotal: 2980 },
    { product_id: "p2", name: "Aceite maravilla 1 L", quantity: 1, unit_price: 2490, subtotal: 2490 },
  ],
  ...extra,
});

const soloAna = () => [pedidoBase()];

/* ═══════════════ lo que importa: sin el correo correcto, nada ══════════════ */

test("con el número de pedido correcto pero OTRO correo no se entrega nada", async () => {
  instalarModelo(soloAna());
  await assert.rejects(
    () => tracking.lookupPublicTracking({ folio: "CCB517", email: OTRO_CORREO }),
    (err) => err.statusCode === 404
  );
});

test("con el número de pedido y SIN correo no se entrega nada", async () => {
  instalarModelo(soloAna());
  for (const email of ["", null, undefined, "   "]) {
    await assert.rejects(
      () => tracking.lookupPublicTracking({ folio: "CCB517", email }),
      (err) => err.statusCode === 404,
      `el correo ${JSON.stringify(email)} no debería autorizar`
    );
  }
});

test("un pedido con el mismo folio pero de otra persona NO se entrega", async () => {
  // El folio no es único: no hay campo, ni índice, ni restricción de unicidad.
  // Que dos pedidos compartan los 6 caracteres no puede abrirle el de nadie.
  instalarModelo([
    pedidoBase(),
    pedidoBase({
      _id: ID_AJENO,
      created_at: "2026-09-05T09:00:00Z", // más nuevo que el de Ana
      customer: { fullName: "Otra Persona", email: OTRO_CORREO, phone: "+56900000000", rut: "22.222.222-2" },
    }),
  ]);

  const suyo = await tracking.lookupPublicTracking({ folio: "CCB517", email: CORREO });
  assert.equal(suyo.orderId, ID_ANA, "a Ana le tiene que salir SU pedido, no el ajeno");
});

test("un pedido guardado sin correo no se entrega ni con el folio en la mano", async () => {
  // customer.email admite null en el esquema (pedidos viejos o creados desde el
  // WMS). Una comparación descuidada contra cadena vacía se los regalaría.
  instalarModelo([
    pedidoBase({ _id: ID_SIN_CORREO, customer: { fullName: "Sin Correo", email: null, phone: null, rut: null } }),
  ]);

  for (const email of ["", "  ", "cualquiera@example.cl"]) {
    await assert.rejects(
      () => tracking.lookupPublicTracking({ folio: "AA1234", email }),
      (err) => err.statusCode === 404
    );
  }
});

test("el error es EXACTAMENTE el mismo si el pedido no existe y si el correo no calza", async () => {
  // Si se distinguieran, cualquiera podría recorrer folios hasta dar con los
  // válidos y de paso confirmar el correo de otra persona, sin ver un pedido.
  instalarModelo(soloAna());

  const noExiste = await tracking
    .lookupPublicTracking({ folio: "ZZZZZZ", email: CORREO })
    .then(() => null, (e) => e);
  const correoMalo = await tracking
    .lookupPublicTracking({ folio: "CCB517", email: OTRO_CORREO })
    .then(() => null, (e) => e);

  assert.ok(noExiste && correoMalo, "los dos casos tienen que fallar");
  assert.equal(noExiste.statusCode, correoMalo.statusCode);
  assert.equal(noExiste.code, correoMalo.code);
  assert.equal(noExiste.message, correoMalo.message);
  assert.doesNotMatch(noExiste.message, /no existe|inexistente/i);
});

/* ═════════════════════ el camino feliz del que sí es dueño ═════════════════ */

test("con folio y correo correctos sí se entrega el seguimiento", async () => {
  instalarModelo(soloAna());
  const data = await tracking.lookupPublicTracking({ folio: "CCB517", email: CORREO });

  assert.equal(data.folio, "CCB517");
  assert.equal(data.orderId, ID_ANA);
  assert.equal(data.status, "preparing");
  assert.equal(data.estado, "Preparando tu pedido");
  assert.equal(data.total, 24990);
  assert.equal(data.created_at, "2026-09-01T12:00:00Z");
  assert.deepEqual(
    data.items.map((i) => `${i.quantity}× ${i.name}`),
    ["2× Arroz grado 1 kg", "1× Aceite maravilla 1 L"]
  );
});

test("el correo no distingue mayúsculas ni espacios de más", async () => {
  // La base ya guarda customer.email en minúscula y sin espacios (el modelo lo
  // declara trim + lowercase), así que basta con normalizar lo que escribe la
  // persona para que calce, incluso en los pedidos históricos.
  instalarModelo(soloAna());
  for (const escrito of [CORREO, `  ${CORREO}  `, CORREO.toUpperCase(), " Ana.Perez@Example.CL "]) {
    const data = await tracking.lookupPublicTracking({ folio: "CCB517", email: escrito });
    assert.equal(data.orderId, ID_ANA, `debería calzar con ${JSON.stringify(escrito)}`);
  }
});

test("el número se acepta como lo escriba la persona: con #, con espacios o el id completo", async () => {
  instalarModelo(soloAna());
  for (const escrito of ["CCB517", "ccb517", "#CCB517", " cc b5 17 ", ID_ANA, ID_ANA.toUpperCase()]) {
    const data = await tracking.lookupPublicTracking({ folio: escrito, email: CORREO });
    assert.equal(data.orderId, ID_ANA, `debería calzar con ${JSON.stringify(escrito)}`);
  }
});

test("si dos pedidos del mismo correo comparten folio, sale el más reciente", async () => {
  instalarModelo([
    pedidoBase({ _id: ID_ANA_VIEJO, created_at: "2026-01-01T10:00:00Z" }),
    pedidoBase(), // 2026-09-01, el más nuevo
  ]);
  const data = await tracking.lookupPublicTracking({ folio: "CCB517", email: CORREO });
  assert.equal(data.orderId, ID_ANA);
});

/* ══════════════════ la respuesta no puede llevar datos de más ══════════════ */

test("el seguimiento público no lleva nombre, teléfono, RUT ni dirección", async () => {
  instalarModelo(soloAna());
  const data = await tracking.lookupPublicTracking({ folio: "CCB517", email: CORREO });
  const plano = JSON.stringify(data);

  for (const dato of ["Ana Pérez", "+56911112222", "11.111.111-1", "Calle Falsa 123", "casa azul", CORREO]) {
    assert.ok(!plano.includes(dato), `la respuesta pública no debería incluir "${dato}"`);
  }
});

test("la línea de tiempo no publica quién de bodega tocó el pedido", async () => {
  // `lineaDeTiempo()` trae un campo `por` con el NOMBRE de la persona que ejecutó
  // cada etapa. Eso es dato del personal, no del pedido, y no tiene por qué
  // llegarle a alguien que solo acertó un folio y un correo.
  instalarModelo(soloAna());
  const data = await tracking.lookupPublicTracking({ folio: "CCB517", email: CORREO });

  assert.ok(data.timeline.length > 0);
  for (const paso of data.timeline) {
    assert.equal(paso.por, undefined, "la vista pública no lleva el campo `por`");
  }
  assert.ok(!JSON.stringify(data.timeline).includes("Marcela Soto"));
  // pero sí lo que el cliente necesita: qué etapa, si ya pasó y cuándo
  const pagado = data.timeline.find((p) => p.estado === "paid");
  assert.equal(pagado.cumplido, true);
  assert.equal(pagado.fecha, "2026-09-01T12:05:00Z");
});

test("los items van con nombre y cantidad, sin precios", async () => {
  instalarModelo(soloAna());
  const data = await tracking.lookupPublicTracking({ folio: "CCB517", email: CORREO });
  for (const item of data.items) {
    assert.deepEqual(Object.keys(item).sort(), ["name", "quantity"]);
  }
});

/* ═════════ regresión: el seguimiento por token de invitado estaba muerto ═══ */

test("el token de invitado autoriza (el hash viene con select:false y hay que pedirlo)", async () => {
  // Bug de origen: la consulta era `Order.findById(id).lean()` sin
  // `.select("+guest_token_hash")`, y como el campo está declarado `select:false`
  // llegaba siempre undefined. Resultado: 403 incluso con el token correcto, o
  // sea que la vía del invitado nunca funcionó. Esta prueba falla si alguien
  // vuelve a sacar el select.
  instalarModelo(soloAna());
  const data = await tracking.getTrackingByToken({
    orderId: ID_ANA,
    token: TOKEN_INVITADO,
    userId: null,
  });
  assert.equal(data.orderId, ID_ANA);
  assert.equal(data.folio, "CCB517");
});

test("un token que no es el del pedido no autoriza", async () => {
  instalarModelo(soloAna());
  await assert.rejects(
    () => tracking.getTrackingByToken({ orderId: ID_ANA, token: "a".repeat(32), userId: null }),
    (err) => err.statusCode === 403
  );
});

test("sin token y sin ser el dueño no se entrega el seguimiento", async () => {
  instalarModelo(soloAna());
  await assert.rejects(
    () => tracking.getTrackingByToken({ orderId: ID_ANA, token: null, userId: "6aa0000000000000000000aa" }),
    (err) => err.statusCode === 403
  );
});

/* ═════════════════════════ el formulario de entrada ════════════════════════ */

test("la consulta pública exige los dos datos, no solo el número", async () => {
  assert.equal(trackingLookupSchema.safeParse({ folio: "CCB517" }).success, false);
  assert.equal(trackingLookupSchema.safeParse({ email: CORREO }).success, false);
  assert.equal(trackingLookupSchema.safeParse({ folio: "CCB517", email: "no-es-un-correo" }).success, false);
  assert.equal(trackingLookupSchema.safeParse({ folio: "CCB517", email: CORREO }).success, true);
});

test("el validador normaliza el correo antes de que llegue al servicio", async () => {
  const r = trackingLookupSchema.parse({ folio: " #CCB517 ", email: "  Ana.Perez@Example.CL " });
  assert.equal(r.email, CORREO);
  assert.equal(r.folio, "#CCB517");
});
