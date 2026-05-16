import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { v4 as uuidv4 } from "uuid";
import JSZip from "jszip";
import ffmpeg from "fluent-ffmpeg";

function findBin(name: string): string {
  // 1. Try which
  try {
    const p = execSync(`which ${name} 2>/dev/null`, { timeout: 3000 }).toString().trim();
    if (p && fs.existsSync(p)) return p;
  } catch {}
  // 2. Scan common nix store location
  try {
    const p = execSync(
      `ls /nix/store/*/bin/${name} 2>/dev/null | head -1`,
      { shell: true, timeout: 3000 }
    ).toString().trim().split("\n")[0];
    if (p && fs.existsSync(p)) return p;
  } catch {}
  // 3. Runtime path hint
  const hint = `/nix/store/y7m7h744qpw8hidkkxnhx7wzgv59w287-replit-runtime-path/bin/${name}`;
  if (fs.existsSync(hint)) return hint;
  return name;
}

const FFMPEG_PATH = findBin("ffmpeg");
const FFPROBE_PATH = findBin("ffprobe");
const MAGICK_PATH = findBin("magick");

console.log(`[tools] ffmpeg=${FFMPEG_PATH} ffprobe=${FFPROBE_PATH} magick=${MAGICK_PATH}`);

ffmpeg.setFfmpegPath(FFMPEG_PATH);
ffmpeg.setFfprobePath(FFPROBE_PATH);

const router = Router();

const UPLOAD_DIR = path.join(process.cwd(), "uploads");
const EXPORTS_DIR = path.join(process.cwd(), "exports");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(EXPORTS_DIR, { recursive: true });

interface SlideData {
  index: number;
  hasAudio: boolean;
  audioDurationSeconds: number | null;
  audioPath: string | null;
  imagePath: string | null;
  extractedImagePath: string | null;
}

interface PresentationData {
  id: string;
  filename: string;
  slideCount: number;
  slides: SlideData[];
  createdAt: string;
  pptxPath: string;
  exportStatus: string | null;
  exportPath: string | null;
}

interface ExportJobData {
  presentationId: string;
  status: "pending" | "processing" | "done" | "error";
  progress: number | null;
  downloadUrl: string | null;
  error: string | null;
}

const presentations = new Map<string, PresentationData>();
const exportJobs = new Map<string, ExportJobData>();

const pptxStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOAD_DIR, "pptx");
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, `${uuidv4()}-${file.originalname}`);
  },
});

const audioStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const { id } = req.params;
    const dir = path.join(UPLOAD_DIR, "audio", id);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const { slideIndex } = req.params;
    cb(null, `slide-${slideIndex}.webm`);
  },
});

const imageStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const { id } = req.params;
    const dir = path.join(UPLOAD_DIR, "images", id);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const { slideIndex } = req.params;
    cb(null, `slide-${slideIndex}.png`);
  },
});

const uploadPptx = multer({ storage: pptxStorage });
const uploadAudio = multer({ storage: audioStorage });
const uploadImage = multer({ storage: imageStorage });

async function getPptxSlideCount(filePath: string): Promise<number> {
  const data = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(data);
  const slideFiles = Object.keys(zip.files).filter((name) =>
    name.match(/^ppt\/slides\/slide\d+\.xml$/)
  );
  return slideFiles.length;
}

/**
 * Extract the first image from each slide in the PPTX and save to disk.
 * Returns an array indexed by slide order (0-based) with the image path or null.
 */
