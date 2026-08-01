import { asyncHandler } from "../middlewares/errorHandler.js";
import {
  enviarPedidoASeguimiento,
  sincronizarEstado,
  procesarWebhook,
  estadoExternoDe,
} from "../services/seguimientoExternoService.js";

/**
 * POST /api/integraciones/seguimiento/pedidos/:id
 * Envía (o reenvía) el pedido al proveedor externo. Idempotente: si ya tiene
 * referencia externa, devuelve la existente sin volver a enviarlo.
 */
export const enviarPedidoHandler = asyncHandler(async (req, res) => {
  const data = await enviarPedidoASeguimiento(req.params.id);
  res.json({ success: true, data });
});

/**
 * GET /api/integraciones/seguimiento/pedidos/:id
 * Estado del pedido EN EL PROVEEDOR (lo que sabemos de él).
 */
export const estadoExternoHandler = asyncHandler(async (req, res) => {
  const data = await estadoExternoDe(req.params.id);
  res.json({ success: true, data });
});

/**
 * POST /api/integraciones/seguimiento/pedidos/:id/sincronizar
 * Consulta activa al proveedor. Es el respaldo del webhook: si el proveedor no
 * empuja o se perdió un evento, esto trae el estado actual.
 */
export const sincronizarHandler = asyncHandler(async (req, res) => {
  const data = await sincronizarEstado(req.params.id);
  res.json({ success: true, data });
});

/**
 * POST /api/integraciones/seguimiento/webhook
 *
 * PÚBLICO: lo llama el proveedor. La autorización es la FIRMA del payload, que
 * verifica el adapter del proveedor (`verificarFirma`). Siempre responde 200
 * salvo firma inválida o payload irreconocible: un proveedor no debe reintentar
 * eternamente por un pedido que no es nuestro.
 */
export const webhookHandler = asyncHandler(async (req, res) => {
  const data = await procesarWebhook({
    payload: req.body,
    headers: req.headers,
    rawBody: req.rawBody || null,
  });
  res.json({ success: true, data });
});

export default { enviarPedidoHandler, estadoExternoHandler, sincronizarHandler, webhookHandler };
