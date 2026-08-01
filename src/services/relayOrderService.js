import mongoose from "mongoose";

import Order from "../models/Order.js";
import Product from "../models/Product.js";
import Turno from "../models/Turno.js";
import Cliente from "../models/Cliente.js";
import Deuda from "../models/Deuda.js";

import User from "../models/User.js";
import { ORDER_STATUS, PAYMENT_STATUS, ROLES } from "../utils/constants.js";
import { withTransaction } from "../utils/transactions.js";
import { logger } from "../utils/logger.js";
import { logAudit } from "../utils/audit.js";
import { BadRequestError, ConflictError, NotFoundError } from "../utils/errors.js";
import { formatRut, isValidRut } from "../utils/rut.js";

import { calculateItemPricing, getBoxQty } from "./pricingService.js";
import { allocateStockAtomic } from "./stockService.js";
import { markAsPaid, transitionOrderStatus } from "./orderService.js";
import { adjustStock } from "./inventoryService.js";
import { estadoCredito, normalizeRut } from "./clienteService.js";
import { emitDocumentForOrder } from "./siiService.js";
import { emitRelayChange } from "../utils/relayBus.js";
import { calcularPuntos } from "../incentivos/piloto.js";

// Meta de venta MENSUAL del vendedor de sala (referencial, configurable a futuro).
const META_VENDEDOR_MENSUAL = 3_000_000;

/**
 * RELAY DE SALA — toma de pedido por el VENDEDOR (etapa 1).
 *
 * Crea la Order en estado POR_PAGAR (pending): el vendedor NO cobra. A diferencia
 * de la venta manual (que decrementa el físico y entrega de una), aquí se ASIGNA
 * stock (allocateStockAtomic: allocated++, el físico sigue en bodega hasta el pick)
 * — respeta el inventario de 3 estados y el fix de timing. Snapshotea el sector de
 * cada ítem para agrupar boleta/ticket. Genera codigo_escaneo (lo escanea la cajera)
 * y, si viene de un turno, lo enlaza y cierra. Todo en una transacción.
 */

const PICKUP_LOCATION =
  "Av. Lo Espejo 01565, Bodega 826, Centro Logístico Mersan, Lo Espejo";

const buildCustomer = (raw = {}) => ({
  fullName: String(raw.fullName || raw.name || "").trim() || "Cliente mostrador",
  email: raw.email ? String(raw.email).trim().toLowerCase() : null,
  phone: raw.phone ? String(raw.phone).trim() : null,
  rut: raw.rut ? formatRut(raw.rut) : null,
});

// Reconstruye ítems (cajas→unidades) ASIGNANDO stock (no decrementa) + snapshot de sector.
const buildRelayItems = async ({ rawItems, session }) => {
  if (!Array.isArray(rawItems) || rawItems.length === 0)
    throw new BadRequestError("El pedido no tiene productos");

  const ids = [...new Set(rawItems.map((i) => String(i.product_id)))];
  const products = await Product.find({ _id: mongoose.trusted({ $in: ids }) })
    .session(session || null)
    .lean();
  const map = new Map(products.map((p) => [String(p._id), p]));

  const items = [];
  let subtotal = 0;
  for (const raw of rawItems) {
    const product = map.get(String(raw.product_id));
    if (!product) throw new ConflictError("Producto no encontrado");
    if (!product.is_active) throw new ConflictError(`Producto inactivo: ${product.name}`);

    const cajas = Number(raw.cajas || 0);
    if (!Number.isInteger(cajas) || cajas < 1)
      throw new BadRequestError(`Cantidad de cajas inválida para ${product.name}`);

    const tiers = product?.pricing?.tiers || [];
    const boxQty = getBoxQty(tiers);
    const quantity = cajas * boxQty;
    const pricing = calculateItemPricing({ tiers, quantity, product, user: null });

    await allocateStockAtomic({ productId: product._id, quantity: pricing.quantity }, session);

    items.push({
      product_id: product._id,
      name: product.name,
      quantity: pricing.quantity,
      cajas,
      box_qty: boxQty,
      price: pricing.unit_price,
      original_price: pricing.original_unit_price,
      tier_label: pricing.tier_label,
      discount_applied: pricing.discount_applied,
      discount_percent: pricing.discount_percent,
      discount_amount_per_unit: pricing.discount_amount_per_unit,
      discount_source: pricing.discount_source,
      subtotal: pricing.subtotal,
      original_subtotal: pricing.original_subtotal,
      sector: product.location?.sector || "",
      product_type: product.product_type === "box" ? "box" : "simple",
      weight: product.weight || { value: 0, unit: "g" },
      dimensions: product.dimensions || { length: 0, width: 0, height: 0, unit: "cm" },
    });
    subtotal += pricing.subtotal;
  }
  return { items, subtotal };
};

