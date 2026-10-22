import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/tokens.css";
import "./styles/global.css";

const siteUrl = (import.meta.env.VITE_SITE_URL?.trim().replace(/\/+$/, "") || "https://kettigo.xyz");
document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.setAttribute("href", siteUrl);
document.querySelector<HTMLMetaElement>('meta[property="og:url"]')?.setAttribute("content", siteUrl);
document.querySelector<HTMLMetaElement>('meta[property="og:image"]')?.setAttribute("content", `${siteUrl}/og-image.png`);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