async function extractSlideImages(
  pptxPath: string,
  presentationId: string
): Promise<(string | null)[]> {
  const data = fs.readFileSync(pptxPath);
  const zip = await JSZip.loadAsync(data);

  const slideFiles = Object.keys(zip.files)
    .filter((name) => name.match(/^ppt\/slides\/slide\d+\.xml$/))
    .sort((a, b) => {
      const numA = parseInt(a.match(/slide(\d+)\.xml$/)?.[1] || "0");
      const numB = parseInt(b.match(/slide(\d+)\.xml$/)?.[1] || "0");
      return numA - numB;
    });

  const imageDir = path.join(UPLOAD_DIR, "images", presentationId);
  fs.mkdirSync(imageDir, { recursive: true });

  const results: (string | null)[] = [];

  for (let i = 0; i < slideFiles.length; i++) {
    const slideFile = slideFiles[i];
    const slideNum = parseInt(slideFile.match(/slide(\d+)\.xml$/)?.[1] || "0");
    const relsPath = `ppt/slides/_rels/slide${slideNum}.xml.rels`;
    const relsFile = zip.files[relsPath];

    if (!relsFile) {
      results.push(null);
      continue;
    }

    const relsContent = await relsFile.async("string");

    // Find image relationship targets
    const imageRelRegex =
      /Type="[^"]*\/image"[^>]*Target="([^"]+)"|Target="([^"]+)"[^>]*Type="[^"]*\/image"/g;
    let match: RegExpExecArray | null;
    let foundPath: string | null = null;

    while ((match = imageRelRegex.exec(relsContent)) !== null) {
      const target = match[1] || match[2];
      const mediaPath = target.startsWith("../")
        ? "ppt/" + target.slice(3)
        : target;
      const mediaFile = zip.files[mediaPath];
      if (mediaFile) {
        const ext = path.extname(mediaPath).toLowerCase();
        if ([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"].includes(ext)) {
          const outputPath = path.join(imageDir, `slide-${i}-extracted${ext}`);
          const imageData = await mediaFile.async("nodebuffer");
          fs.writeFileSync(outputPath, imageData);
          foundPath = outputPath;
          break;
        }
      }
    }

    results.push(foundPath);
  }

  return results;
}

/** Generate a placeholder image using ImageMagick for a slide with no image. */
function generatePlaceholderImage(slideIndex: number, outputPath: string): void {
  const label = `Slide ${slideIndex + 1}`;
  try {
    execSync(
      `${MAGICK_PATH} -size 1280x720 gradient:#1a1a2e-#16213e -fill "#ffffff" -font DejaVu-Sans-Bold -pointsize 80 -gravity center -annotate 0 "${label}" "${outputPath}"`,
      { stdio: "pipe" }
    );
  } catch {
    // Fallback: simpler command without font specification
    execSync(
      `${MAGICK_PATH} -size 1280x720 xc:"#1a1a2e" -fill "#ffffff" -pointsize 80 -gravity center -annotate 0 "${label}" "${outputPath}"`,
      { stdio: "pipe" }
    );
  }
}

function formatSlide(slide: SlideData, presentationId: string) {
  let imageUrl: string | null = null;
  if (slide.imagePath) {
    imageUrl = `/api/presentations/${presentationId}/slides/${slide.index}/image`;
  } else if (slide.extractedImagePath) {
    imageUrl = `/api/presentations/${presentationId}/slides/${slide.index}/extracted-image`;
  }
  return {
    index: slide.index,
    hasAudio: slide.hasAudio,
    audioDurationSeconds: slide.audioDurationSeconds,
    imageUrl,
  };
}

function formatPresentation(p: PresentationData) {
  return {
    id: p.id,
    filename: p.filename,
    slideCount: p.slideCount,
    slides: p.slides.map((s) => formatSlide(s, p.id)),
    createdAt: p.createdAt,
    exportStatus: p.exportStatus,
  };
}

// POST /api/upload
router.post("/upload", uploadPptx.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }
  try {
    const slideCount = await getPptxSlideCount(req.file.path);
    const id = uuidv4();

    // Extract images from PPTX (best-effort)
    let extractedImages: (string | null)[] = [];
    try {
      extractedImages = await extractSlideImages(req.file.path, id);
    } catch (e) {
      console.error("Image extraction failed:", e);
    }

    const slides: SlideData[] = Array.from({ length: slideCount }, (_, i) => ({
      index: i,
      hasAudio: false,
      audioDurationSeconds: null,
      audioPath: null,
      imagePath: null,
      extractedImagePath: extractedImages[i] || null,
    }));

    const pres: PresentationData = {
      id,
      filename: req.file.originalname,
      slideCount,
      slides,
      createdAt: new Date().toISOString(),
      pptxPath: req.file.path,
      exportStatus: null,
      exportPath: null,
    };
    presentations.set(id, pres);
    return res.json(formatPresentation(pres));
  } catch (err) {
    console.error("Failed to parse PPTX:", err);
    return res
      .status(400)
      .json({ error: "Failed to parse PPTX file. Make sure it is a valid .pptx file." });
  }
});

// GET /api/presentations/:id/file
router.get("/presentations/:id/file", (req, res) => {
  const pres = presentations.get(req.params.id);
  if (!pres) return res.status(404).json({ error: "Presentation not found" });
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  );
  res.setHeader("Content-Disposition", `inline; filename="${pres.filename}"`);
  return res.sendFile(pres.pptxPath);
});

// GET /api/presentations/:id/slides/:slideIndex/image (browser-captured)
router.get("/presentations/:id/slides/:slideIndex/image", (req, res) => {
  const pres = presentations.get(req.params.id);
  if (!pres) return res.status(404).json({ error: "Presentation not found" });
  const slideIndex = parseInt(req.params.slideIndex);
  const slide = pres.slides[slideIndex];
  if (!slide || !slide.imagePath || !fs.existsSync(slide.imagePath)) {
    return res.status(404).json({ error: "Slide image not found" });
  }
  res.setHeader("Content-Type", "image/png");
  return res.sendFile(slide.imagePath);
});