export const createTakeOrder = async ({
  items: rawItems,
  customer: rawCustomer,
  turno_id = null,
  notes,
  by = null,
}) => {
  const customer = buildCustomer(rawCustomer);
  const actor = by || { label: "vendedor" };

  return withTransaction(async (session) => {
    const { items, subtotal } = await buildRelayItems({ rawItems, session });
    const sub = Math.max(0, Math.round(subtotal));
    const now = new Date();
    const oid = new mongoose.Types.ObjectId();

    let turnoNumero = null;
    if (turno_id) {
      const turno = await Turno.findById(turno_id).session(session);
      if (turno) {
        turnoNumero = turno.code || String(turno.number || "");
        turno.order_id = oid;
        turno.status = "done";
        turno.done_at = now;
        await turno.save({ session });
      }
    }

    const payload = {
      _id: oid,
      user_id: null,
      guest_id: null,
      items,
      customer,
      seller: { id: actor.user_id || null, nombre: actor.label || null },
      source: "manual",
      delivery_method: "pickup",
      pickup: { committed_date: now, location: PICKUP_LOCATION, picked_up_at: null },
      payment: {
        method: "cash_on_pickup",
        platform: "web",
        status: PAYMENT_STATUS.PENDING,
        amount: sub,
      },
      coupon: { code: null, coupon_id: null, discount_amount: 0 },
      subtotal: sub,
      shipping_amount: 0,
      discount_amount: 0,
      total: sub,
      status: ORDER_STATUS.PENDING,
      stock_committed: false, // el físico sale recién al pick (commitOrderPick)
      codigo_escaneo: String(oid),
      turno_numero: turnoNumero,
      notes: String(notes || "").trim() || null,
      status_history: [
        {
          status: ORDER_STATUS.PENDING,
          changed_at: now,
          note: "Pedido tomado en sala (vendedor)",
          changed_by: {
            user_id: actor.user_id || null,
            role: actor.role || null,
            label: actor.label || "vendedor",
          },
        },
      ],
    };

    const [order] = await Order.create([payload], { session });
    logger.info(
      { orderId: String(order._id), total: order.total, items: order.items.length, by: actor.label },
      "pedido tomado en sala (POR_PAGAR)",
    );
    emitRelayChange({ type: "take", id: String(order._id) });
    return order;
  });
};

/**
 * RELAY DE SALA — cobro por la CAJERA (etapa 2). Fija el método y la cajera que
 * cobró, y marca PAGADO (reusa markAsPaid: valida transición, vuelto en efectivo,
 * historial con actor). Tras esto el pedido entra a la cola de picking.
 */
const METODO_MAP = { efectivo: "cash_on_pickup", tarjeta: "card", transferencia: "transfer", credito: "credito" };

const ymd = (d) => d.toISOString().slice(0, 10);

/**
 * Venta a CRÉDITO — validación previa. Se ejecuta ANTES del claim atómico
 * (decisión: si el crédito se rechaza la orden queda intacta; el claim solo
 * ocurre con crédito ya aprobado, así nunca hay pedido a medio cobrar).
 * Lanza 409 con motivo + números; override solo lo honra admin/manager.
 */
