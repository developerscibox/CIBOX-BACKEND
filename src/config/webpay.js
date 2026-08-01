import pkg from "transbank-sdk";
import { env } from "./env.js";

const {
  Options,
  IntegrationApiKeys,
  IntegrationCommerceCodes,
  Environment,
  WebpayPlus,
} = pkg;

const isProdWebpay = env.WEBPAY_ENV === "production";

if (isProdWebpay && env.isProd && (!env.WEBPAY_COMMERCE_CODE || !env.WEBPAY_API_KEY)) {
  throw new Error("Webpay en producción requiere WEBPAY_COMMERCE_CODE y WEBPAY_API_KEY");
}




export const webpayOptions = new Options(
  isProdWebpay ? env.WEBPAY_COMMERCE_CODE : IntegrationCommerceCodes.WEBPAY_PLUS,
  isProdWebpay ? env.WEBPAY_API_KEY : IntegrationApiKeys.WEBPAY,
  isProdWebpay ? Environment.Production : Environment.Integration
);

export const getTransaction = () => new WebpayPlus.Transaction(webpayOptions);

export const webpayReturnUrl = env.WEBPAY_RETURN_URL;