import path from "node:path";
import express from "express";
import { env } from "../config/env.js";

const dir = path.resolve(process.cwd(), env.UPLOAD_DISK_PATH);

export const staticUploads = express.static(dir, {
  fallthrough: true,
  maxAge: "7d",
  setHeaders: (res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
  },
});

export default staticUploads;