const validarVentaCredito = async ({ clienteRut, total, override, by }) => {
  if (!clienteRut || !isValidRut(clienteRut))
    throw new BadRequestError("Venta a crédito requiere un RUT de cliente válido");
  // OJO: la ficha guarda el rut NORMALIZADO sin puntos ("12345678-5");
  // formatRut agrega puntos y nunca matchearía.
  const cliente = await Cliente.findOne({ rut: normalizeRut(clienteRut) }).lean();
  if (!cliente || cliente.activo === false)
    throw new NotFoundError("Cliente no encontrado: crea la ficha antes de vender a crédito");

  const deudas = await Deuda.find({ cliente_id: cliente._id, estado: "pendiente" }).lean();
  const estado = estadoCredito(cliente, deudas);

  // Rechazo por estado (deshabilitado/bloqueado/mora) o porque saldo+venta excede la línea.
  let motivo = null;
  if (!estado.puede_comprar) motivo = estado.motivo_rechazo || "bloqueado";
  else if (estado.saldo + total > Number(cliente.credito?.linea || 0)) motivo = "limite";

  const overrideAutorizado = override === true && ["admin", "manager"].includes(by?.role);
  if (motivo && !overrideAutorizado) {
    const msgs = {
      deshabilitado: "Cliente sin crédito habilitado: venta solo al contado",
      bloqueado: `Cliente bloqueado: ${cliente.credito?.bloqueo_motivo || "bloqueo manual"}`,
      mora: `Facturas vencidas hace ${estado.max_mora_dias} días: regularizar antes de vender a crédito`,
      limite: `Crédito insuficiente: disponible $${estado.disponible}, requiere $${total}`,
    };
    throw new ConflictError(msgs[motivo] || "Venta a crédito rechazada");
  }
  return { cliente, estado, motivo, overrideUsado: Boolean(motivo && overrideAutorizado) };
};

/**
 * Venta a CRÉDITO — cobro (post-claim). En UNA transacción: marca la orden
 * PAGADA (payment.status=approved → el guard ready→delivered no la frena; el
 * relay sigue idéntico) y crea la Deuda del cliente. La fecha de vencimiento
 * se fija AL EMITIR (hoy + condicion_dias) y no cambia con abonos. No pasa por
 * markAsPaid: la venta a crédito no mueve efectivo ni emite boleta (va con factura).
 */
const cobrarACredito = async ({ orderId, credito, by }) => {
  const { cliente } = credito;
  const actor = { user_id: by?.user_id || null, role: by?.role || null, label: by?.label || "caja" };
  const now = new Date();

  const { paid, deuda } = await withTransaction(async (session) => {
    const order = await Order.findById(orderId).session(session);
    if (!order) throw new NotFoundError("Pedido no encontrado");
    if (order.status !== ORDER_STATUS.PENDING)
      throw new ConflictError("El pedido ya fue cobrado o no está por pagar");

    // Snapshot del cliente en la orden (solo si venía vacío/placeholder de mostrador).
    if (!order.customer) order.customer = {};
    if (!order.customer.fullName || order.customer.fullName === "Cliente mostrador")
      order.customer.fullName = cliente.razon_social;
    if (!order.customer.rut) order.customer.rut = cliente.rut;

    order.status = ORDER_STATUS.PAID;
    order.payment.status = PAYMENT_STATUS.APPROVED;
    order.paid_at = now;
    order.status_history.push({
      status: ORDER_STATUS.PAID,
      changed_at: now,
      note: `Cobrado (crédito) por ${actor.label} — cliente ${cliente.razon_social}`,
      changed_by: actor,
    });
    await order.save({ session });

    const total = Math.round(Number(order.total || 0));

    // Cierre del TOCTOU de crédito (auditoría P0 #6). Dentro de la transacción:
    // 1) punto de SERIALIZACIÓN por cliente — un write sobre el doc del Cliente hace
    //    que dos ventas a crédito concurrentes del mismo cliente choquen (WriteConflict)
    //    y session.withTransaction reintente una con snapshot fresco.
    // 2) RE-VALIDACIÓN autoritativa del cupo contra las deudas vigentes leídas en sesión.
    // El override (ya autorizado por admin/manager antes del claim) se respeta.
    await Cliente.updateOne(
      { _id: cliente._id },
      { $set: { "credito.ultima_venta_credito_at": now } },
      { session },
    );
    if (!credito.overrideUsado) {
      const pendientes = await Deuda.find({ cliente_id: cliente._id, estado: "pendiente" })
        .session(session)
        .lean();
      const est = estadoCredito(cliente, pendientes);
      if (!est.puede_comprar) {
        throw new ConflictError(`Venta a crédito rechazada al confirmar: ${est.motivo_rechazo || "bloqueado"}`);
      }
      if (est.saldo + total > Number(cliente.credito?.linea || 0)) {
        throw new ConflictError(`Crédito insuficiente al confirmar: disponible $${est.disponible}, requiere $${total}`);
      }
    }

    const condDias = Math.max(0, Math.round(Number(cliente.credito?.condicion_dias ?? 30)));
    const [deudaDoc] = await Deuda.create(
      [
        {
          cliente_id: cliente._id,
          cliente: cliente.razon_social,
          order_id: order._id,
          documento: `FCR-${String(order._id).slice(-6).toUpperCase()}`,
          fecha_emision: ymd(now),
          fecha_vencimiento: ymd(new Date(now.getTime() + condDias * 86400000)),
          monto: total,
          monto_original: total,
        },
      ],
      { session },
    );
    return { paid: order, deuda: deudaDoc };
  });

  // Factura best-effort (stub SII): nunca rompe el cobro.
  try {
    await emitDocumentForOrder(paid, "factura");
  } catch (err) {
    logger.warn({ orderId: String(paid._id), err: err.message }, "factura crédito best-effort falló");
  }

  // Auditoría: logAudit lee req.user → adaptamos el actor del servicio.
  const req = { user: { id: actor.user_id, role: actor.role, name: actor.label } };
  logAudit({
    req,
    action: "credito.venta",
    target: `${cliente.razon_social} (${cliente.rut})`,
    detail: `${deuda.documento}: $${deuda.monto} — vence ${deuda.fecha_vencimiento} (pedido ${String(paid._id).slice(-6).toUpperCase()})`,
  });
  if (credito.overrideUsado) {
    logAudit({
      req,
      action: "credito.override",
      target: `${cliente.razon_social} (${cliente.rut})`,
      detail: `Rechazo "${credito.motivo}" autorizado por ${actor.label} (${actor.role}) — pedido ${String(paid._id).slice(-6).toUpperCase()}`,
    });
  }

  logger.info(
    { orderId: String(paid._id), cliente: cliente.rut, deudaId: String(deuda._id), monto: deuda.monto },
    "venta a crédito cobrada (deuda creada)",
  );
  return paid;
};

