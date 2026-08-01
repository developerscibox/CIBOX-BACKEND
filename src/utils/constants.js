export const ORDER_STATUS = {
  PENDING: "pending",
  PAID: "paid",
  PREPARING: "preparing",
  READY: "ready",        // preparado: picking terminado, listo para despacho
  SHIPPED: "shipped",    // en ruta
  DELIVERED: "delivered",
  CANCELLED: "cancelled",
  REFUNDED: "refunded",
};

export const PAID_STATUSES = [
  ORDER_STATUS.PAID,
  ORDER_STATUS.PREPARING,
  ORDER_STATUS.READY,
  ORDER_STATUS.SHIPPED,
  ORDER_STATUS.DELIVERED,
];

export const VALID_TRANSITIONS = {
  [ORDER_STATUS.PENDING]: [ORDER_STATUS.PAID, ORDER_STATUS.CANCELLED],
  [ORDER_STATUS.PAID]: [ORDER_STATUS.PREPARING, ORDER_STATUS.CANCELLED, ORDER_STATUS.REFUNDED],
  // "shipped" se mantiene alcanzable desde "preparing" por compatibilidad con
  // órdenes/flujos antiguos; el flujo nuevo es preparing → ready → shipped
  [ORDER_STATUS.PREPARING]: [ORDER_STATUS.READY, ORDER_STATUS.SHIPPED, ORDER_STATUS.CANCELLED],
  // DELIVERED alcanzable desde READY para retiro en bodega: el cliente retira
  // directamente desde "listo" (sin pasar por "shipped"/en ruta).
  [ORDER_STATUS.READY]: [ORDER_STATUS.SHIPPED, ORDER_STATUS.DELIVERED, ORDER_STATUS.CANCELLED],
  [ORDER_STATUS.SHIPPED]: [ORDER_STATUS.DELIVERED],
  [ORDER_STATUS.DELIVERED]: [ORDER_STATUS.REFUNDED],
  [ORDER_STATUS.CANCELLED]: [],
  [ORDER_STATUS.REFUNDED]: [],
};

export const PAYMENT_STATUS = {
  PENDING: "pending",
  PROCESSING: "processing",
  PROCESSING_COMMIT: "processing_commit",
  APPROVED: "approved",
  REJECTED: "rejected",
  REFUNDED: "refunded",
};

/**
 * Tipos de movimiento de inventario (kardex).
 * Convención de signo en StockMovement.quantity:
 *   negativo = salida de bodega, positivo = entrada/reposición.
 */
export const MOVEMENT_TYPES = {
  SALE: "venta",            // descuento por orden creada
  CANCELLATION: "anulacion", // reposición por cancelación
  EXPIRY: "expiracion",     // reposición por orden pendiente expirada
  REFUND: "reembolso",      // reposición por reembolso aprobado
  ADJUSTMENT: "ajuste",     // ajuste manual (merma, conteo, corrección)
  RECEIVING: "recepcion",   // entrada de mercadería
};

export const ROLES = {
  CUSTOMER: "customer",
  VENDOR: "vendor",     // legado: vendedor del marketplace (entidad Vendor).
  ADMIN: "admin",
  // Roles operativos del panel de Cibox (100% online: nadie atiende público).
  MANAGER: "manager",   // Gerente / dueño: ve todo, aprueba, reportes (acceso total).
  OPERATOR: "operator", // Operaciones: recepción, inventario y preparación de pedidos.
};

// Roles con acceso al panel de operaciones.
export const WMS_ROLES = [
  ROLES.ADMIN,
  ROLES.MANAGER,
  ROLES.OPERATOR,
];

/**
 * Permisos atómicos. La autorización fina se hace por PERMISO, no por rol
 * entero, para poder combinar capacidades sin crear un rol por cada excepción.
 */
