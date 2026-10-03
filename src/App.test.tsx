import { renderToString } from "react-dom/server";
import { expect, test } from "vite-plus/test";
import App from "./App.tsx";

test("renders the app name", () => {
  expect(renderToString(<App />)).toContain("Coanda");
});
