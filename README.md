# Cibox Backend v2.0

Marketplace backend hardened — Node.js / Express 5 / Mongoose 9 / Webpay Transbank / BlueExpress.

Esta versión re-implementa el backend v1 manteniendo la misma estructura (`controllers / models / routes / services / utils`) pero corrigiendo los 20 hallazgos del reporte de auditoría y agregando los módulos faltantes para poder salir a producción.

---

## Cambios respecto a v1

### Correcciones críticas
- **Webpay** configurado por `NODE_ENV` (sandbox en dev, producción con credenciales reales en prod)
- **Commit de Webpay** valida `response.amount === order.total` y loggea alerta crítica si no coincide
- **Inyección NoSQL** eliminada — todos los inputs validados con Zod, `query parser` en modo `simple`
- **Transacciones Mongo** en creación de orden y en `finalizePaidOrder` — stock, cupón y estado se actualizan atómicamente
- **Cupones** se aplican de verdad (`discount_amount` real, `CouponUsage` creado, `used_count` incrementado)
- **Stock atómico** con `findOneAndUpdate({stock: {$gte: qty}}, {$inc: {stock: -qty}})`
- **Idempotencia** del webhook Webpay vía `payment.webhook_processed_at`
- **Lock optimista** en commit Webpay vía `findOneAndUpdate` con filtro de estado
- **Ownership** de órdenes guest firmada con HMAC (`x-guest-id` ya no es texto plano del cliente)
- **Tokens de email/reset** almacenados hasheados (SHA-256), no en claro
- **JWT**: access 15m + refresh 7d con rotación y revocación
- **Bcrypt rounds = 12**, política de password mínima 8 caracteres
- **CORS** con whitelist desde `ALLOWED_ORIGINS`, helmet y compression activos
- **Rate limiting** global + específico en `/auth/*` y endpoints de email
- **Stack traces** nunca expuestos en producción
- **Logs** con pino + redacción automática de passwords, tokens, credenciales
- **Mass-assignment** bloqueado en `updateProduct` con whitelist Zod + whitelist server-side
- **Índices Mongo** en todas las colecciones calientes
- **Query parser simple** en Express para rechazar operadores NoSQL en query strings
- **Máquina de estados** de órdenes con `VALID_TRANSITIONS`
- **Reportes** solo cuentan órdenes en `PAID_STATUSES`
- **Pricing tiered** aplicado correctamente en carrito (no más `tiers[0]`)
- **N+1** eliminado en `getRecommendedProductsForMe` (4-5 queries vs cientos)
- **Paginación** nativa de Mongo en `getProducts` (no carga todo en RAM)

### Módulos nuevos
- `refunds/` — devoluciones con integración Webpay + reposición de stock
- `uploads/` — subida de imágenes (disk local o S3)
- `addresses/` — libreta de direcciones del usuario
- `tracking/` — tracking público de envío + webhook BlueExpress
- `tax-documents/` — boleta/factura electrónica SII (stub estructurado listo para integrar)
- `guest/` — emisión de `guest_id` firmado HMAC

---

## Estructura

```
cibox_backend-v2/
├── server.js                    # Boot + graceful shutdown
├── package.json
├── .env.example
└── src/
    ├── app.js                   # Express, middlewares globales, rutas
    ├── config/
    │   ├── env.js               # Zod validation al boot
    │   ├── db.js                # Mongo + sanitizeFilter
    │   └── webpay.js            # Transbank env-aware
    ├── middlewares/
    │   ├── authMiddleware.js    # protect, optionalAuth, requireEmailVerified
    │   ├── roleMiddleware.js    # requireAdmin, requireVendor, requireRole
    │   ├── errorHandler.js      # asyncHandler, notFoundHandler, errorHandler
    │   ├── validate.js          # Zod runner (body/query/params)
    │   ├── rateLimiters.js      # global, auth, email, guestOrder
    │   ├── upload.js            # multer memoryStorage
    │   ├── staticUploads.js     # sirve /uploads si UPLOAD_DRIVER=disk
    │   └── requestId.js
    ├── controllers/             # 23 controllers, todos asyncHandler
    ├── models/                  # 16 modelos con índices
    ├── routes/                  # 23 routers con validate + rate-limit
    ├── services/                # 12 services (lógica de negocio pura)
    ├── utils/
    │   ├── logger.js            # pino + redact
    │   ├── errors.js            # AppError + subclases
    │   ├── constants.js         # ORDER_STATUS, PAID_STATUSES, VALID_TRANSITIONS, ROLES
    │   ├── transactions.js      # withTransaction wrapper
    │   ├── ownership.js         # identity + assertOwner (user | guest firmado)
    │   ├── guestId.js           # HMAC sign/verify
    │   ├── rut.js               # validador módulo 11
    │   ├── notification.js      # helpers con skip seguro
    │   ├── review.js            # recalculateProductRating
    │   ├── normalizeText.js
    │   └── emailTemplates.js    # con escapeHtml
    ├── validators/              # 20 schemas Zod
    └── seed/
```

