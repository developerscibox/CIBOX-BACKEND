# CAMBIOS — Optimización + base WMS para Bodega 12

Fecha: 2026-06-09
Base: cibox_backend_v2 (Express 5 + Mongoose 9) y cibox_frontend (Expo universal)

---

## 1. Bugs críticos corregidos

### 1.1 Fuga de stock al cancelar órdenes pendientes (CRÍTICO)
**Problema:** el stock se descuenta al **crear** la orden (estado `pending`),
pero `cancelOrder` solo lo reponía si la orden estaba pagada. Resultado:
cancelar una orden pendiente perdía el stock para siempre.
**Fix:** `cancelOrder` ahora repone stock **siempre** que no se haya repuesto
antes, con flag idempotente `stock_restored` en la orden.
Archivos: `src/services/orderService.js`, `src/models/Order.js`

### 1.2 Checkouts abandonados retenían stock indefinidamente (CRÍTICO)
**Problema:** no existía expiración de órdenes `pending` → cada carrito
abandonado dejaba stock "fantasma" descontado para siempre.
**Fix:** nuevo job `src/jobs/expirePendingOrders.js` que cada
`ORDER_EXPIRY_CHECK_MINUTES` (default 10) cancela órdenes `pending` con más de
`ORDER_PENDING_TTL_MINUTES` (default 60) sin pago, reponiendo stock. No toca
órdenes con pago en proceso (`processing`/`processing_commit`) y es inmune a
carreras con el webhook de Webpay (la transición valida estado actual).
Configurable por variables de entorno. Se inicia/detiene limpio en `server.js`.

### 1.3 Cancelación por admin saltaba la reposición de stock (CRÍTICO)
**Problema:** `PATCH /orders/admin/:id/status` con `status=cancelled` tenía su
propia lógica duplicada: cambiaba el estado pero **no reponía stock ni
revertía el cupón** (a diferencia de `POST /orders/admin/:id/cancel`).
**Fix:** el controller ahora delega todas las transiciones a
`transitionOrderStatus` del service, que enruta `cancelled` → `cancelOrder`.
Una sola fuente de verdad.
Archivo: `src/controllers/orderController.js`

### 1.4 Datos descartados silenciosamente por el schema
**Problema:** `trackingService` escribía `shipping.events`, `shipped_at` y
`delivered_at`, y `refundService` leía `paid_at` — ninguno existía en el
schema de Order → Mongoose los descartaba sin error. La ventana de reembolso
se calculaba contra `updated_at`.
**Fix:** agregados al schema `paid_at`, `shipped_at`, `delivered_at`,
`shipping.events[]`, `shipping.last_event_at`, `shipping.last_synced_at`,
`shipping.estimated_delivery`. `finalizePaidOrder` ahora setea `paid_at`.

### 1.5 Historial de estados incompleto y sin autor
**Problema:** solo el endpoint admin escribía `status_history`; las
transiciones por webhook de pago, cancelaciones y el service genérico no
dejaban rastro. Además no se registraba **quién** hizo el cambio (requisito
central del cliente: "saber en qué etapa está cada pedido y quién la movió").
**Fix:** helper `appendHistory()` usado en creación, pago, cancelación y toda
transición; el historial ahora incluye `changed_by: { user_id, role, label }`
("webpay", "admin", email del usuario, "sistema:expiracion", etc.).
El log de `transitionOrderStatus` también registraba `from == to` (capturaba
el estado después de mutarlo) — corregido.

### 1.6 N+1 en la reconstrucción de items
**Problema:** `rebuildItemsFromCart` y `rebuildItemsFromCustomBox` hacían un
`findById` por producto dentro de `Promise.all` (N queries + N para hijos de
cajas).
**Fix:** una sola query `$in` por grupo. Con carritos de 20+ items en una
distribuidora mayorista, esto reduce la latencia del checkout de forma
notoria.

### 1.7 Limpieza de arranque
- `app.js` importaba scripts de seed/borrado de producción
  (`seedProducts`, `deleteProducts`, `deleteEmptyCategories .js`) — removidos.
- `npm run lint` estaba roto (ESLint 9 sin flat config) — agregado
  `eslint.config.js` mínimo. Todo el código modificado pasa con 0 errores.

---

## 2. Base WMS nueva (lo que pidió el gerente de Bodega 12)

