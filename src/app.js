import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";

import { env } from "./config/env.js";
import { brand } from "./config/brand.js";
import { logger } from "./utils/logger.js";
import { requestId } from "./middlewares/requestId.js";
import { globalLimiter } from "./middlewares/rateLimiters.js";
import { errorHandler, notFoundHandler } from "./middlewares/errorHandler.js";
import { staticUploads } from "./middlewares/staticUploads.js";

import authRoutes from "./routes/authRoutes.js";
import productRoutes from "./routes/productRoutes.js";
import orderRoutes from "./routes/orderRoutes.js";
import pricingRoutes from "./routes/pricingRoutes.js";
import customBoxRoutes from "./routes/customBoxRoutes.js";
import categoryRoutes from "./routes/categoryRoutes.js";
import vendorRoutes from "./routes/vendorRoutes.js";
import pantryRoutes from "./routes/pantryRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";
import couponRoutes from "./routes/couponRoutes.js";
import vendorDashboardRoutes from "./routes/vendorDashboardRoutes.js";
import favoriteRoutes from "./routes/favoriteRoutes.js";
import reviewRoutes from "./routes/reviewRoutes.js";
import notificationRoutes from "./routes/notificationRoutes.js";
import paymentRoutes from "./routes/paymentRoutes.js";
import shippingRoutes from "./routes/shippingRoutes.js";
import cartRoutes from "./routes/cartRoutes.js";
import refundRoutes from "./routes/refundRoutes.js";
import uploadRoutes from "./routes/uploadRoutes.js";
import addressRoutes from "./routes/addressRoutes.js";
import trackingRoutes from "./routes/trackingRoutes.js";
import guestRoutes from "./routes/guestRoutes.js";
import taxDocumentRoutes from "./routes/taxDocumentRoutes.js";
import missionRoutes from "./routes/missionRoutes.js";
import inventoryRoutes from "./routes/inventoryRoutes.js";
import cobranzaRoutes from "./routes/cobranzaRoutes.js";
import clientesRoutes from "./routes/clientesRoutes.js";
import reportRoutes from "./routes/reportRoutes.js";
import contentRoutes, { configRouter } from "./routes/contentRoutes.js";
import priceApprovalRoutes from "./routes/priceApprovalRoutes.js";

const app = express();
app.set("trust proxy", 1);
app.set("query parser", "simple");

app.use(helmet());
app.use(compression());
const corsAllowlist = (env.allowedOrigins && env.allowedOrigins.length > 0)
  ? env.allowedOrigins
  : ["http://localhost:8081", "http://localhost:5180", "http://localhost:5173"];
app.use(cors({
  origin: corsAllowlist,
  credentials: true,
}));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

app.use(requestId);
app.use((req, res, next) => {
  logger.debug({ req_id: req.id, method: req.method, url: req.originalUrl }, "incoming");
  next();
});

app.use(globalLimiter);

app.get("/", (req, res) => res.json({ name: `${brand.name} API`, version: "2.0.0", status: "ok" }));
app.get("/health", (req, res) => res.json({ status: "ok", time: new Date().toISOString() }));
app.get("/ready", (req, res) => res.json({ status: "ready" }));

app.use("/api/auth", authRoutes);
app.use("/api/products", productRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/pricing", pricingRoutes);
app.use("/api/custom-box", customBoxRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/vendors", vendorRoutes);
app.use("/api/pantry", pantryRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/coupons", couponRoutes);
app.use("/api/vendor/dashboard", vendorDashboardRoutes);
app.use("/api/favorites", favoriteRoutes);
app.use("/api/reviews", reviewRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/shipping", shippingRoutes);
app.use("/api/cart", cartRoutes);
app.use("/api/refunds", refundRoutes);
app.use("/api/uploads", uploadRoutes);
// Archivos subidos con el driver disk (dev / instalaciones sin Cloudinary):
// sirve /uploads/<key>. El middleware existía pero nunca se había montado.
app.use("/uploads", staticUploads);
app.use("/api/addresses", addressRoutes);
app.use("/api/tracking", trackingRoutes);
app.use("/api/guest", guestRoutes);
app.use("/api/tax-documents", taxDocumentRoutes);
app.use("/api/missions", missionRoutes);
app.use("/api/inventory", inventoryRoutes);
app.use("/api/cobranza", cobranzaRoutes);
app.use("/api/clientes", clientesRoutes);
app.use("/api/price-approvals", priceApprovalRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/content", contentRoutes);
app.use("/api/config", configRouter);

app.get("/success", (req, res) => {
  const orderId = String(req.query.orderId || "");
  return res.redirect(`${env.MOBILE_DEEP_LINK}orders/success?orderId=${encodeURIComponent(orderId)}`);
});


app.get("/failed", (req, res) => {
  const orderId = String(req.query.orderId || "");
  const status = String(req.query.status || "rejected");
  return res.redirect(
    `${env.MOBILE_DEEP_LINK}orders/failed?orderId=${encodeURIComponent(orderId)}&status=${encodeURIComponent(status)}`,
  );
});

app.use(notFoundHandler);
app.use(errorHandler);
export default app;
