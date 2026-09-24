// desktop-boot 必须最先 import:业务模块在模块初始化时读取 __QH_* 全局
import "./desktop-boot"
import "./app/globals.css"
import ReactDOM from "react-dom/client"
import App from "./App"

ReactDOM.createRoot(document.getElementById("root")!).render(<App />)