export const cobrarPedido = async ({ orderId, metodo = "efectivo", amountReceived = null, clienteRut = null, override = false, by = null }) => {
  const method = METODO_MAP[metodo] || "cash_on_pickup";

  // CRÉDITO: validar cliente + cupo ANTES del claim. Si se rechaza → 409 sin
  // tocar la orden (nunca queda a medio cobrar). Ventana validación→emisión
  // mínima (misma caja, segundos) y auditable en el estado de cuenta.
  let credito = null;
  if (metodo === "credito") {
    const cur = await Order.findById(orderId).select("total status").lean();
    if (!cur) throw new NotFoundError("Pedido no encontrado");
    if (cur.status !== ORDER_STATUS.PENDING)
      throw new ConflictError("El pedido ya fue cobrado o no está por pagar");
    credito = await validarVentaCredito({ clienteRut, total: Math.round(Number(cur.total || 0)), override, by });
  }

  // Fija método + cajera SOLO si está POR_PAGAR (idempotente): re-cobrar un pedido
  // ya pagado/entregado no debe sobreescribir el método ni la cajera (corrompía el
  // cuadre). Si no matchea, ya fue cobrado → 409.
  const claim = await Order.updateOne(
    {
      _id: orderId,
      status: ORDER_STATUS.PENDING,
      // Webpay en vuelo: si el pago online está "processing" no se puede cobrar
      // en caja (riesgo de doble cobro si el webhook confirma después).
      "payment.status": mongoose.trusted({ $ne: PAYMENT_STATUS.PROCESSING }),
    },
    { $set: { "payment.method": method, "payment.cashier_id": by?.user_id || null } },
  );
  if (claim.matchedCount === 0) {
    const cur = await Order.findById(orderId).select("status payment.status").lean();
    if (cur?.status === ORDER_STATUS.PENDING && cur?.payment?.status === PAYMENT_STATUS.PROCESSING) {
      throw new ConflictError("Pago Webpay en curso: espera la confirmación antes de cobrar en caja");
    }
    throw new ConflictError("El pedido ya fue cobrado o no está por pagar");
  }

  if (metodo === "credito") {
    const paid = await cobrarACredito({ orderId, credito, by });
    emitRelayChange({ type: "cobro", id: String(orderId) });
    return paid;
  }

  const cash = metodo === "efectivo" ? { amount_received: amountReceived } : null;
  const paid = await markAsPaid({
    orderId,
    by,
    cash,
    note: `Cobrado (${metodo}) por ${by?.label || "caja"}`,
  });
  emitRelayChange({ type: "cobro", id: String(orderId) });
  return paid;
};

