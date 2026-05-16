import { useState, useEffect, useRef } from "react";
import JSZip from "jszip";

// Native render resolution (16:9, matches PPTX standard 10in × 7.5in at 96dpi)
const NATIVE_W = 960;
const NATIVE_H = 540;
const SLIDE_W_EMU = 9144000;
const SLIDE_H_EMU = 5143500;
// 1 EMU → px at native resolution
const EMU_TO_PX_X = NATIVE_W / SLIDE_W_EMU;
const EMU_TO_PX_Y = NATIVE_H / SLIDE_H_EMU;
// Font size: PPTX sz is 100ths of a point, 1pt = 4/3px at 96dpi
const SZ_TO_PX = (4 / 3) / 100;

function attr(el: Element, name: string): string {
  return el.getAttribute(name) ?? "";
}

function first(parent: Element | Document, local: string): Element | null {
  const all = parent.getElementsByTagName("*");
  for (let i = 0; i < all.length; i++) {
    if (all[i].localName === local) return all[i];
  }
  return null;
}

function all(parent: Element | Document, local: string): Element[] {
  const els = parent.getElementsByTagName("*");
  const out: Element[] = [];
  for (let i = 0; i < els.length; i++) {
    if (els[i].localName === local) out.push(els[i]);
  }
  return out;
}

function parseColor(el: Element): string | null {
  const srgb = first(el, "srgbClr");
  if (srgb) return `#${attr(srgb, "val")}`;
  const scheme = first(el, "schemeClr");
  if (scheme) {
    const map: Record<string, string> = {
      dk1: "#000000", lt1: "#ffffff", dk2: "#1f3864", lt2: "#eeeeee",
      accent1: "#4472c4", accent2: "#ed7d31", accent3: "#a9d18e",
      accent4: "#ffc000", accent5: "#5b9bd5", accent6: "#70ad47",
      tx1: "#000000", tx2: "#44546a", bg1: "#ffffff", bg2: "#e7e6e6",
    };
    return map[attr(scheme, "val")] ?? null;
  }
  const prstClr = first(el, "prstClr");
  if (prstClr) {
    const nameMap: Record<string, string> = {
      black: "#000000", white: "#ffffff", red: "#ff0000",
      blue: "#0000ff", green: "#008000",
    };
    return nameMap[attr(prstClr, "val")] ?? null;
  }
  return null;
}

interface TextRun { text: string; bold: boolean; italic: boolean; sz: number | null; color: string | null }
interface Para { runs: TextRun[]; align: string }
interface Shape {
  id: string; type: "text" | "image";
  x: number; y: number; w: number; h: number;
  paragraphs?: Para[];
  bgColor?: string | null;
  imageSrc?: string;
  rot?: number;
}
interface SlideData { bgColor: string; shapes: Shape[] }

const zipCache = new Map<string, JSZip>();
const slideCache = new Map<string, SlideData>();

async function getZip(url: string): Promise<JSZip> {
  if (zipCache.has(url)) return zipCache.get(url)!;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const zip = await JSZip.loadAsync(await res.arrayBuffer());
  zipCache.set(url, zip);
  return zip;
}

