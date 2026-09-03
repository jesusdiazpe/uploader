import express from "express";
import cors from "cors";
import multer from "multer";
import crypto from "crypto";
import ffmpegPath from "ffmpeg-static";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const app = express();
const execFileAsync = promisify(execFile);
const MEBIBYTE = 1024 * 1024;
const MAX_UPLOAD_BYTES = 60 * MEBIBYTE;
const COMPRESSION_THRESHOLD_BYTES = 15 * MEBIBYTE;
const MAX_COMPRESSED_VIDEO_BYTES = 10 * MEBIBYTE;

// Permite CORS desde tu front (local o producción con ORIGIN env)
const allowedOrigin = process.env.ORIGIN || "http://localhost:5173";
app.use(cors({ origin: allowedOrigin }));

const upload = multer({
  storage: multer.memoryStorage(), // SOLO RAM
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype?.startsWith("image/") && !file.mimetype?.startsWith("video/")) {
      return cb(new Error("Solo imágenes o videos"));
    }
    cb(null, true);
  },
});

function durationInSeconds(output) {
  const match = output.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return null;

  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

async function getVideoDuration(inputPath) {
  try {
    const { stdout, stderr } = await execFileAsync(ffmpegPath, ["-i", inputPath, "-f", "null", "-"], {
      windowsHide: true,
    });
    const duration = durationInSeconds(`${stdout}\n${stderr}`);
    if (duration && Number.isFinite(duration)) return duration;
  } catch (error) {
    const duration = durationInSeconds(`${error.stdout || ""}\n${error.stderr || ""}`);
    if (duration && Number.isFinite(duration)) return duration;
  }

  throw new Error("No se pudo leer la duración del video");
}

async function compressVideo(buffer) {
  const directory = await mkdtemp(join(tmpdir(), "uploader-"));
  const inputPath = join(directory, "input");
  const outputPath = join(directory, "output.mp4");

  try {
    await writeFile(inputPath, buffer, { mode: 0o600 });
    const duration = await getVideoDuration(inputPath);
    const audioBitrate = 96_000;
    let videoBitrate = Math.max(
      50_000,
      Math.floor(((MAX_COMPRESSED_VIDEO_BYTES * 0.9 * 8) / duration) - audioBitrate),
    );

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await execFileAsync(
        ffmpegPath,
        [
          "-y",
          "-i",
          inputPath,
          "-map",
          "0:v:0",
          "-map",
          "0:a?",
          "-c:v",
          "libx264",
          "-b:v",
          String(videoBitrate),
          "-c:a",
          "aac",
          "-b:a",
          String(audioBitrate),
          "-movflags",
          "+faststart",
          outputPath,
        ],
        { windowsHide: true },
      );

      const compressed = await readFile(outputPath);
      if (compressed.length <= MAX_COMPRESSED_VIDEO_BYTES) return compressed;
      videoBitrate = Math.floor(videoBitrate * 0.75);
    }

    throw new Error("No se pudo comprimir el video a 10 MB");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function token(bytes = 16) {
  return crypto.randomBytes(bytes).toString("hex");
}

// Solo 1 archivo activo
let current = null;
// current = { viewToken, deleteToken, mime, buffer, createdAt }

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/upload", upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No se recibió archivo" });

  let { buffer, mimetype } = req.file;
  if (mimetype.startsWith("video/") && buffer.length > COMPRESSION_THRESHOLD_BYTES) {
    try {
      buffer = await compressVideo(buffer);
      mimetype = "video/mp4";
    } catch {
      return res.status(422).json({ error: "No se pudo comprimir el video" });
    }
  }

  const viewToken = token(18);
  const deleteToken = token(24);

  current = {
    viewToken,
    deleteToken,
    mime: mimetype,
    buffer,
    createdAt: new Date().toISOString(),
  };

  const base = `${req.protocol}://${req.get("host")}`;

  res.json({
    viewUrl: `${base}/i/${viewToken}`,
    deleteUrl: `${base}/delete/${deleteToken}`,
  });
});

app.use((error, _req, res, next) => {
  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "El archivo no puede superar los 60 MB" });
  }
  next(error);
});

// Página para ver
app.get("/i/:t", (req, res) => {
  if (!current || req.params.t !== current.viewToken) {
    return res.status(404).send("Archivo no encontrado.");
  }

  const isVideo = current.mime.startsWith("video/");
  const media = isVideo
    ? `<video id="media" controls controlslist="nodownload" playsinline preload="metadata" muted src="/raw/${current.viewToken}"></video>`
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

  // Mantiene el audio desactivado incluso si se intenta usar el control de volumen.
  if (media.tagName === "VIDEO") {
    const enforceMute = () => {
      media.defaultMuted = true;
      media.muted = true;
      media.volume = 0;
    };
    media.addEventListener("volumechange", enforceMute);
    enforceMute();
  }

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
