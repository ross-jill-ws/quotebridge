// Dashboard entry point: served by the app's HTTP server to the app window (or a browser, ADR 2).
import { render } from "preact";
import { App } from "./app.js";
import { applyRememberedTheme } from "./theme.js";

applyRememberedTheme();
render(<App />, document.getElementById("app")!);
