import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import {
  TARIFA_PLANA_CLP,
  ENVIO_GRATIS_DESDE_CLP,
  costoDespacho,
  hayEnvioGratis,
  COMUNAS_CON_REPARTO,
  REGION_REPARTO,
  comunaDeReparto,
  zonaDeDespacho,
  publicDespacho,
} from "../src/config/despacho.js";
import { quoteShippingForOrder } from "../src/services/shippingService.js";
import { createFromCartSchema } from "../src/validators/orderValidators.js";
import { assertPagoConTarjeta } from "../src/services/orderService.js";
import Order from "../src/models/Order.js";

// Cibox pasó a vender SOLO con tarjeta, SOLO con despacho a domicilio y SOLO en
// la zona de Rancagua. Que la pantalla esconda la transferencia o no ofrezca
// otras comunas no basta: una petición hecha a mano tiene que rebotar igual.
// Estas pruebas cubren el servidor, que es donde manda la regla.

const DIRECCION_EN_ZONA = {
  region: REGION_REPARTO,
  city: "Machalí",
  address: "Av. San Juan 123",
};

const CLIENTE = {
  fullName: "Ana Pérez",
  email: "ana@example.cl",
  phone: "+56912345678",
  rut: "11.111.111-1",
};

const pedidoCon = (shipping, items = [{ quantity: 1, weight: { value: 500, unit: "g" } }]) => ({
  items,
  shipping,
});

/* ─────────────────────────── zona de reparto ─────────────────────────────── */

test("las cuatro comunas con reparto son exactamente esas y ninguna más", () => {
  assert.deepEqual(COMUNAS_CON_REPARTO, [
    "Rancagua",
    "Machalí",
    "Graneros",
    "Olivar",
  ]);
});

test("la comuna se reconoce venga como venga escrita", () => {
  // El nombre llega distinto según de dónde salga: selector de la tienda,
  // dirección guardada, panel, API. Si se compara con === se rechazan ventas
  // legítimas de Machalí por una tilde.
  for (const escrita of ["Machalí", "MACHALI", "machali", "  Machalí  ", "MaChAlI"]) {
    assert.equal(comunaDeReparto(escrita), "Machalí", `falló con "${escrita}"`);
  }
});

test("una comuna fuera de zona no se reconoce", () => {
  for (const fuera of ["Providencia", "Santiago", "Viña del Mar", "Rengo", ""]) {
    assert.equal(comunaDeReparto(fuera), null, `"${fuera}" no debería tener reparto`);
  }
});

test("la región se acepta escrita de varias formas, pero otra región no", () => {
  assert.ok(zonaDeDespacho({ region: "Región de O'Higgins", comuna: "Olivar" }).ok);
  assert.ok(zonaDeDespacho({ region: "VI Region", comuna: "Olivar" }).ok);
  // Sin región: las cuatro comunas ya determinan cuál es, así que no se estorba
  // al cliente por un campo que se puede deducir.
  assert.ok(zonaDeDespacho({ comuna: "Graneros" }).ok);

  const cruzada = zonaDeDespacho({ region: "Metropolitana", comuna: "Rancagua" });
  assert.equal(cruzada.ok, false);
  assert.equal(cruzada.campo, "region");
});

test("el error de zona apunta a la comuna, que es el campo que hay que corregir", () => {
  const fuera = zonaDeDespacho({ region: "Metropolitana", comuna: "Providencia" });
  assert.equal(fuera.ok, false);
  assert.equal(fuera.campo, "city");
  // El mensaje nombra las comunas: no deja al cliente adivinando dónde sí llega.
  for (const comuna of COMUNAS_CON_REPARTO) {
    assert.match(fuera.mensaje, new RegExp(comuna));
  }
});

test("la dirección en zona se devuelve con el nombre canónico, para guardarlo limpio", () => {
  const zona = zonaDeDespacho({ region: "ohiggins", comuna: "machali" });
  assert.deepEqual(zona, {
    ok: true,
    comuna: "Machalí",
    region: REGION_REPARTO,
  });
});

/* ─────────────────────────── tarifa plana ────────────────────────────────── */

test("el despacho cuesta lo mismo en las cuatro comunas", () => {
  for (const comuna of COMUNAS_CON_REPARTO) {
    const quote = quoteShippingForOrder(
      pedidoCon({ ...DIRECCION_EN_ZONA, city: comuna }),
    );
    assert.equal(quote.selected.amount, TARIFA_PLANA_CLP, `${comuna} cobró distinto`);
  }
});