// ── Cola de picking segmentada: CHICOS (pickers nuevos) / GRANDES (expertos) ──

// Umbral de pedido GRANDE en CLP. CONFIGURABLE: ajustar aquí cuando el cliente
// entregue su tabla definitiva de metas/segmentos.
export const UMBRAL_GRANDE = 300000;

/** Pedido "grande" (pickers expertos): monto alto O muchos SKU (líneas). */
export const esGrande = (order) =>
  Number(order?.total || 0) >= UMBRAL_GRANDE || (order?.items || []).length > 10;

/** Segmento DERIVADO (no persistido) de la cola de picking. */
export const segmentoDe = (order) => (esGrande(order) ? "grande" : "chico");

/** Regla por experiencia: un picker "nuevo" solo toma CHICOS; "experto" toma ambos. */
export const nivelPuedeTomar = (nivel, order) => nivel === "experto" || !esGrande(order);

/**
 * Enforcement FIFO por segmento ANTES del claim (el claim atómico queda intacto).
 * Reglas:
 *  - admin/manager: toman cualquiera (override implícito por rol).
 *  - Pedido asignado a OTRA persona → 409 (solo el asignado puede tomarlo).
 *  - Pedido asignado AL actor → lo puede tomar aunque no sea el más antiguo.
 *  - Pedido sin asignar → 409 si existe otro paid MÁS ANTIGUO del MISMO segmento
 *    que también esté en la cola del actor (sin asignar, o asignado a él).
 */
const validarFifoPicking = async ({ orderId, actor }) => {
  if (["admin", "manager"].includes(actor.role)) return;

  const target = await Order.findById(orderId)
    .select("status total items.product_id items.name items.quantity assigned_to created_at")
    .lean();
  if (!target) throw new NotFoundError("Pedido no encontrado");

  // Gating por EXPERIENCIA: un picker "nuevo" no puede tomar un pedido GRANDE
  // (reservados a expertos). Los expertos toman ambos.
  if (actor.nivel === "nuevo" && esGrande(target)) {
    throw new ConflictError("Pedido GRANDE — reservado para pickers expertos");
  }

  const actorId = actor.user_id ? String(actor.user_id) : null;
  const assignedId = target.assigned_to?.user_id ? String(target.assigned_to.user_id) : null;
  if (assignedId) {
    if (assignedId !== actorId)
      throw new ConflictError(`Este pedido está asignado a ${target.assigned_to.label || "otra persona"}`);
    return; // el asignado lo toma aunque no sea el más antiguo
  }

  // La cola paid es corta (pedidos en vivo): traer los más antiguos y filtrar en memoria.
  const seg = segmentoDe(target);
  const candidatos = await Order.find({
    _id: mongoose.trusted({ $ne: target._id }),
    status: ORDER_STATUS.PAID,
    created_at: mongoose.trusted({ $lt: target.created_at }),
  })
    .select("total items.product_id assigned_to")
    .lean();

  const hayMasAntiguo = candidatos.some((o) => {
    if (segmentoDe(o) !== seg) return false;
    const aid = o.assigned_to?.user_id ? String(o.assigned_to.user_id) : null;
    // Asignado a OTRA persona no bloquea (no está en la cola del actor).
    return !aid || aid === actorId;
  });
  if (hayMasAntiguo) throw new ConflictError("Toma el pedido más antiguo de tu cola");
};

/**
 * RELAY DE SALA — el BODEGUERO acepta el pedido (etapa 3). CLAIM ATÓMICO:
 * findOneAndUpdate condicionado a status='paid' → solo UN bodeguero gana; el
 * resto recibe 409. No toca stock (el físico sale al marcar LISTO via commitPick).
 * Antes del claim se valida FIFO por segmento + asignación manual (assigned_to).
 */
