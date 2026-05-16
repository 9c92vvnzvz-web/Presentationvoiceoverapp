import { useState, useEffect, useRef } from "react";
import JSZip from "jszip";

const SLIDE_W = 9144000;
const SLIDE_H = 5143500;

function pct(emu: number, total: number) {
  return (emu / total) * 100;
}

function getAttr(el: Element, name: string): string {
  return el.getAttribute(name) ?? "";
}

function byTag(parent: Element | Document, local: string): Element[] {
  const all = parent.getElementsByTagName("*");
  const out: Element[] = [];
  for (let i = 0; i < all.length; i++) {
    if (all[i].localName === local) out.push(all[i]);
  }
  return out;
}

function firstByTag(parent: Element | Document, local: string): Element | null {
  const all = parent.getElementsByTagName("*");
  for (let i = 0; i < all.length; i++) {
    if (all[i].localName === local) return all[i];
  }
  return null;
}

function parseColor(el: Element): string | null {
  const srgb = firstByTag(el, "srgbClr");
  if (srgb) return `#${getAttr(srgb, "val")}`;
  const scheme = firstByTag(el, "schemeClr");
  if (scheme) {
    const val = getAttr(scheme, "val");
    const schemeMap: Record<string, string> = {
      dk1: "#000000", lt1: "#ffffff", dk2: "#1f3864",
      lt2: "#eeeeee", accent1: "#4472c4", accent2: "#ed7d31",
      accent3: "#a9d18e", accent4: "#ffc000", accent5: "#5b9bd5",
      accent6: "#70ad47", tx1: "#000000", tx2: "#44546a",
      bg1: "#ffffff", bg2: "#e7e6e6",
    };
    return schemeMap[val] ?? null;
  }
  return null;
}

interface TextRun {
  text: string;
  bold: boolean;
  italic: boolean;
  fontSize: number | null;
  color: string | null;
}

interface Paragraph {
  runs: TextRun[];
  align: string;
  spaceBefore: number;
}

interface ShapeBox {
  id: string;
  type: "text" | "image";
  x: number;
  y: number;
  w: number;
  h: number;
  paragraphs?: Paragraph[];
  bgColor?: string | null;
  imageSrc?: string;
  rot?: number;
}

interface SlideContent {
  bgColor: string;
  shapes: ShapeBox[];
}

const cache = new Map<string, JSZip>();
const slideCache = new Map<string, SlideContent>();

async function getZip(pptxUrl: string): Promise<JSZip> {
  if (cache.has(pptxUrl)) return cache.get(pptxUrl)!;
  const res = await fetch(pptxUrl);
  if (!res.ok) throw new Error("Failed to fetch PPTX");
  const buf = await res.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);
  cache.set(pptxUrl, zip);
  return zip;
}