test("el peso ya no cambia el precio del despacho", () => {
  // Antes se cobraba por tramo de peso (4.000 a 11.300 en la Región de
  // O'Higgins): un pedido pesado salía al triple. Ahora es tarifa plana.
  const liviano = quoteShippingForOrder(
    pedidoCon(DIRECCION_EN_ZONA, [{ quantity: 1, weight: { value: 100, unit: "g" } }]),
  );
  const pesado = quoteShippingForOrder(
    pedidoCon(DIRECCION_EN_ZONA, [{ quantity: 40, weight: { value: 1, unit: "kg" } }]),
  );

  assert.equal(liviano.selected.amount, TARIFA_PLANA_CLP);
  assert.equal(pesado.selected.amount, TARIFA_PLANA_CLP);
  // 40 kg superaban el tramo máximo de la tabla vieja y la cotización reventaba.
  assert.equal(pesado.meta.weight_grams, 40000);
});

test("la tarifa vive en un solo sitio y sale también por la API pública", () => {
  const publico = publicDespacho();
  assert.equal(publico.tarifa_plana_clp, TARIFA_PLANA_CLP);
  // La tienda no puede hardcodear el mínimo de envío gratis: lo lee de acá.
  // Si este campo desaparece, la tienda se queda con su respaldo y termina
  // prometiendo un mínimo distinto del que cobra el servidor.
  assert.equal(publico.envio_gratis_desde_clp, ENVIO_GRATIS_DESDE_CLP);
  assert.deepEqual(publico.comunas, COMUNAS_CON_REPARTO);
  assert.equal(publico.region, REGION_REPARTO);
  // La tienda lee esto para saber que no debe ofrecer retiro.
  assert.equal(publico.retiro_en_tienda, false);
});

test("mientras el dueño no fije el monto, la tarifa provisoria es 3990", () => {
  // Se cambia en src/config/despacho.js o con la variable DESPACHO_TARIFA_CLP.
  // Si alguien cambia el valor, esta prueba avisa que hay que actualizarla.
  assert.equal(TARIFA_PLANA_CLP, 3990);
});

test("cotizar hacia una comuna fuera de zona falla con 400 y explica por qué", () => {
  assert.throws(
    () => quoteShippingForOrder(pedidoCon({ ...DIRECCION_EN_ZONA, city: "Providencia" })),
    (err) => {
      assert.equal(err.statusCode, 400);
      // El detalle va en "city" para que el checkout lo pinte junto al selector
      // de comuna, antes de que la persona llene el resto del formulario.
      assert.ok(err.details?.city, "el error debería apuntar al campo city");
      return true;
    },
  );
});

test("sin comuna no se cotiza nada", () => {
  assert.throws(
    () => quoteShippingForOrder(pedidoCon({ region: REGION_REPARTO, address: "Calle 1" })),
    (err) => err.statusCode === 400,
  );
});

/* ─────────────────────── solo se paga con tarjeta ────────────────────────── */

const pedidoValido = (extra = {}) => ({
  customer: CLIENTE,
  shipping: DIRECCION_EN_ZONA,
  ...extra,
});

test("un pedido por transferencia se rechaza en la puerta de la API", () => {
  const r = createFromCartSchema.body.safeParse(
    pedidoValido({ payment: { method: "transfer" } }),
  );
  assert.equal(r.success, false);
  assert.match(r.error.issues[0].message, /tarjeta/i);
});

test("un pedido para pagar en efectivo al retirar también se rechaza", () => {
  const r = createFromCartSchema.body.safeParse(
    pedidoValido({ payment: { method: "cash_on_pickup" } }),
  );
  assert.equal(r.success, false);
});

test("un pedido con tarjeta pasa, y sin bloque de pago también (el default es tarjeta)", () => {
  assert.ok(createFromCartSchema.body.safeParse(pedidoValido({ payment: { method: "webpay" } })).success);
  assert.ok(createFromCartSchema.body.safeParse(pedidoValido()).success);
});

test("el servicio rechaza el medio de pago aunque el validador se afloje", () => {
  // Segunda barrera: si mañana alguien relaja el esquema Zod o llama al
  // servicio desde un script, el pedido sigue sin poder nacer con transferencia.
  for (const method of ["transfer", "cash_on_pickup", "card", "credito"]) {
    assert.throws(
      () => assertPagoConTarjeta({ method }),
      (err) => err.statusCode === 400,
      `${method} debería rechazarse`,
    );
  }
  assert.doesNotThrow(() => assertPagoConTarjeta({ method: "webpay" }));
  assert.doesNotThrow(() => assertPagoConTarjeta(undefined));
});