export const aceptarPicking = async ({ orderId, by = null }) => {
  const now = new Date();
  const actor = {
    user_id: by?.user_id || null,
    role: by?.role || null,
    label: by?.label || "bodega",
    nivel: by?.nivel || null,
  };
  // Resolver el nivel del picker (nuevo/experto) para el gating por experiencia,
  // si no vino ya resuelto (p. ej. desde el tótem).
  if (!actor.nivel && actor.user_id && actor.role === ROLES.OPERATOR) {
    const u = await User.findById(actor.user_id).select("picker_nivel").lean();
    actor.nivel = u?.picker_nivel || "experto";
  }
  await validarFifoPicking({ orderId, actor });
  const updated = await Order.findOneAndUpdate(
    { _id: orderId, status: ORDER_STATUS.PAID },
    {
      $set: { status: ORDER_STATUS.PREPARING },
      $push: {
        status_history: {
          status: ORDER_STATUS.PREPARING,
          changed_at: now,
          note: `Picking aceptado por ${actor.label}`,
          changed_by: actor,
        },
      },
    },
    { new: true },
  );
  if (!updated) {
    const exists = await Order.findById(orderId).select("status").lean();
    if (!exists) throw new NotFoundError("Pedido no encontrado");
    throw new ConflictError("Ese pedido ya fue tomado por otro bodeguero");
  }
  logger.info({ orderId: String(updated._id), by: actor.label }, "picking aceptado (claim atómico)");
  emitRelayChange({ type: "aceptar", id: String(updated._id) });
  return updated;
};

/**
 * TÓTEM — cola que ve un picker: pedidos DISPONIBLES que puede tomar (gateados por su
 * nivel: "nuevo" solo chicos) y sus pedidos EN CURSO (asignados a él, en preparación).
 * Para expertos, los GRANDES se muestran primero (prioridad), luego chicos; ambos FIFO.
 */
export const colaParaPicker = async ({ pickerId, nivel = "experto" }) => {
  const pid = pickerId ? String(pickerId) : null;
  const paid = await Order.find({ status: ORDER_STATUS.PAID })
    .select("total items customer created_at assigned_to")
    .sort({ created_at: 1 })
    .limit(60)
    .lean();

  const disponibles = paid
    .filter((o) => {
      const aid = o.assigned_to?.user_id ? String(o.assigned_to.user_id) : null;
      if (aid && aid !== pid) return false; // asignado a otra persona
      return nivelPuedeTomar(nivel, o); // el "nuevo" no ve los grandes
    })
    .sort((a, b) => {
      if (nivel === "experto") {
        const ga = esGrande(a) ? 0 : 1, gb = esGrande(b) ? 0 : 1;
        if (ga !== gb) return ga - gb; // grandes primero
      }
      return new Date(a.created_at) - new Date(b.created_at); // FIFO
    })
    .map((o) => ({ _id: o._id, total: o.total, items: o.items, customer: o.customer, created_at: o.created_at, segmento: segmentoDe(o) }));

  let enCurso = [];
  if (pid) {
    enCurso = await Order.find({
      status: ORDER_STATUS.PREPARING,
      "assigned_to.user_id": new mongoose.Types.ObjectId(pid),
    })
      .select("total items customer created_at pick_progress")
      .sort({ created_at: 1 })
      .lean();
  }
  return { disponibles, en_curso: enCurso };
};

// ── Perfil del vendedor de sala: SUS métricas y SU historial ──────────────────
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

/** Métricas propias del vendedor: ventas, pedidos y clientes atendidos (hoy/semana/mes)
 *  + puntos de incentivos del mes y progreso hacia la meta mensual. */
export const misMetricasVendedor = async ({ userId }) => {
  const sellerId = new mongoose.Types.ObjectId(String(userId));
  const now = new Date();
  const inicioMes = new Date(now.getFullYear(), now.getMonth(), 1);
  const hace7 = startOfDay(new Date(now.getTime() - 6 * 86400000));
  const hoy0 = startOfDay(now);
  const desde = inicioMes < hace7 ? inicioMes : hace7; // el rango más amplio cubre los tres

  const orders = await Order.find({
    "seller.id": sellerId,
    status: mongoose.trusted({ $ne: ORDER_STATUS.CANCELLED }),
    created_at: mongoose.trusted({ $gte: desde }),
  })
    .select("total customer.rut customer.fullName items.quantity created_at")
    .lean();

  const blank = () => ({ ventas: 0, pedidos: 0, unidades: 0, clientes: new Set() });
  const hoy = blank(), semana = blank(), mes = blank();
  const add = (b, o) => {
    b.ventas += o.total || 0;
    b.pedidos += 1;
    b.unidades += (o.items || []).reduce((s, it) => s + (it.quantity || 0), 0);
    // "Persona atendida" = RUT distinto; si es anónimo (mostrador), cada pedido cuenta como uno.
    b.clientes.add(o.customer?.rut || String(o._id));
  };
  for (const o of orders) {
    const c = new Date(o.created_at);
    if (c >= inicioMes) add(mes, o);
    if (c >= hace7) add(semana, o);
    if (c >= hoy0) add(hoy, o);
  }
  const fin = (b) => ({ ventas: Math.round(b.ventas), pedidos: b.pedidos, unidades: b.unidades, clientes: b.clientes.size });
  const mesF = fin(mes);
  const puntos = calcularPuntos({ unidades: mesF.unidades, monto: mesF.ventas });
  return {
    hoy: fin(hoy),
    semana: fin(semana),
    mes: mesF,
    incentivos: {
      puntos,
      meta: META_VENDEDOR_MENSUAL,
      progresoPct: META_VENDEDOR_MENSUAL > 0 ? Math.min(100, Math.round((mesF.ventas / META_VENDEDOR_MENSUAL) * 100)) : 0,
      faltaParaMeta: Math.max(0, META_VENDEDOR_MENSUAL - mesF.ventas),
    },
  };
};