async function parseSlide(zip: JSZip, slideIdx: number): Promise<SlideContent> {
  // Slide files are 1-indexed in PPTX
  const slideFiles = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => {
      const na = parseInt(a.match(/slide(\d+)\.xml/)![1]);
      const nb = parseInt(b.match(/slide(\d+)\.xml/)![1]);
      return na - nb;
    });

  const slideName = slideFiles[slideIdx];
  if (!slideName) throw new Error("Slide not found");
  const slideNum = parseInt(slideName.match(/slide(\d+)\.xml/)![1]);

  const [slideXml, relsXml] = await Promise.all([
    zip.files[slideName].async("string"),
    zip.files[`ppt/slides/_rels/slide${slideNum}.xml.rels`]?.async("string") ?? Promise.resolve(""),
  ]);

  const parser = new DOMParser();
  const doc = parser.parseFromString(slideXml, "application/xml");

  // Build rId → media path map
  const relMap: Record<string, string> = {};
  if (relsXml) {
    const rDoc = parser.parseFromString(relsXml, "application/xml");
    for (const rel of byTag(rDoc, "Relationship")) {
      const id = getAttr(rel, "Id");
      const target = getAttr(rel, "Target");
      if (target.includes("/media/") || target.includes("../media/")) {
        const mediaPath = target.startsWith("../")
          ? "ppt/" + target.slice(3)
          : target;
        relMap[id] = mediaPath;
      }
    }
  }

  // Background color
  let bgColor = "#ffffff";
  const bgRef = firstByTag(doc, "bg");
  if (bgRef) {
    const solidFill = firstByTag(bgRef, "solidFill");
    if (solidFill) {
      const c = parseColor(solidFill);
      if (c) bgColor = c;
    }
  }

  const shapes: ShapeBox[] = [];
  const spTree = firstByTag(doc, "spTree");
  if (!spTree) return { bgColor, shapes };

  let shapeId = 0;

  // Process all child elements of spTree
  const children = spTree.children;
  for (let ci = 0; ci < children.length; ci++) {
    const child = children[ci];
    const tag = child.localName;

    if (tag === "sp") {
      // Text shape
      const xfrm = firstByTag(child, "xfrm");
      if (!xfrm) continue;
      const off = firstByTag(xfrm, "off");
      const ext = firstByTag(xfrm, "ext");
      if (!off || !ext) continue;

      const x = pct(parseInt(getAttr(off, "x") || "0"), SLIDE_W);
      const y = pct(parseInt(getAttr(off, "y") || "0"), SLIDE_H);
      const w = pct(parseInt(getAttr(ext, "cx") || "0"), SLIDE_W);
      const h = pct(parseInt(getAttr(ext, "cy") || "0"), SLIDE_H);
      const rot = parseInt(getAttr(xfrm, "rot") || "0") / 60000; // convert from 1/60000 degree

      if (w <= 0 || h <= 0) continue;

      // Background fill of shape
      let shapeBg: string | null = null;
      const spPr = firstByTag(child, "spPr");
      if (spPr) {
        const sf = firstByTag(spPr, "solidFill");
        if (sf) shapeBg = parseColor(sf);
        const noFill = firstByTag(spPr, "noFill");
        if (noFill) shapeBg = "transparent";
      }

      // Parse text body
      const txBody = firstByTag(child, "txBody");
      if (!txBody) continue;

      const paragraphs: Paragraph[] = [];
      for (const paraEl of byTag(txBody, "p")) {
        // Paragraph properties
        const pPr = firstByTag(paraEl, "pPr");
        const align = pPr ? (getAttr(pPr, "algn") || "l") : "l";
        const spcBef = pPr ? firstByTag(pPr, "spcBef") : null;
        let spaceBefore = 0;
        if (spcBef) {
          const spcPts = firstByTag(spcBef, "spcPts");
          if (spcPts) spaceBefore = parseInt(getAttr(spcPts, "val") || "0") / 100;
        }

        const runs: TextRun[] = [];

        // Default run props from paragraph
        let defaultFontSize: number | null = null;
        const defRPr = firstByTag(paraEl, "defRPr");
        if (defRPr) {
          const sz = getAttr(defRPr, "sz");
          if (sz) defaultFontSize = parseInt(sz) / 100;
        }

        // Collect runs from <a:r> and line breaks <a:br>
        const runEls = paraEl.children;
        for (let ri = 0; ri < runEls.length; ri++) {
          const rEl = runEls[ri];
          if (rEl.localName === "br") {
            runs.push({ text: "\n", bold: false, italic: false, fontSize: null, color: null });
            continue;
          }
          if (rEl.localName !== "r") continue;

          const rPr = firstByTag(rEl, "rPr");
          let bold = false;
          let italic = false;
          let fontSize: number | null = defaultFontSize;
          let color: string | null = null;

          if (rPr) {
            bold = getAttr(rPr, "b") === "1";
            italic = getAttr(rPr, "i") === "1";
            const sz = getAttr(rPr, "sz");
            if (sz) fontSize = parseInt(sz) / 100;
            const solidFill = firstByTag(rPr, "solidFill");
            if (solidFill) color = parseColor(solidFill);
          }

          const tEl = firstByTag(rEl, "t");
          const text = tEl?.textContent ?? "";
          if (text) {
            runs.push({ text, bold, italic, fontSize, color });
          }
        }

        if (runs.length > 0 || paragraphs.length > 0) {
          paragraphs.push({ runs, align, spaceBefore });
        }
      }

      if (paragraphs.some((p) => p.runs.length > 0)) {
        shapes.push({
          id: `sp-${shapeId++}`,
          type: "text",
          x, y, w, h, rot,
          paragraphs,
          bgColor: shapeBg,
        });
      }
    } else if (tag === "pic") {
      // Picture shape
      const xfrm = firstByTag(child, "xfrm");
      if (!xfrm) continue;
      const off = firstByTag(xfrm, "off");
      const ext = firstByTag(xfrm, "ext");
      if (!off || !ext) continue;

      const x = pct(parseInt(getAttr(off, "x") || "0"), SLIDE_W);
      const y = pct(parseInt(getAttr(off, "y") || "0"), SLIDE_H);
      const w = pct(parseInt(getAttr(ext, "cx") || "0"), SLIDE_W);
      const h = pct(parseInt(getAttr(ext, "cy") || "0"), SLIDE_H);

      if (w <= 0 || h <= 0) continue;

      // Find image relationship
      const blip = firstByTag(child, "blip");
      if (!blip) continue;

      // rEmbed attribute with namespace prefix
      let rId = blip.getAttribute("r:embed") ?? blip.getAttribute("embed") ?? "";
      // Try all attributes
      const attrs = blip.attributes;
      for (let ai = 0; ai < attrs.length; ai++) {
        if (attrs[ai].localName === "embed") {
          rId = attrs[ai].value;
          break;
        }
      }

      const mediaPath = relMap[rId];
      if (!mediaPath) continue;

      const mediaFile = zip.files[mediaPath];
      if (!mediaFile) continue;

      const ext2 = mediaPath.split(".").pop()?.toLowerCase() ?? "png";
      const mimeMap: Record<string, string> = {
        png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
        gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
        svg: "image/svg+xml",
      };
      const mime = mimeMap[ext2] ?? "image/png";

      const data = await mediaFile.async("base64");
      const imageSrc = `data:${mime};base64,${data}`;

      shapes.push({
        id: `pic-${shapeId++}`,
        type: "image",
        x, y, w, h,
        imageSrc,
      });
    } else if (tag === "grpSp") {
      // Group shape — flatten by processing its children too
      // (simplified: skip for now)
    }
  }

  // Sort: images first, then text on top
  shapes.sort((a, b) => {
    if (a.type === "image" && b.type === "text") return -1;
    if (a.type === "text" && b.type === "image") return 1;
    return 0;
  });

  return { bgColor, shapes };
}