/* ────────────────────── ya no hay retiro en tienda ───────────────────────── */

test("un pedido para retirar en tienda se rechaza y se explica el cambio", () => {
  const r = createFromCartSchema.body.safeParse(
    pedidoValido({ delivery: { method: "pickup", committed_date: "2030-01-01" } }),
  );
  assert.equal(r.success, false);
  assert.match(r.error.issues[0].message, /retiro en tienda/i);
});

test("no se puede crear un pedido sin dirección de despacho", () => {
  // Antes la dirección era opcional porque en retiro no había a dónde llevarlo.
  const r = createFromCartSchema.body.safeParse({ customer: CLIENTE });
  assert.equal(r.success, false);
  assert.equal(r.error.issues[0].path[0], "shipping");
});

/* ─────────────── el historial se sigue pudiendo leer y cerrar ────────────── */

test("los pedidos viejos por transferencia y de retiro siguen siendo válidos para el modelo", () => {
  // El enum del modelo NO se recortó a propósito: mongoose valida el documento
  // COMPLETO en cada save(). Si se sacaran estos valores, marcar entregado un
  // pedido antiguo de retiro, adjuntarle un comprobante o reembolsarlo
  // reventaría con ValidationError. Lo que se cerró es la entrada de pedidos
  // nuevos, no la lectura de lo ya guardado.
  const metodosDePago = Order.schema.path("payment.method").enumValues;
  for (const historico of ["transfer", "cash_on_pickup", "card", "credito"]) {
    assert.ok(
      metodosDePago.includes(historico),
      `payment.method perdió "${historico}": se rompe el historial`,
    );
  }
  assert.ok(Order.schema.path("delivery_method").enumValues.includes("pickup"));
});

/* ─────────────────────────── envío gratis ────────────────────────────────── */

// El mínimo se mide sobre la MERCADERÍA, antes de cupones, y con >=. Las dos
// decisiones están explicadas en src/config/despacho.js; acá se fijan para que
// no se muevan sin que nadie se entere.

const pedidoDe = (subtotal, extra = {}) => ({
  shipping: DIRECCION_EN_ZONA,
  items: [{ quantity: 1, weight: { value: 500, unit: "g" } }],
  subtotal,
  ...extra,
});

test("el mínimo de envío gratis es 60.000", () => {
  // Se cambia en src/config/despacho.js o con DESPACHO_ENVIO_GRATIS_CLP.
  // Si alguien mueve el monto, esta prueba avisa que hay textos que actualizar.
  assert.equal(ENVIO_GRATIS_DESDE_CLP, 60000);
});

test("justo en el mínimo el despacho ya es gratis, un peso menos no", () => {
  assert.equal(
    quoteShippingForOrder(pedidoDe(ENVIO_GRATIS_DESDE_CLP)).selected.amount,
    0,
    "quien llega justo al mínimo tiene que llevarse el despacho",
  );
  assert.equal(
    quoteShippingForOrder(pedidoDe(ENVIO_GRATIS_DESDE_CLP - 1)).selected.amount,
    TARIFA_PLANA_CLP,
  );
});

test("el envío gratis vale en las cuatro comunas por igual", () => {
  for (const comuna of COMUNAS_CON_REPARTO) {
    const quote = quoteShippingForOrder(
      pedidoDe(ENVIO_GRATIS_DESDE_CLP, {
        shipping: { ...DIRECCION_EN_ZONA, city: comuna },
      }),
    );
    assert.equal(quote.selected.amount, 0, `${comuna} cobró despacho de más`);
  }
});

test("sin subtotal propio, el monto se suma de las líneas del pedido", () => {
  // Es el caso de la creación del pedido desde el carrito: los ítems traen su
  // subtotal calculado por el servidor.
  const gratis = quoteShippingForOrder({
    shipping: DIRECCION_EN_ZONA,
    items: [{ quantity: 2, subtotal: 30000 }, { quantity: 1, subtotal: 30000 }],
  });
  assert.equal(gratis.selected.amount, 0);
  assert.equal(gratis.meta.subtotal_considerado, 60000);

  const cobra = quoteShippingForOrder({
    shipping: DIRECCION_EN_ZONA,
    items: [{ quantity: 2, subtotal: 30000 }, { quantity: 1, subtotal: 29999 }],
  });
  assert.equal(cobra.selected.amount, TARIFA_PLANA_CLP);
});