/** Historial de pedidos del vendedor (sus boletas), más recientes primero. */
export const misPedidosVendedor = async ({ userId, limit = 30 }) => {
  const orders = await Order.find({ "seller.id": new mongoose.Types.ObjectId(String(userId)) })
    .sort({ created_at: -1 })
    .limit(Math.min(100, Number(limit) || 30))
    .select("customer total status created_at items")
    .lean();
  return orders.map((o) => ({
    _id: String(o._id),
    cliente: o.customer?.fullName || "Mostrador",
    rut: o.customer?.rut || null,
    total: o.total || 0,
    status: o.status,
    fecha: o.created_at,
    items: (o.items || []).length,
  }));
};

// ── Picking etapa 3: avance persistido, faltantes y cierre de empaque ─────────

/** Marca/desmarca un ítem como pickeado (y si vino por escáner). Persiste el avance. */
export const actualizarPick = async ({ orderId, productId, picked = true, scanned = false }) => {
  const order = await Order.findById(orderId);
  if (!order) throw new NotFoundError("Pedido no encontrado");
  const pid = String(productId);
  const prog = new Set((order.pick_progress || []).map(String));
  const scan = new Set((order.pick_scanned || []).map(String));
  if (picked) { prog.add(pid); if (scanned) scan.add(pid); }
  else { prog.delete(pid); scan.delete(pid); }
  order.pick_progress = [...prog];
  order.pick_scanned = [...scan];
  await order.save();
  return order;
};

/** Reporta faltante/dañado de un ítem: registra el faltante, ajusta el inventario
 *  físico a la realidad del estante y marca el pedido para revisión (no lo cancela). */
export const registrarFaltante = async ({ orderId, productId, qtyReal = 0, motivo = "", by = null }) => {
  const order = await Order.findById(orderId);
  if (!order) throw new NotFoundError("Pedido no encontrado");
  const pid = String(productId);
  const item = (order.items || []).find((it) => String(it.product_id) === pid);
  const esperado = item ? item.quantity || 0 : 0;
  const real = Math.max(0, Math.round(Number(qtyReal) || 0));
  const faltan = Math.max(0, esperado - real);
  if (faltan > 0 && item) {
    // Ajuste de inventario: el estante tenía menos de lo que el sistema creía.
    try {
      await adjustStock({ productId: item.product_id, delta: -faltan, reason: `Faltante picking #${String(order._id).slice(-6)}: ${motivo || "sin detalle"}`, by });
    } catch { /* el ajuste no debe romper el registro del faltante */ }
  }
  order.faltantes.push({ product_id: pid, name: item?.name || "", qty_real: real, motivo: String(motivo || ""), by: by?.label || "bodega", at: new Date() });
  order.needs_review = true;
  const prog = new Set((order.pick_progress || []).map(String)); prog.add(pid); // resuelto → permite seguir
  order.pick_progress = [...prog];
  order.status_history.push({ status: order.status, changed_at: new Date(), note: `Faltante: ${item?.name || pid} (real ${real}/${esperado}) — ${motivo || "sin detalle"}`, changed_by: { user_id: by?.user_id || null, role: by?.role || null, label: by?.label || "bodega" } });
  await order.save();
  emitRelayChange({ type: "faltante", id: String(order._id) });
  return order;
};

// ── Monitores por zona: estado por sector y "zona lista" ─────────────────────