async function parseSlide(zip: JSZip, slideIdx: number): Promise<SlideData> {
  const slideFiles = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => {
      return parseInt(a.match(/slide(\d+)/)![1]) - parseInt(b.match(/slide(\d+)/)![1]);
    });

  if (slideIdx >= slideFiles.length) throw new Error("Slide out of range");
  const slideName = slideFiles[slideIdx];
  const slideNum = parseInt(slideName.match(/slide(\d+)/)![1]);

  const [slideXml, relsXml] = await Promise.all([
    zip.files[slideName].async("string"),
    zip.files[`ppt/slides/_rels/slide${slideNum}.xml.rels`]?.async("string") ?? Promise.resolve(""),
  ]);

  const parser = new DOMParser();
  const doc = parser.parseFromString(slideXml, "application/xml");

  // Check for XML parse errors
  const parseErr = doc.getElementsByTagName("parsererror")[0];
  if (parseErr) throw new Error("XML parse error: " + parseErr.textContent?.slice(0, 100));

  // Build rId → media path map
  const relMap: Record<string, string> = {};
  if (relsXml) {
    const rDoc = parser.parseFromString(relsXml, "application/xml");
    for (const rel of all(rDoc, "Relationship")) {
      const id = attr(rel, "Id");
      const target = attr(rel, "Target");
      if (target.includes("media")) {
        relMap[id] = target.startsWith("../") ? "ppt/" + target.slice(3) : target;
      }
    }
  }

  // Background
  let bgColor = "#ffffff";
  const bgEl = first(doc, "bg");
  if (bgEl) {
    const sf = first(bgEl, "solidFill");
    if (sf) bgColor = parseColor(sf) ?? bgColor;
  }

  const shapes: Shape[] = [];
  const spTree = first(doc, "spTree");
  if (!spTree) return { bgColor, shapes };

  let sid = 0;
  const kids = Array.from(spTree.children);

  for (const child of kids) {
    const tag = child.localName;

    if (tag === "sp") {
      const xfrm = first(child, "xfrm");
      if (!xfrm) continue;
      const off = first(xfrm, "off");
      const ext = first(xfrm, "ext");
      if (!off || !ext) continue;

      const x = parseInt(attr(off, "x") || "0") * EMU_TO_PX_X;
      const y = parseInt(attr(off, "y") || "0") * EMU_TO_PX_Y;
      const w = parseInt(attr(ext, "cx") || "0") * EMU_TO_PX_X;
      const h = parseInt(attr(ext, "cy") || "0") * EMU_TO_PX_Y;
      const rot = parseInt(attr(xfrm, "rot") || "0") / 60000;

      if (w <= 0 || h <= 0) continue;

      // Shape background
      let shapeBg: string | null = null;
      const spPr = first(child, "spPr");
      if (spPr) {
        if (first(spPr, "noFill")) shapeBg = "transparent";
        else {
          const sf = first(spPr, "solidFill");
          if (sf) shapeBg = parseColor(sf);
        }
      }

      const txBody = first(child, "txBody");
      if (!txBody) continue;

      const paragraphs: Para[] = [];
      for (const paraEl of all(txBody, "p")) {
        // Only look at direct a:p children, skip nested
        if (paraEl.parentElement?.localName !== "txBody") continue;

        const pPr = first(paraEl, "pPr");
        const alignRaw = pPr ? attr(pPr, "algn") : "l";
        const alignMap: Record<string, string> = { l: "left", ctr: "center", r: "right", just: "justify" };
        const align = alignMap[alignRaw] ?? "left";

        // Default size from paragraph or body
        let defSz: number | null = null;
        const defRPr = first(paraEl, "defRPr");
        if (defRPr) { const s = attr(defRPr, "sz"); if (s) defSz = parseInt(s) * SZ_TO_PX; }
        if (!defSz) {
          const bodyPr = first(txBody, "bodyPr");
          // Placeholder font size not easily discoverable without slide layout; default to 18pt
          _ = bodyPr; // suppress unused warning
        }

        const runs: TextRun[] = [];
        for (const rEl of Array.from(paraEl.children)) {
          if (rEl.localName === "br") {
            runs.push({ text: "\n", bold: false, italic: false, sz: null, color: null });
            continue;
          }
          if (rEl.localName !== "r") continue;

          const rPr = first(rEl, "rPr");
          const bold = rPr ? attr(rPr, "b") === "1" : false;
          const italic = rPr ? attr(rPr, "i") === "1" : false;
          let sz: number | null = defSz;
          if (rPr) {
            const s = attr(rPr, "sz");
            if (s) sz = parseInt(s) * SZ_TO_PX;
          }
          let color: string | null = null;
          if (rPr) {
            const sf = first(rPr, "solidFill");
            if (sf) color = parseColor(sf);
          }

          const tEl = first(rEl, "t");
          const text = tEl?.textContent ?? "";
          if (text) runs.push({ text, bold, italic, sz, color });
        }

        if (runs.length > 0) paragraphs.push({ runs, align });
      }

      if (paragraphs.length > 0) {
        shapes.push({ id: `sp${sid++}`, type: "text", x, y, w, h, rot: rot || undefined, paragraphs, bgColor: shapeBg });
      }
    } else if (tag === "pic") {
      const xfrm = first(child, "xfrm");
      if (!xfrm) continue;
      const off = first(xfrm, "off");
      const ext = first(xfrm, "ext");
      if (!off || !ext) continue;

      const x = parseInt(attr(off, "x") || "0") * EMU_TO_PX_X;
      const y = parseInt(attr(off, "y") || "0") * EMU_TO_PX_Y;
      const w = parseInt(attr(ext, "cx") || "0") * EMU_TO_PX_X;
      const h = parseInt(attr(ext, "cy") || "0") * EMU_TO_PX_Y;
      if (w <= 0 || h <= 0) continue;

      const blip = first(child, "blip");
      if (!blip) continue;
      let rId = "";
      const ats = blip.attributes;
      for (let ai = 0; ai < ats.length; ai++) {
        if (ats[ai].localName === "embed") { rId = ats[ai].value; break; }
      }
      const mediaPath = relMap[rId];
      if (!mediaPath || !zip.files[mediaPath]) continue;

      const ext2 = mediaPath.split(".").pop()?.toLowerCase() ?? "png";
      const mimeMap: Record<string, string> = {
        png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
        gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml",
      };
      const data = await zip.files[mediaPath].async("base64");
      shapes.push({
        id: `pic${sid++}`, type: "image", x, y, w, h,
        imageSrc: `data:${mimeMap[ext2] ?? "image/png"};base64,${data}`,
      });
    }
  }

  shapes.sort((a, b) => (a.type === "image" && b.type === "text" ? -1 : a.type === "text" && b.type === "image" ? 1 : 0));
  return { bgColor, shapes };
}