### 2.1 Kardex de inventario — `StockMovement` (nuevo modelo)
Registro inmutable de **cada** movimiento de stock: producto, orden asociada,
tipo, cantidad (±), stock resultante, motivo y autor. Tipos:
`venta`, `anulacion`, `expiracion`, `reembolso`, `ajuste`, `recepcion`.
Se escribe en la **misma transacción** que el cambio de stock, así kardex y
stock nunca se desincronizan. Alimentado automáticamente desde: creación de
orden, cancelación, expiración, reembolso y ajustes manuales.

### 2.2 Endpoints de inventario — `/api/inventory` (nuevos)
| Método | Ruta | Quién | Para qué |
|---|---|---|---|
| GET | `/movements` | admin | Kardex paginado con filtros (producto, orden, tipo, fechas) |
| POST | `/adjust` | admin | Ajuste manual con motivo obligatorio (conteo, merma) → queda en kardex |
| GET | `/low-stock?threshold=` | admin | Stock crítico para el dashboard del supervisor |
| GET | `/by-barcode/:code` | autenticado | Lookup por código de barras → validación de picking por escaneo |

### 2.3 Ubicaciones y códigos de barra en Product
Nuevos campos: `barcode` (EAN-13 del fabricante o interno, indexado) y
`location { zone, rack, level, code }` (ej: "A-03-2") para que el bodeguero
sepa **dónde** está cada producto al hacer picking.

### 2.4 Estado `ready` (preparado) en la máquina de estados
Flujo nuevo: `pending → paid → preparing → ready → shipped → delivered`.
`preparing → shipped` sigue siendo válido (compatibilidad con órdenes y
flujos existentes). Actualizado en: constants, validador zod, emails y push
al cliente, panel admin (filtros + botones) y timeline del cliente en
OrderDetailScreen.

---

## 3. Frontend

- `AdminOrdersScreen`: filtro "Preparadas", botones `preparing → ready → shipped`.
- `OrderDetailScreen`: paso "Listo p/ despacho" en el timeline del cliente.
- `src/constants/theme.bodega12.js` (nuevo): paleta violeta/fucsia de
  Bodega 12 como reemplazo directo de `theme.js` — el rebrand completo de la
  app es cambiar un solo archivo.

---

## 4. Migración / despliegue

1. **Sin migración de datos obligatoria**: los campos nuevos tienen defaults;
   las órdenes existentes siguen funcionando.
2. Variables de entorno nuevas (opcionales, tienen default):
   `ORDER_PENDING_TTL_MINUTES=60`, `ORDER_EXPIRY_CHECK_MINUTES=10`.
3. Al primer arranque, el job de expiración cancelará órdenes `pending`
   antiguas acumuladas y **repondrá su stock**. Si hay muchas históricas que
   no quieres tocar, márcalas antes:
   `db.orders.updateMany({status:"pending", created_at:{$lt: ISODate("...")}}, {$set:{stock_restored:true}})`
   y cancélalas aparte sin reposición.
4. Los índices nuevos (barcode parcial, location.code, StockMovement) se
   crean solos vía Mongoose `autoIndex` en dev; en producción correr
   `syncIndexes()` o crearlos manualmente.

---

## 5. Recomendaciones pendientes (no incluidas a propósito)

- `JWT_ACCESS_EXPIRES` default es **30d** — muy largo para un access token
  habiendo refresh. Bajar a 1–12h cuando puedas coordinar un deploy de
  frontend+backend juntos (el interceptor de axios ya maneja el refresh).
- En web, los tokens viven en `localStorage` (riesgo XSS). Mitigación
  estándar: refresh token en cookie httpOnly. Es un cambio mediano de
  auth — para una fase 2.
- Picking guiado item-por-item con checklist y escaneo (la pantalla del
  bodeguero de los mockups): la base ya está (barcode lookup + location +
  estado ready); falta el modelo `picking_progress` por orden y la pantalla
  móvil. Estimado: 1–2 semanas.
- Realtime: hoy el panel admin refresca por pull. Para "ver pedidos nuevos
  sin refrescar" agregar Socket.IO o polling corto (15s) — trivial con esta
  arquitectura.
- Multi-tenant (vender el SaaS a otras distribuidoras): el modelo `Vendor`
  existente es multi-marketplace, no multi-tenant. Requiere `tenant_id` en
  todas las colecciones + scoping en queries. Fase 3.
