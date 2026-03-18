import "@fontsource/share-tech-mono/400.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import { createRoot } from "react-dom/client";
import App from "./App";
import { initWindowIdentity } from "./window-identity";

initWindowIdentity().then(() => {
  const root = createRoot(document.getElementById("root")!);
  root.render(<App />);
});