const alignMap: Record<string, string> = {
  l: "left", ctr: "center", r: "right", just: "justify",
};

interface Props {
  presentationId: string;
  slideIndex: number;
  className?: string;
}

export default function PptxSlideViewer({ presentationId, slideIndex, className }: Props) {
  const [content, setContent] = useState<SlideContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);

    const key = `${presentationId}:${slideIndex}`;
    if (slideCache.has(key)) {
      setContent(slideCache.get(key)!);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;

    (async () => {
      try {
        const zip = await getZip(`/api/presentations/${presentationId}/file`);
        if (controller.signal.aborted) return;
        const result = await parseSlide(zip, slideIndex);
        if (controller.signal.aborted) return;
        slideCache.set(key, result);
        setContent(result);
      } catch (e) {
        if (!controller.signal.aborted) {
          setError("Could not render slide preview");
          console.error(e);
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => {
      controller.abort();
    };
  }, [presentationId, slideIndex]);

  if (loading) {
    return (
      <div className={`flex items-center justify-center bg-white ${className ?? ""}`}>
        <div className="text-sm text-gray-400 animate-pulse">Loading slide…</div>
      </div>
    );
  }

  if (error || !content) {
    return (
      <div className={`flex items-center justify-center bg-gray-50 ${className ?? ""}`}>
        <div className="text-center text-gray-400">
          <div className="text-5xl font-black opacity-20 mb-2">{slideIndex + 1}</div>
          <div className="text-xs">Slide {slideIndex + 1}</div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`relative overflow-hidden ${className ?? ""}`}
      style={{ backgroundColor: content.bgColor }}
    >
      {content.shapes.map((shape) => {
        if (shape.type === "image") {
          return (
            <img
              key={shape.id}
              src={shape.imageSrc}
              alt=""
              style={{
                position: "absolute",
                left: `${shape.x}%`,
                top: `${shape.y}%`,
                width: `${shape.w}%`,
                height: `${shape.h}%`,
                objectFit: "cover",
                transform: shape.rot ? `rotate(${shape.rot}deg)` : undefined,
              }}
            />
          );
        }

        if (shape.type === "text") {
          return (
            <div
              key={shape.id}
              style={{
                position: "absolute",
                left: `${shape.x}%`,
                top: `${shape.y}%`,
                width: `${shape.w}%`,
                height: `${shape.h}%`,
                overflow: "hidden",
                backgroundColor: shape.bgColor === "transparent" ? undefined : (shape.bgColor ?? undefined),
                transform: shape.rot ? `rotate(${shape.rot}deg)` : undefined,
              }}
            >
              {shape.paragraphs?.map((para, pi) => (
                <p
                  key={pi}
                  style={{
                    textAlign: (alignMap[para.align] as React.CSSProperties["textAlign"]) ?? "left",
                    margin: 0,
                    paddingTop: para.spaceBefore ? `${para.spaceBefore * 0.15}%` : 0,
                    lineHeight: 1.2,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {para.runs.map((run, ri) => {
                    const fontSize = run.fontSize
                      ? `${(run.fontSize / 72) * (100 / 7.5)}vh`
                      : undefined;
                    return (
                      <span
                        key={ri}
                        style={{
                          fontWeight: run.bold ? "bold" : "normal",
                          fontStyle: run.italic ? "italic" : "normal",
                          fontSize,
                          color: run.color ?? undefined,
                        }}
                      >
                        {run.text}
                      </span>
                    );
                  })}
                </p>
              ))}
            </div>
          );
        }

        return null;
      })}
    </div>
  );
}