// GET /api/presentations/:id/slides/:slideIndex/extracted-image (from PPTX)
router.get("/presentations/:id/slides/:slideIndex/extracted-image", (req, res) => {
  const pres = presentations.get(req.params.id);
  if (!pres) return res.status(404).json({ error: "Presentation not found" });
  const slideIndex = parseInt(req.params.slideIndex);
  const slide = pres.slides[slideIndex];
  if (!slide || !slide.extractedImagePath || !fs.existsSync(slide.extractedImagePath)) {
    return res.status(404).json({ error: "Extracted image not found" });
  }
  const ext = path.extname(slide.extractedImagePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
  };
  res.setHeader("Content-Type", mimeMap[ext] || "image/png");
  return res.sendFile(slide.extractedImagePath);
});

// GET /api/presentations
router.get("/presentations", (req, res) => {
  const list = Array.from(presentations.values()).map(formatPresentation);
  return res.json(list);
});

// GET /api/presentations/:id
router.get("/presentations/:id", (req, res) => {
  const pres = presentations.get(req.params.id);
  if (!pres) return res.status(404).json({ error: "Presentation not found" });
  return res.json(formatPresentation(pres));
});

// DELETE /api/presentations/:id
router.delete("/presentations/:id", (req, res) => {
  const pres = presentations.get(req.params.id);
  if (!pres) return res.status(404).json({ error: "Presentation not found" });
  try {
    if (fs.existsSync(pres.pptxPath)) fs.unlinkSync(pres.pptxPath);
    const audioDir = path.join(UPLOAD_DIR, "audio", pres.id);
    if (fs.existsSync(audioDir)) fs.rmSync(audioDir, { recursive: true });
    const imageDir = path.join(UPLOAD_DIR, "images", pres.id);
    if (fs.existsSync(imageDir)) fs.rmSync(imageDir, { recursive: true });
    if (pres.exportPath && fs.existsSync(pres.exportPath))
      fs.unlinkSync(pres.exportPath);
  } catch {}
  presentations.delete(req.params.id);
  exportJobs.delete(req.params.id);
  return res.status(204).send();
});

// POST /api/presentations/:id/slides/:slideIndex/audio
router.post(
  "/presentations/:id/slides/:slideIndex/audio",
  uploadAudio.single("audio"),
  async (req, res) => {
    const pres = presentations.get(req.params.id);
    if (!pres) return res.status(404).json({ error: "Presentation not found" });
    const slideIndex = parseInt(req.params.slideIndex);
    const slide = pres.slides[slideIndex];
    if (!slide) return res.status(404).json({ error: "Slide not found" });
    if (!req.file) return res.status(400).json({ error: "No audio file uploaded" });

    let duration: number | null = null;
    try {
      await new Promise<void>((resolve) => {
        ffmpeg.ffprobe(req.file!.path, (err, metadata) => {
          if (!err && metadata?.format?.duration) {
            duration = metadata.format.duration;
          }
          resolve();
        });
      });
    } catch {}

    slide.audioPath = req.file.path;
    slide.hasAudio = true;
    slide.audioDurationSeconds = duration;

    return res.json(formatSlide(slide, pres.id));
  }
);

// DELETE /api/presentations/:id/slides/:slideIndex/audio
router.delete("/presentations/:id/slides/:slideIndex/audio", (req, res) => {
  const pres = presentations.get(req.params.id);
  if (!pres) return res.status(404).json({ error: "Presentation not found" });
  const slideIndex = parseInt(req.params.slideIndex);
  const slide = pres.slides[slideIndex];
  if (!slide) return res.status(404).json({ error: "Slide not found" });
  if (slide.audioPath && fs.existsSync(slide.audioPath)) {
    fs.unlinkSync(slide.audioPath);
  }
  slide.audioPath = null;
  slide.hasAudio = false;
  slide.audioDurationSeconds = null;
  return res.json(formatSlide(slide, pres.id));
});

// POST /api/presentations/:id/slides/:slideIndex/image (browser canvas capture)
router.post(
  "/presentations/:id/slides/:slideIndex/image",
  uploadImage.single("image"),
  (req, res) => {
    const pres = presentations.get(req.params.id);
    if (!pres) return res.status(404).json({ error: "Presentation not found" });
    const slideIndex = parseInt(req.params.slideIndex);
    const slide = pres.slides[slideIndex];
    if (!slide) return res.status(404).json({ error: "Slide not found" });
    if (!req.file) return res.status(400).json({ error: "No image uploaded" });
    slide.imagePath = req.file.path;
    return res.json(formatSlide(slide, pres.id));
  }
);

