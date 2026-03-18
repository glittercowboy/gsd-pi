"use client";

import { useEffect } from "react";

export function SwRegister() {
  useEffect(() => {
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
      navigator.serviceWorker
        .register("/sw.js")
        .then((reg) => {
          console.log("[GSD] Service worker registered:", reg.scope);
        })
        .catch((err) => {
          console.error("[GSD] Service worker registration failed:", err);
        });
    }
  }, []);

  return null;
}