/**
 * Estado DERIVADO de una zona dentro de un pedido:
 * - "lista": el sector está en zone_done O todos sus ítems ya fueron pickeados.
 * - "preparando": el pedido está en preparación (preparing).
 * - "pendiente": pagado y a la espera (paid).
 */
export const zonaEstado = (order, sector) => {
  const sec = String(sector || "").trim();
  if ((order?.zone_done || []).some((z) => String(z.sector || "").trim() === sec)) return "lista";
  const items = (order?.items || []).filter((it) => String(it.sector || "").trim() === sec);
  const prog = new Set((order?.pick_progress || []).map(String));
  if (items.length > 0 && items.every((it) => prog.has(String(it.product_id)))) return "lista";
  if (order?.status === ORDER_STATUS.PREPARING) return "preparando";
  return "pendiente";
};

/**
 * El dueño de área marca SU zona como preparada (ruta pública del monitor).
 * Acepta el _id completo o el folio corto (últimos 6+ hex) — patrón findByScan:
 * match por sufijo sobre los pedidos recientes paid/preparing, ambiguo → 409.
 * Idempotente: si la zona ya estaba marcada responde igual sin duplicar.
 */
export const marcarZonaLista = async ({ orderIdOrFolio, sector, by = null }) => {
  const sec = String(sector || "").trim();
  if (!sec) throw new BadRequestError("Falta el sector");
  const codigo = String(orderIdOrFolio || "").trim();

  let order = null;
  if (mongoose.isValidObjectId(codigo)) order = await Order.findById(codigo).lean();
  if (!order && /^[a-f0-9]{6,12}$/i.test(codigo)) {
    const suf = codigo.toLowerCase();
    const recientes = await Order.find(
      { status: mongoose.trusted({ $in: [ORDER_STATUS.PAID, ORDER_STATUS.PREPARING] }) },
      { _id: 1 },
    ).sort({ created_at: -1 }).limit(400).lean();
    const hits = recientes.filter((o) => String(o._id).endsWith(suf));
    if (hits.length > 1) throw new ConflictError("Folio ambiguo, usa el código completo");
    if (hits.length === 1) order = await Order.findById(hits[0]._id).lean();
  }
  if (!order) throw new NotFoundError("Pedido no encontrado");

  const ya = (order.zone_done || []).some((z) => String(z.sector || "").trim() === sec);
  if (!ya) {
    // Solo zonas reales del pedido (ruta pública: no acumular basura arbitraria).
    const tiene = (order.items || []).some((it) => String(it.sector || "").trim() === sec);
    if (!tiene) throw new BadRequestError("El pedido no tiene ítems de ese sector");
    if (![ORDER_STATUS.PAID, ORDER_STATUS.PREPARING].includes(order.status))
      throw new ConflictError("El pedido ya no está en preparación");
    // Guard $ne: dos monitores simultáneos no duplican la zona.
    await Order.updateOne(
      { _id: order._id, "zone_done.sector": mongoose.trusted({ $ne: sec }) },
      { $push: { zone_done: { sector: sec, at: new Date(), by_label: by?.label || "monitor" } } },
    );
    emitRelayChange({ type: "zone", id: String(order._id), sector: sec });
  }
  return { ok: true, sector: sec, zona_lista: true };
};

/** Cierre de empaque + LISTO: guarda nº de bultos/peso y transiciona a ready
 *  (valida VALID_TRANSITIONS y descuenta el físico vía commitOrderPick). */
export const empacarYListo = async ({ orderId, bultos = null, peso = null, by = null }) => {
  await Order.updateOne(
    { _id: orderId },
    { $set: { "packing.bultos": bultos != null ? Math.max(0, Math.round(Number(bultos))) : null, "packing.peso": peso != null ? Math.max(0, Number(peso)) : null } },
  );
  return transitionOrderStatus({
    orderId,
    newStatus: ORDER_STATUS.READY,
    byAdmin: true,
    by,
    note: bultos != null ? `Empacado: ${bultos} bulto${bultos === 1 ? "" : "s"}` : "Listo para retiro",
  });
};

export default { createTakeOrder, cobrarPedido, aceptarPicking, esGrande, segmentoDe, misMetricasVendedor, misPedidosVendedor, actualizarPick, registrarFaltante, empacarYListo, zonaEstado, marcarZonaLista };
