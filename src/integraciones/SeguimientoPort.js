// =============================================================================
// PUERTO DE SEGUIMIENTO EXTERNO
//
// Cibox tiene que poder enviar sus pedidos a un software externo de seguimiento
// (courier, TMS, last-mile, ERP…) que TODAVÍA NO ESTÁ DEFINIDO.
//
// Aquí NO hay ninguna integración concreta: solo el BORDE. Se define el
// contrato que cualquier proveedor tendrá que cumplir y se entrega un adapter
// falso que registra en log, para que el flujo completo (enviar → consultar →
// recibir webhook) se pueda ejercitar de punta a punta sin proveedor.
//
// Cuando Cibox elija el proveedor real, se escribe un adapter que implemente
// esta misma interfaz y se enchufa por variable de entorno. Nada más del
// sistema cambia. Ver PLAN.md §6 para el checklist de conexión.
// =============================================================================

import { logger } from "../utils/logger.js";

/**
 * CONTRATO — todo proveedor de seguimiento implementa estos tres métodos.
 *
 * 1. enviarPedido(pedido)   → registra el pedido en el sistema externo.
 * 2. consultarEstado(ref)   → pregunta en qué va (consulta activa / respaldo).
 * 3. normalizarWebhook(payload, headers) → traduce lo que el proveedor
 *    empuja a nuestro vocabulario. Recibir el webhook (ruta, firma, respuesta
 *    HTTP) lo hace el backend; el adapter solo traduce y valida la firma.
 *
 * Vocabulario común (lo que el resto del sistema entiende). Cada adapter
 * traduce los estados del proveedor a estos:
 */
export const ESTADOS_SEGUIMIENTO = {
  RECIBIDO: "recibido",       // el proveedor aceptó el pedido
  EN_RUTA: "en_ruta",         // salió a reparto
  ENTREGADO: "entregado",     // llegó al cliente
  FALLIDO: "fallido",         // no se pudo entregar
  DEVUELTO: "devuelto",       // volvió a la bodega
  DESCONOCIDO: "desconocido", // el proveedor mandó algo que no sabemos mapear
};

/**
 * Forma del pedido que se le envía al proveedor. Deliberadamente mínima y
 * estable: si el proveedor pide más campos, los agrega SU adapter.
 *
 * @typedef {Object} PedidoParaSeguimiento
 * @property {string} referencia   nuestro identificador (folio del pedido)
 * @property {string} order_id     _id del pedido en Cibox
 * @property {Object} destinatario { nombre, telefono, email }
 * @property {Object} direccion    { linea1, comuna, ciudad, region, referencia }
 * @property {Array}  bultos       [{ n, peso_kg }]
 * @property {number} total        monto del pedido en CLP
 * @property {string} [notas]
 */

/**
 * Resultado de `enviarPedido`.
 *
 * @typedef {Object} EnvioResultado
 * @property {boolean} ok
 * @property {string}  proveedor
 * @property {string}  ref_externa   id del pedido EN EL PROVEEDOR
 * @property {string}  estado        uno de ESTADOS_SEGUIMIENTO
 * @property {string} [url_seguimiento]
 */

/**
 * ADAPTER FALSO — el que corre mientras no hay proveedor.
 *
 * No llama a ninguna API: registra en log lo que haría y devuelve una respuesta
 * con la forma exacta del contrato. Sirve para que el flujo completo funcione
 * en desarrollo y para que los tests ejerciten el puerto sin red.
 *
 * Sus referencias externas llevan el prefijo LOG- para que sea imposible
 * confundirlas con las de un proveedor real.
 */
export class SeguimientoLog {
  constructor({ nombre = "log" } = {}) {
    this.nombre = nombre;
  }

  async enviarPedido(pedido) {
    const ref = `LOG-${String(pedido?.referencia || pedido?.order_id || "SIN-REF")}`;
    logger.info(
      {
        proveedor: this.nombre,
        referencia: pedido?.referencia,
        order_id: pedido?.order_id,
        comuna: pedido?.direccion?.comuna,
        bultos: Array.isArray(pedido?.bultos) ? pedido.bultos.length : 0,
        total: pedido?.total,
      },
      "seguimiento.enviarPedido (adapter de log: no se llamó a ningún proveedor)",
    );
    return {
      ok: true,
      proveedor: this.nombre,
      ref_externa: ref,
      estado: ESTADOS_SEGUIMIENTO.RECIBIDO,
      url_seguimiento: null,
    };
  }

  async consultarEstado(refExterna) {
    logger.info(
      { proveedor: this.nombre, ref_externa: refExterna },
      "seguimiento.consultarEstado (adapter de log: no se llamó a ningún proveedor)",
    );
    // Sin proveedor no hay novedades que reportar: el estado real del pedido lo
    // manda la máquina de estados interna, no este adapter.
    return {
      ok: true,
      proveedor: this.nombre,
      ref_externa: refExterna,
      estado: ESTADOS_SEGUIMIENTO.DESCONOCIDO,
      eventos: [],
    };
  }