export const PERMISSIONS = {
  ORDERS_READ: "orders.read",         // ver pedidos / dashboard de operaciones
  ORDERS_PAY: "orders.pay",           // confirmar el pago de un pedido (pending→paid)
  ORDERS_PREPARE: "orders.prepare",   // paid→preparing, preparing→ready (preparación)
  ORDERS_DELIVER: "orders.deliver",   // ready→shipped→delivered (despacho y entrega)
  ORDERS_CANCEL: "orders.cancel",     // cancelar pedido
  INVENTORY_READ: "inventory.read",   // kardex, low-stock, by-barcode
  INVENTORY_ADJUST: "inventory.adjust", // ajuste de stock con motivo
  PRODUCTS_MANAGE: "products.manage", // alta/edición de productos del catálogo
  REPORTS_READ: "reports.read",       // métricas / exportaciones
  USERS_MANAGE: "users.manage",       // alta/baja/rol de usuarios
};

const ALL_PERMISSIONS = Object.values(PERMISSIONS);

/**
 * Mapa rol → permisos por defecto (principio de mínimo privilegio).
 * admin = superusuario (todos). El gerente ve y aprueba todo el día a día;
 * operaciones prepara, despacha y mueve inventario.
 */
export const ROLE_PERMISSIONS = {
  [ROLES.ADMIN]: ALL_PERMISSIONS,
  [ROLES.MANAGER]: [
    PERMISSIONS.ORDERS_READ,
    PERMISSIONS.ORDERS_PAY,
    PERMISSIONS.ORDERS_PREPARE,
    PERMISSIONS.ORDERS_DELIVER,
    PERMISSIONS.ORDERS_CANCEL,
    PERMISSIONS.INVENTORY_READ,
    PERMISSIONS.INVENTORY_ADJUST,
    PERMISSIONS.PRODUCTS_MANAGE,
    PERMISSIONS.REPORTS_READ,
    PERMISSIONS.USERS_MANAGE,
  ],
  // Operaciones: prepara (paid→preparing→ready), despacha (→shipped/delivered)
  // y mueve inventario (recepción/ajuste).
  [ROLES.OPERATOR]: [
    PERMISSIONS.ORDERS_READ,
    PERMISSIONS.ORDERS_PREPARE,
    PERMISSIONS.ORDERS_DELIVER,
    PERMISSIONS.INVENTORY_READ,
    PERMISSIONS.INVENTORY_ADJUST,
  ],
  [ROLES.VENDOR]: [],
  [ROLES.CUSTOMER]: [],
};

export const permissionsForRole = (role) => ROLE_PERMISSIONS[role] || [];

export const roleHasPermission = (role, permission) =>
  role === ROLES.ADMIN || permissionsForRole(role).includes(permission);

/**
 * Matriz explícita estado-destino → permiso requerido para la transición. Un rol
 * puede llevar un pedido a `toStatus` solo si tiene el permiso mapeado aquí.
 */
export const TRANSITION_PERMISSION = {
  [ORDER_STATUS.PAID]: PERMISSIONS.ORDERS_PAY,
  [ORDER_STATUS.PREPARING]: PERMISSIONS.ORDERS_PREPARE,
  [ORDER_STATUS.READY]: PERMISSIONS.ORDERS_PREPARE,
  [ORDER_STATUS.SHIPPED]: PERMISSIONS.ORDERS_DELIVER,
  [ORDER_STATUS.DELIVERED]: PERMISSIONS.ORDERS_DELIVER,
  [ORDER_STATUS.CANCELLED]: PERMISSIONS.ORDERS_CANCEL,
  [ORDER_STATUS.REFUNDED]: PERMISSIONS.ORDERS_CANCEL,
};

export const canRoleTransition = (role, toStatus) => {
  const perm = TRANSITION_PERMISSION[toStatus];
  return perm ? roleHasPermission(role, perm) : false;
};

export const BCRYPT_ROUNDS = 12;
export const PASSWORD_MIN_LENGTH = 8;
