import "@/app/globals.css"
import { createRoot } from "react-dom/client"
import { BrowserRouter } from "react-router-dom"
import LoginPage from "@/app/(auth)/login/page"
Object.assign(window, { __TAURI_INTERNALS__: {} })
createRoot(document.getElementById("root")!).render(<BrowserRouter><LoginPage /></BrowserRouter>)