  /**
   * Traduce lo que empuja el proveedor. El adapter de log acepta cualquier
   * payload y solo exige la referencia, para poder probar el webhook de punta
   * a punta con curl.
   */
  async normalizarWebhook(payload = {}) {
    const ref = payload.ref_externa || payload.reference || payload.tracking || null;
    const estado = MAPA_ESTADOS_LOG[String(payload.estado || payload.status || "").toLowerCase()]
      || ESTADOS_SEGUIMIENTO.DESCONOCIDO;
    logger.info(
      { proveedor: this.nombre, ref_externa: ref, estado_recibido: payload.estado || payload.status, estado },
      "seguimiento.webhook (adapter de log)",
    );
    return {
      ok: Boolean(ref),
      proveedor: this.nombre,
      ref_externa: ref,
      estado,
      ocurrido_en: payload.ocurrido_en || payload.timestamp || null,
      detalle: payload.detalle || payload.description || null,
    };
  }

  /**
   * Verificación de firma del webhook. El adapter de log NO valida nada y lo
   * dice en voz alta: un proveedor real DEBE implementar esto (HMAC, mTLS, o
   * lo que exija su documentación) o cualquiera podría mover los pedidos.
   */
  verificarFirma() {
    logger.warn(
      { proveedor: this.nombre },
      "seguimiento.webhook: el adapter de log no verifica firma — no usar en producción",
    );
    return true;
  }
}

/** Mapa de ejemplo. Cada proveedor real traerá el suyo. */
const MAPA_ESTADOS_LOG = {
  recibido: ESTADOS_SEGUIMIENTO.RECIBIDO,
  created: ESTADOS_SEGUIMIENTO.RECIBIDO,
  en_ruta: ESTADOS_SEGUIMIENTO.EN_RUTA,
  in_transit: ESTADOS_SEGUIMIENTO.EN_RUTA,
  entregado: ESTADOS_SEGUIMIENTO.ENTREGADO,
  delivered: ESTADOS_SEGUIMIENTO.ENTREGADO,
  fallido: ESTADOS_SEGUIMIENTO.FALLIDO,
  failed: ESTADOS_SEGUIMIENTO.FALLIDO,
  devuelto: ESTADOS_SEGUIMIENTO.DEVUELTO,
  returned: ESTADOS_SEGUIMIENTO.DEVUELTO,
};

/**
 * Cómo se traduce un estado del proveedor a un estado NUESTRO del pedido.
 * Solo `entregado` mueve el pedido; el resto es informativo. Deliberado: el
 * proveedor informa, pero la máquina de estados interna (pedidos/estados.js)
 * sigue mandando — un webhook no puede saltarse una etapa ni resucitar un
 * pedido anulado.
 */
export const ESTADO_PEDIDO_SEGUN_SEGUIMIENTO = {
  [ESTADOS_SEGUIMIENTO.RECIBIDO]: null,
  [ESTADOS_SEGUIMIENTO.EN_RUTA]: "shipped",
  [ESTADOS_SEGUIMIENTO.ENTREGADO]: "delivered",
  [ESTADOS_SEGUIMIENTO.FALLIDO]: null,
  [ESTADOS_SEGUIMIENTO.DEVUELTO]: null,
  [ESTADOS_SEGUIMIENTO.DESCONOCIDO]: null,
};

/**
 * FÁBRICA del proveedor de seguimiento.
 *
 * Sin `TRACKING_PROVIDER` configurado → adapter de log. Con un proveedor
 * declarado pero sin adapter escrito → error EXPLÍCITO al arrancar la
 * operación, nunca un silencio que parezca que el pedido se envió.
 *
 * Para enchufar el proveedor real:
 *   1. Escribir `integraciones/adapters/<proveedor>.js` con los cuatro métodos.
 *   2. Registrarlo en ADAPTERS (abajo).
 *   3. Setear TRACKING_PROVIDER=<proveedor> y sus credenciales por entorno.
 */
const ADAPTERS = {
  log: (cfg) => new SeguimientoLog(cfg),
};

export function getProveedorSeguimiento(config = {}) {
  const provider = String(config.provider || "log").toLowerCase();
  const factory = ADAPTERS[provider];
  if (factory) return factory({ ...config, nombre: provider });
  throw new Error(
    `Proveedor de seguimiento '${provider}' no implementado. ` +
      "Escribe un adapter en integraciones/adapters/ que cumpla el contrato de " +
      "SeguimientoPort (enviarPedido, consultarEstado, normalizarWebhook, verificarFirma) " +
      "y regístralo en ADAPTERS. Ver PLAN.md §6.",
  );
}

export default { getProveedorSeguimiento, SeguimientoLog, ESTADOS_SEGUIMIENTO };