// GET /api/presentations/:id/export
router.get("/presentations/:id/export", (req, res) => {
  const pres = presentations.get(req.params.id);
  if (!pres) return res.status(404).json({ error: "Presentation not found" });
  const job = exportJobs.get(req.params.id);
  if (!job) {
    return res.json({
      presentationId: req.params.id,
      status: "pending",
      progress: null,
      downloadUrl: null,
      error: null,
    });
  }
  return res.json(job);
});

// POST /api/presentations/:id/export
router.post("/presentations/:id/export", async (req, res) => {
  const pres = presentations.get(req.params.id);
  if (!pres) return res.status(404).json({ error: "Presentation not found" });

  const slidesWithAudio = pres.slides.filter((s) => s.hasAudio && s.audioPath);
  if (slidesWithAudio.length === 0) {
    return res
      .status(400)
      .json({ error: "No slides have audio. Record voiceovers first." });
  }

  const job: ExportJobData = {
    presentationId: pres.id,
    status: "processing",
    progress: 0,
    downloadUrl: null,
    error: null,
  };
  exportJobs.set(pres.id, job);
  pres.exportStatus = "processing";

  runExport(pres, job).catch((err) => {
    job.status = "error";
    job.error = String(err);
    pres.exportStatus = "error";
  });

  return res.json(job);
});

async function resolveSlideImagePath(
  slide: SlideData,
  exportDir: string
): Promise<string> {
  // 1. Prefer browser-captured image
  if (slide.imagePath && fs.existsSync(slide.imagePath)) {
    return slide.imagePath;
  }
  // 2. Use extracted PPTX image
  if (slide.extractedImagePath && fs.existsSync(slide.extractedImagePath)) {
    return slide.extractedImagePath;
  }
  // 3. Generate placeholder with ImageMagick
  const placeholderPath = path.join(exportDir, `placeholder-${slide.index}.png`);
  generatePlaceholderImage(slide.index, placeholderPath);
  return placeholderPath;
}

async function runExport(pres: PresentationData, job: ExportJobData) {
  const exportId = uuidv4();
  const exportDir = path.join(EXPORTS_DIR, exportId);
  fs.mkdirSync(exportDir, { recursive: true });

  const slidesWithAudio = pres.slides.filter((s) => s.hasAudio && s.audioPath);
  const segmentPaths: string[] = [];

  for (let i = 0; i < slidesWithAudio.length; i++) {
    const slide = slidesWithAudio[i];
    const segmentPath = path.join(exportDir, `segment-${i}.mp4`);

    const imagePath = await resolveSlideImagePath(slide, exportDir);
    const duration = slide.audioDurationSeconds || 5;

    await new Promise<void>((resolve, reject) => {
      ffmpeg()
        .input(imagePath)
        .inputOptions(["-loop 1"])
        .input(slide.audioPath!)
        .videoCodec("libx264")
        .audioCodec("aac")
        .outputOptions([
          "-pix_fmt yuv420p",
          `-t ${duration}`,
          "-vf scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=#1a1a2e",
          "-tune stillimage",
          "-crf 23",
          "-preset fast",
        ])
        .output(segmentPath)
        .on("end", () => resolve())
        .on("error", reject)
        .run();
    });

    segmentPaths.push(segmentPath);
    job.progress = Math.round(((i + 1) / slidesWithAudio.length) * 80);
  }

  const concatListPath = path.join(exportDir, "concat.txt");
  fs.writeFileSync(
    concatListPath,
    segmentPaths.map((p) => `file '${p}'`).join("\n")
  );

  const outputPath = path.join(EXPORTS_DIR, `${pres.id}.mp4`);

  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(concatListPath)
      .inputOptions(["-f concat", "-safe 0"])
      .outputOptions(["-c copy"])
      .output(outputPath)
      .on("end", () => resolve())
      .on("error", reject)
      .run();
  });

  fs.rmSync(exportDir, { recursive: true, force: true });

  pres.exportPath = outputPath;
  pres.exportStatus = "done";
  job.status = "done";
  job.progress = 100;
  job.downloadUrl = `/api/presentations/${pres.id}/export/download`;
}

// GET /api/presentations/:id/export/download
router.get("/presentations/:id/export/download", (req, res) => {
  const pres = presentations.get(req.params.id);
  if (!pres) return res.status(404).json({ error: "Presentation not found" });
  if (!pres.exportPath || !fs.existsSync(pres.exportPath)) {
    return res.status(404).json({ error: "Export not found or not ready yet" });
  }
  const filename = pres.filename.replace(/\.pptx$/i, "") + ".mp4";
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  return res.sendFile(pres.exportPath);
});

export default router;
