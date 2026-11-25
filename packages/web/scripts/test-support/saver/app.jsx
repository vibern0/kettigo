import "@/app/globals.css";
import { createRoot } from "react-dom/client";
import SavingsPage from "@/app/savings/page";
import DrawPage from "@/app/draw/page";
import { Header } from "@/components/Header";
import { Providers } from "@/app/providers";

createRoot(document.getElementById("root")).render(
  <Providers>
    <Header />
    {location.pathname === "/draw" ? <DrawPage /> : <SavingsPage />}
  </Providers>,
);