// Suppress unused variable warning
const _: unknown = undefined;

interface Props {
  presentationId: string;
  slideIndex: number;
  className?: string;
}

export default function PptxSlideViewer({ presentationId, slideIndex, className }: Props) {
  const [data, setData] = useState<SlideData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const containerRef = useRef<HTMLDivElement>(null);

  // Compute CSS scale to fit native 960×540 into the container
  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      setScale(w / NATIVE_W);
    });
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    const key = `${presentationId}:${slideIndex}`;
    if (slideCache.has(key)) {
      setData(slideCache.get(key)!);
      setLoading(false);
      return;
    }

    const ctrl = new AbortController();
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const zip = await getZip(`/api/presentations/${presentationId}/file`);
        if (ctrl.signal.aborted) return;
        const result = await parseSlide(zip, slideIndex);
        if (ctrl.signal.aborted) return;
        slideCache.set(key, result);
        setData(result);
      } catch (e) {
        if (!ctrl.signal.aborted) {
          const msg = e instanceof Error ? e.message : String(e);
          setError(msg);
          console.warn(`[PptxSlideViewer] slide ${slideIndex}:`, msg);
        }
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    })();

    return () => ctrl.abort();
  }, [presentationId, slideIndex]);

  if (loading) {
    return (
      <div ref={containerRef} className={`flex items-center justify-center bg-white ${className ?? ""}`}>
        <div className="text-xs text-gray-400 animate-pulse">Loading…</div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div ref={containerRef} className={`flex items-center justify-center bg-gray-50 ${className ?? ""}`}>
        <div className="text-center text-gray-300 select-none">
          <div className="text-5xl font-black">{slideIndex + 1}</div>
          <div className="text-xs mt-1">Slide {slideIndex + 1}</div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`relative overflow-hidden ${className ?? ""}`}
      style={{ backgroundColor: data.bgColor }}
    >
      {/* Fixed-size native canvas, scaled to fit container */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: NATIVE_W,
          height: NATIVE_H,
          transformOrigin: "top left",
          transform: `scale(${scale})`,
        }}
      >
        {data.shapes.map((shape) => {
          if (shape.type === "image") {
            return (
              <img
                key={shape.id}
                src={shape.imageSrc}
                alt=""
                style={{
                  position: "absolute",
                  left: shape.x,
                  top: shape.y,
                  width: shape.w,
                  height: shape.h,
                  objectFit: "fill",
                }}
              />
            );
          }
          return (
            <div
              key={shape.id}
              style={{
                position: "absolute",
                left: shape.x,
                top: shape.y,
                width: shape.w,
                height: shape.h,
                overflow: "hidden",
                backgroundColor: shape.bgColor && shape.bgColor !== "transparent" ? shape.bgColor : undefined,
                transform: shape.rot ? `rotate(${shape.rot}deg)` : undefined,
                padding: "2px 4px",
                boxSizing: "border-box",
              }}
            >
              {shape.paragraphs?.map((para, pi) => (
                <p
                  key={pi}
                  style={{
                    margin: 0,
                    lineHeight: 1.25,
                    textAlign: para.align as React.CSSProperties["textAlign"],
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {para.runs.map((run, ri) => (
                    <span
                      key={ri}
                      style={{
                        fontFamily: "Calibri, Arial, sans-serif",
                        fontWeight: run.bold ? "bold" : "normal",
                        fontStyle: run.italic ? "italic" : "normal",
                        fontSize: run.sz ? `${run.sz}px` : "18px",
                        color: run.color ?? "#000000",
                      }}
                    >
                      {run.text}
                    </span>
                  ))}
                </p>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
