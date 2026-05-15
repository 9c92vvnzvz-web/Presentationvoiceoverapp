import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import JSZip from "jszip";
import ffmpeg from "fluent-ffmpeg";

// Use system FFmpeg
const FFMPEG_PATH = "/nix/store/y7m7h744qpw8hidkkxnhx7wzgv59w287-replit-runtime-path/bin/ffmpeg";
if (fs.existsSync(FFMPEG_PATH)) {
  ffmpeg.setFfmpegPath(FFMPEG_PATH);
}

const router = Router();

// Storage directories
const UPLOAD_DIR = path.join(process.cwd(), "uploads");
const EXPORTS_DIR = path.join(process.cwd(), "exports");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(EXPORTS_DIR, { recursive: true });

// In-memory store for presentations
interface SlideData {
  index: number;
  hasAudio: boolean;
  audioDurationSeconds: number | null;
  audioPath: string | null;
  imagePath: string | null;
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

// Multer configs
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
    const { id, slideIndex } = req.params;
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
    const { id, slideIndex } = req.params;
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

// Parse PPTX to get slide count
async function getPptxSlideCount(filePath: string): Promise<number> {
  const data = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(data);
  const slideFiles = Object.keys(zip.files).filter(
    (name) => name.match(/^ppt\/slides\/slide\d+\.xml$/)
  );
  return slideFiles.length;
}

// Helper to format slide data for API response
function formatSlide(slide: SlideData, presentationId: string) {
  return {
    index: slide.index,
    hasAudio: slide.hasAudio,
    audioDurationSeconds: slide.audioDurationSeconds,
    imageUrl: slide.imagePath
      ? `/api/presentations/${presentationId}/slides/${slide.index}/image`
      : null,
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

// POST /api/upload — upload a PPTX file
router.post("/upload", uploadPptx.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }
  try {
    const slideCount = await getPptxSlideCount(req.file.path);
    const id = uuidv4();
    const slides: SlideData[] = Array.from({ length: slideCount }, (_, i) => ({
      index: i,
      hasAudio: false,
      audioDurationSeconds: null,
      audioPath: null,
      imagePath: null,
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
    return res.status(400).json({ error: "Failed to parse PPTX file. Make sure it is a valid .pptx file." });
  }
});

// GET /api/presentations/:id/file — serve PPTX file for browser rendering
router.get("/presentations/:id/file", (req, res) => {
  const pres = presentations.get(req.params.id);
  if (!pres) return res.status(404).json({ error: "Presentation not found" });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
  res.setHeader("Content-Disposition", `inline; filename="${pres.filename}"`);
  return res.sendFile(pres.pptxPath);
});

// GET /api/presentations/:id/slides/:slideIndex/image — serve slide image
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

// GET /api/presentations — list all presentations
router.get("/presentations", (req, res) => {
  const list = Array.from(presentations.values()).map(formatPresentation);
  return res.json(list);
});

// GET /api/presentations/:id — get one
router.get("/presentations/:id", (req, res) => {
  const pres = presentations.get(req.params.id);
  if (!pres) return res.status(404).json({ error: "Presentation not found" });
  return res.json(formatPresentation(pres));
});

// DELETE /api/presentations/:id — delete
router.delete("/presentations/:id", (req, res) => {
  const pres = presentations.get(req.params.id);
  if (!pres) return res.status(404).json({ error: "Presentation not found" });
  // Clean up files
  try {
    if (fs.existsSync(pres.pptxPath)) fs.unlinkSync(pres.pptxPath);
    const audioDir = path.join(UPLOAD_DIR, "audio", pres.id);
    if (fs.existsSync(audioDir)) fs.rmSync(audioDir, { recursive: true });
    const imageDir = path.join(UPLOAD_DIR, "images", pres.id);
    if (fs.existsSync(imageDir)) fs.rmSync(imageDir, { recursive: true });
    if (pres.exportPath && fs.existsSync(pres.exportPath)) fs.unlinkSync(pres.exportPath);
  } catch {}
  presentations.delete(req.params.id);
  exportJobs.delete(req.params.id);
  return res.status(204).send();
});

// POST /api/presentations/:id/slides/:slideIndex/audio — upload audio
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

    // Get audio duration using ffprobe
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

// DELETE /api/presentations/:id/slides/:slideIndex/audio — delete audio
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

// POST /api/presentations/:id/slides/:slideIndex/image — upload slide image (PNG from browser canvas)
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

// GET /api/presentations/:id/export — get export status
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

// POST /api/presentations/:id/export — start export
router.post("/presentations/:id/export", async (req, res) => {
  const pres = presentations.get(req.params.id);
  if (!pres) return res.status(404).json({ error: "Presentation not found" });

  const slidesWithAudio = pres.slides.filter((s) => s.hasAudio && s.audioPath && s.imagePath);
  if (slidesWithAudio.length === 0) {
    return res.status(400).json({ error: "No slides have both images and audio. Record voiceovers and capture slides first." });
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

  // Kick off export in background
  runExport(pres, job).catch((err) => {
    job.status = "error";
    job.error = String(err);
    pres.exportStatus = "error";
  });

  return res.json(job);
});

async function runExport(pres: PresentationData, job: ExportJobData) {
  const exportId = uuidv4();
  const exportDir = path.join(EXPORTS_DIR, exportId);
  fs.mkdirSync(exportDir, { recursive: true });

  const slidesWithBoth = pres.slides.filter((s) => s.hasAudio && s.audioPath && s.imagePath);
  const segmentPaths: string[] = [];

  for (let i = 0; i < slidesWithBoth.length; i++) {
    const slide = slidesWithBoth[i];
    const segmentPath = path.join(exportDir, `segment-${i}.mp4`);

    await new Promise<void>((resolve, reject) => {
      const duration = slide.audioDurationSeconds || 5;
      ffmpeg()
        .input(slide.imagePath!)
        .inputOptions(["-loop 1"])
        .input(slide.audioPath!)
        .videoCodec("libx264")
        .audioCodec("aac")
        .outputOptions([
          "-pix_fmt yuv420p",
          `-t ${duration}`,
          "-vf scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2",
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
    job.progress = Math.round(((i + 1) / slidesWithBoth.length) * 80);
  }

  // Create concat list
  const concatListPath = path.join(exportDir, "concat.txt");
  const concatContent = segmentPaths.map((p) => `file '${p}'`).join("\n");
  fs.writeFileSync(concatListPath, concatContent);

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

  // Clean up segments
  fs.rmSync(exportDir, { recursive: true, force: true });

  pres.exportPath = outputPath;
  pres.exportStatus = "done";
  job.status = "done";
  job.progress = 100;
  job.downloadUrl = `/api/presentations/${pres.id}/export/download`;
}

// GET /api/presentations/:id/export/download — download MP4
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
