import { labPortFromEnv } from "@ssda/shared";
import { createLabApp } from "./app";

const port = labPortFromEnv();
createLabApp().listen(port, "127.0.0.1", () => {
  console.log(`lab listening on http://127.0.0.1:${port}`);
});
