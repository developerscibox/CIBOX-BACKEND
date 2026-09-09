import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TARIFA_PLANA_CLP,
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