---

## Arranque

```bash
# 1. Dependencias
npm install

# 2. Configuración
cp .env.example .env
# editar .env con secretos reales (mínimo 32 chars para JWT_SECRET, JWT_REFRESH_SECRET, GUEST_ID_SECRET)

# 3. Mongo
# asegurar que MONGO_URI apunta a una instancia accesible

# 4. Ejecutar
npm run dev    # con nodemon
npm start      # producción
```

El proceso falla en boot si faltan variables o los secretos son menores a 32 caracteres.

---

## Endpoints principales

| Módulo | Endpoints clave |
|---|---|
| `/api/auth` | register, login, logout, refresh, verify-email, forgot-password, reset-password, me, change-password |
| `/api/products` | list (paginado), search, byVendor, byCategory, recommended, CRUD (vendor/admin) |
| `/api/categories` | list (público), CRUD (admin) |
| `/api/cart` | get, addItem, updateItem, removeItem, clear — usa pricing tiered correcto |
| `/api/orders` | from-cart, from-custom-box, me, :id, guest/:id, :id/cancel, :id/retry-payment |
| `/api/payments` | webpay/create, webpay/commit, webpay/return |
| `/api/shipping` | quote, apply (recalcula server-side, ownership validada) |
| `/api/coupons` | validate (retorna solo `{valid, discount_preview}`), admin CRUD |
| `/api/refunds` | request, list, approve (admin), reject (admin) |
| `/api/uploads` | image, images, :key (delete) |
| `/api/addresses` | CRUD + set-default |
| `/api/tracking` | orders/:id (público con token), webhooks/blueexpress |
| `/api/tax-documents` | emit, me, :id, void — stub SII listo para integrar |
| `/api/guest` | id — emite `guest_id` firmado |
| `/api/favorites`, `/api/reviews`, `/api/notifications`, `/api/pantry`, `/api/custom-box` | flujos del v1 migrados |
| `/api/admin` | dashboard, orders, users, exportCSV |
| `/api/vendor/dashboard` | stats, revenue, products, orders |

---

## Convenciones de código

**Response uniforme:**
```json
{ "success": true, "data": {...}, "message": "..." }
{ "success": false, "code": "NOT_FOUND", "message": "...", "details": [...] }
```

**Errores:** lanzar `throw new BadRequestError("...")` etc. El `errorHandler` global los formatea.

**Validación:** cada ruta usa `validate({ body, query, params })` con schemas Zod antes del controller.

**Transacciones:** usar `withTransaction(async (session) => {...})` para flujos multi-documento.

**Ownership guest:** usar helpers `getRequestIdentity`, `getOwnerFilter`, `assertOwner`. Jamás confiar en `req.headers["x-guest-id"]` sin pasar por `verifyGuestId`.

**Logging:** siempre `logger.info/warn/error` con objeto estructurado. Nunca `console.log`.

**Lean:** todas las lecturas con `.lean()` salvo que se vaya a mutar.

**ESM:** todos los imports con extensión `.js`.

---

## Infraestructura todavía pendiente (backlog)

- Tests de integración (Jest o node:test) — cero cobertura actualmente
- Dockerfile + docker-compose.yml
- CI/CD (GitHub Actions)
- ESLint + Prettier + Husky pre-commit
- Integración real SII (hoy es stub funcional pero no emite documentos reales)
- Job de carrito abandonado (cron que recorre `Cart.status=active` > 3 días)
- Conciliación diaria Transbank
- Sentry / observabilidad

Estos puntos NO bloquean el lanzamiento — el backend funciona end-to-end tal como está.

---

## Smoke test

```bash
# con el server corriendo en :3000
curl http://localhost:3000/health
curl http://localhost:3000/ready
curl http://localhost:3000/api/products
```

Validación de arranque automática: `node server.js` cortará con mensaje claro si faltan variables de entorno o si los secretos son demasiado cortos.
"# cibox_backend_v2" 
