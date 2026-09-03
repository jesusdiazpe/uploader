import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { spawn } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";

const ffprobePath = ffprobeStatic.path;

const MB = 1024 * 1024;
// Los videos por encima de este tamaño se comprimen antes de guardarse.
export const COMPRESS_THRESHOLD_BYTES = 10 * MB;
// Meta de tamaño tras comprimir (margen de seguridad frente al límite real de 8MB).
export const TARGET_SIZE_BYTES = 7.5 * MB;
const MAX_WIDTH = 1280;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${path.basename(cmd)} falló (código ${code}): ${stderr.slice(-500)}`));
    });
  });
}

async function probe(filePath) {
  const out = await run(ffprobePath, [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]);
  const info = JSON.parse(out);
  const video = info.streams?.find((s) => s.codec_type === "video");
  if (!video) throw new Error("El archivo no contiene pista de video");
  const duration = parseFloat(info.format?.duration ?? video.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("No se pudo leer la duración del video");
  }
  const hasAudio = info.streams?.some((s) => s.codec_type === "audio") ?? false;
  return {
    duration,
    hasAudio,
    width: video.width || 0,
    height: video.height || 0,
  };
}

function videoBitrateKbps(targetBytes, duration, hasAudio) {
  const audioKbps = hasAudio ? 96 : 0;
  const totalKbps = (targetBytes * 8) / duration / 1000;
  return Math.max(100, Math.floor(totalKbps - audioKbps));
}

function scaleFilter(width, height) {
  if (!width || !height || width <= MAX_WIDTH) return null;
  return `scale=${MAX_WIDTH}:-2`;
}

async function encode(inputPath, outputPath, { duration, hasAudio, width, height }, targetBytes, crf) {
  const kbps = videoBitrateKbps(targetBytes, duration, hasAudio);
  const args = [
    "-y",
    "-i", inputPath,
    "-map", "0:v:0",
    ...(hasAudio ? ["-map", "0:a:0"] : []),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", String(crf),
    "-maxrate", `${kbps}k`,
    "-bufsize", `${kbps * 2}k`,
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
  ];
  const scale = scaleFilter(width, height);
  if (scale) args.push("-vf", scale);
  if (hasAudio) args.push("-c:a", "aac", "-b:a", "96k");
  args.push(outputPath);
  await run(ffmpegPath, args);
}

async function encodePass(inputPath, outputPath, meta, targetBytes, crf) {
  await encode(inputPath, outputPath, meta, targetBytes, crf);
  const stat = await fs.stat(outputPath);
  if (stat.size > targetBytes) {
    const adjusted = Math.floor(targetBytes * (targetBytes / stat.size));
    if (adjusted >= 0.5 * MB && adjusted < targetBytes) {
      await encode(inputPath, outputPath, meta, adjusted, crf);
    }
  }
}

/**
 * Comprime un video (H.264 + AAC en MP4) intentando dejarlo por debajo de
 * TARGET_SIZE_BYTES. Devuelve un Buffer con el MP4 resultante.
 */
export async function compressVideo(buffer) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "uploader-"));
  const inputPath = path.join(dir, "input");
  const outputPath = path.join(dir, "output.mp4");
  try {
    await fs.writeFile(inputPath, buffer);
    const meta = await probe(inputPath);

    let crf = 26;
    let lastSize = Infinity;
    for (let attempt = 0; attempt < 4; attempt++) {
      await encodePass(inputPath, outputPath, meta, TARGET_SIZE_BYTES, crf);
      lastSize = (await fs.stat(outputPath)).size;
      if (lastSize <= TARGET_SIZE_BYTES) break;
      crf += 4;
    }

    if (lastSize > TARGET_SIZE_BYTES) {
      throw new Error("No se pudo comprimir el video por debajo de 8 MB");
    }

    return await fs.readFile(outputPath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
