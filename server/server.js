import express from "express";
import cors from "cors";
import multer from "multer";
import crypto from "crypto";

const app = express();

// Permite CORS desde tu front (local o producción con ORIGIN env)
const allowedOrigin = process.env.ORIGIN || "http://localhost:5173";
app.use(cors({ origin: allowedOrigin }));

const upload = multer({
  storage: multer.memoryStorage(), // SOLO RAM
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype?.startsWith("image/") && !file.mimetype?.startsWith("video/")) {
      return cb(new Error("Solo imágenes o videos"));
    }
    cb(null, true);
  },
});

function token(bytes = 16) {
  return crypto.randomBytes(bytes).toString("hex");
}

// Solo 1 archivo activo
let current = null;
// current = { viewToken, deleteToken, mime, buffer, createdAt }

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/upload", upload.single("image"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No se recibió archivo" });

  const viewToken = token(18);
  const deleteToken = token(24);

  current = {
    viewToken,
    deleteToken,
    mime: req.file.mimetype,
    buffer: req.file.buffer,
    createdAt: new Date().toISOString(),
  };

  const base = `${req.protocol}://${req.get("host")}`;

  res.json({
    viewUrl: `${base}/i/${viewToken}`,
    deleteUrl: `${base}/delete/${deleteToken}`,
  });
});

// Página para ver
app.get("/i/:t", (req, res) => {
  if (!current || req.params.t !== current.viewToken) {
    return res.status(404).send("Archivo no encontrado.");
  }

  const isVideo = current.mime.startsWith("video/");
  const media = isVideo
    ? `<video id="media" controls controlslist="nodownload" playsinline preload="metadata" src="/raw/${current.viewToken}"></video>`
    : `<img id="media" src="/raw/${current.viewToken}" />`;

  res.type("html").send(`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Archivo</title>
<style>
body { margin:0; background:#0b0b0b; color:#fff; font-family:system-ui }
.wrap { min-height:100vh; display:grid; place-items:center; padding:24px }
.card { width:min(900px,96vw); background:#141414; border-radius:16px; padding:16px }
img, video { width:100%; height:auto; display:block; border-radius:12px }
.hidden { display:none }
.msg { text-align:center; opacity:.8 }
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    ${media}
    <div id="msg" class="msg hidden">
      Archivo eliminado o reemplazado.
    </div>
  </div>
</div>

<script>
  // Bloqueos UX
  document.addEventListener("contextmenu", e => e.preventDefault());
  document.addEventListener("dragstart", e => e.preventDefault());

  const media = document.getElementById("media");
  const msg = document.getElementById("msg");

  // 1️⃣ Polling: verifica si el archivo sigue existiendo
  async function check() {
    try {
      const r = await fetch("/raw/${current.viewToken}", { method: "HEAD", cache: "no-store" });
      if (!r.ok) throw new Error();
    } catch {
      media.classList.add("hidden");
      msg.classList.remove("hidden");
      clearInterval(timer);
    }
  }

  const timer = setInterval(check, 1200);

  // 2️⃣ BroadcastChannel: refresco inmediato al borrar
  const bc = new BroadcastChannel("uploader");
  bc.onmessage = (e) => {
    if (e.data?.type === "deleted" && e.data.token === "${current.viewToken}") {
      media.classList.add("hidden");
      msg.classList.remove("hidden");
      clearInterval(timer);
    }
  };
</script>
</body>
</html>`);
});

// Bytes del archivo (RAM)
app.get("/raw/:t", (req, res) => {
  if (!current || req.params.t !== current.viewToken) {
    return res.status(404).send("No encontrado");
  }
  res.setHeader("Content-Type", current.mime);
  res.setHeader("Content-Disposition", "inline");
  res.setHeader("Cache-Control", "no-store");
  res.send(current.buffer);
});

// Link para borrar (clic)
app.get("/delete/:dt", (req, res) => {
  if (!current) return res.status(404).send("No hay archivo activo.");
  if (req.params.dt !== current.deleteToken) {
    return res.status(403).send("No autorizado.");
  }

  const deletedToken = current.viewToken;
  current = null;

  res.type("html").send(`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8"/>
<title>Archivo borrado</title>
</head>
<body>
<h3>Archivo borrado ✅</h3>
<p>Puedes cerrar esta pestaña.</p>

<script>
  // Notifica a las pestañas abiertas del visor
  const bc = new BroadcastChannel("uploader");
  bc.postMessage({ type: "deleted", token: "${deletedToken}" });
</script>
</body>
</html>`);
});

// Render usa el puerto en process.env.PORT
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`API en http://localhost:${PORT}`));