test("un pedido del que no se sabe el monto PAGA el despacho", () => {
  // La dirección segura del error. Un preview que no logró valorizar el
  // carrito tiene que cobrar, nunca regalar: cobrar de más se reclama y se
  // corrige, regalar de más no se recupera.
  const sinPlata = quoteShippingForOrder({
    shipping: DIRECCION_EN_ZONA,
    items: [{ product_id: "x", quantity: 3, weight: { value: 1, unit: "kg" } }],
  });
  assert.equal(sinPlata.selected.amount, TARIFA_PLANA_CLP);
  assert.equal(sinPlata.meta.subtotal_considerado, 0);

  assert.equal(
    quoteShippingForOrder({ shipping: DIRECCION_EN_ZONA }).selected.amount,
    TARIFA_PLANA_CLP,
  );
});

test("la cotización deja dicho por qué salió gratis", () => {
  // Un despacho en 0 sin rastro de la razón es imposible de auditar después.
  const quote = quoteShippingForOrder(pedidoDe(75000));
  assert.equal(quote.meta.envio_gratis, true);
  assert.equal(quote.meta.source, "envio_gratis");
  assert.equal(quote.meta.subtotal_considerado, 75000);
  assert.equal(quote.meta.envio_gratis_desde, ENVIO_GRATIS_DESDE_CLP);
  assert.equal(quote.selected.envio_gratis, true);

  const cobrado = quoteShippingForOrder(pedidoDe(1000));
  assert.equal(cobrado.meta.envio_gratis, false);
  assert.equal(cobrado.meta.source, "tarifa_plana");
});

test("fuera de zona no hay envío gratis que valga: sigue rebotando", () => {
  // El monto no puede comprar cobertura. Un pedido de 200.000 a Santiago tiene
  // que fallar igual que uno de 1.000.
  assert.throws(
    () =>
      quoteShippingForOrder({
        shipping: { region: "Región Metropolitana", city: "Ñuñoa" },
        subtotal: 200000,
        items: [],
      }),
    /solo despachamos/i,
  );
});

test("los ayudantes de config deciden lo mismo que la cotización", () => {
  assert.equal(hayEnvioGratis(ENVIO_GRATIS_DESDE_CLP), true);
  assert.equal(hayEnvioGratis(ENVIO_GRATIS_DESDE_CLP - 1), false);
  assert.equal(costoDespacho(ENVIO_GRATIS_DESDE_CLP), 0);
  assert.equal(costoDespacho(ENVIO_GRATIS_DESDE_CLP - 1), TARIFA_PLANA_CLP);
  assert.equal(costoDespacho(0), TARIFA_PLANA_CLP);
});

test("con el mínimo en 0 la promoción queda apagada, no regalada", () => {
  // config/despacho.js promete que poner 0 apaga el envío gratis. La lectura
  // ingenua de "subtotal >= mínimo" haría exactamente lo contrario —todo
  // gratis, para siempre— y nadie se enteraría hasta ver la primera boleta.
  //
  // El mínimo se lee del entorno al importar el módulo, así que la única forma
  // honesta de probarlo es en otro proceso, con la variable puesta.
  // Una sola línea, sin saltos que escapar: el hijo importa el módulo con la
  // variable puesta y devuelve lo que decidió.
  const guion =
    'const c = await import("./src/config/despacho.js");' +
    "console.log(JSON.stringify({" +
    "umbral: c.ENVIO_GRATIS_DESDE_CLP," +
    "gratisConMucho: c.hayEnvioGratis(9999999)," +
    "costoConMucho: c.costoDespacho(9999999)," +
    "publico: c.publicDespacho().envio_gratis_desde_clp" +
    "}));";

  const salida = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", guion],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DESPACHO_ENVIO_GRATIS_CLP: "0" },
    },
  );

  // dotenvx escribe su propia línea antes de la nuestra: nos quedamos con la
  // última, que es el JSON.
  const r = JSON.parse(salida.trim().split("\n").pop());
  assert.equal(r.umbral, 0);
  assert.equal(r.gratisConMucho, false, "con el mínimo en 0 nada es gratis");
  assert.equal(r.costoConMucho, TARIFA_PLANA_CLP);
  assert.equal(r.publico, 0, "la tienda tiene que poder leer el apagado");
});
