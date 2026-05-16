import { useState, useRef } from "react";
import { useParams, useLocation, Link } from "wouter";
import { Mic, Square, ArrowLeft, ArrowRight, FileVideo, ChevronLeft, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useGetPresentation, getGetPresentationQueryKey, useDeleteSlideAudio } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import html2canvas from "html2canvas";

export default function Editor() {
  const { id } = useParams();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: presentation, isLoading } = useGetPresentation(id as string, {
    query: { enabled: !!id, queryKey: getGetPresentationQueryKey(id as string) },
  });

  const [currentSlideIndex, setCurrentSlideIndex] = useState(0);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  const audioChunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const slideContainerRef = useRef<HTMLDivElement>(null);

  const deleteAudio = useDeleteSlideAudio();

  const handleRecordStart = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });

      audioChunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const audioBlob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        await uploadAudioAndImage(audioBlob);
      };

      recorder.start();
      setMediaRecorder(recorder);
      setIsRecording(true);
      setRecordingTime(0);

      timerRef.current = setInterval(() => {
        setRecordingTime((prev) => prev + 1);
      }, 1000);
    } catch (err) {
      console.error("Mic error:", err);
      toast({
        title: "Microphone access denied",
        description: "Please allow microphone access in your browser settings and try again.",
        variant: "destructive",
      });
    }
  };

  const handleRecordStop = () => {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
      setIsRecording(false);
      if (timerRef.current) clearInterval(timerRef.current);
    }
  };

  const uploadAudioAndImage = async (audioBlob: Blob) => {
    if (!id) return;
    setIsUploading(true);
    try {
      // 1. Upload audio
      const audioForm = new FormData();
      audioForm.append("audio", audioBlob, `slide-${currentSlideIndex}.webm`);
      const audioRes = await fetch(
        `/api/presentations/${id}/slides/${currentSlideIndex}/audio`,
        { method: "POST", body: audioForm }
      );
      if (!audioRes.ok) throw new Error("Audio upload failed");

      // 2. Capture slide container as PNG and upload
      if (slideContainerRef.current) {
        try {
          const canvas = await html2canvas(slideContainerRef.current, {
            useCORS: true,
            allowTaint: true,
            backgroundColor: "#1a1a2e",
          });
          await new Promise<void>((resolve) => {
            canvas.toBlob(async (imgBlob) => {
              if (imgBlob) {
                const imgForm = new FormData();
                imgForm.append("image", imgBlob, `slide-${currentSlideIndex}.png`);
                await fetch(
                  `/api/presentations/${id}/slides/${currentSlideIndex}/image`,
                  { method: "POST", body: imgForm }
                );
              }
              resolve();
            }, "image/png");
          });
        } catch (e) {
          console.error("Slide capture failed:", e);
        }
      }

      toast({ title: "Voiceover saved", description: `Slide ${currentSlideIndex + 1} recorded.` });
      queryClient.invalidateQueries({ queryKey: getGetPresentationQueryKey(id) });
    } catch {
      toast({ title: "Upload failed", description: "Could not save the recording.", variant: "destructive" });
    } finally {
      setIsUploading(false);
    }
  };

  const handleDeleteAudio = () => {
    if (!id) return;
    deleteAudio.mutate(
      { id, slideIndex: currentSlideIndex },
      {
        onSuccess: () => {
          toast({ title: "Audio removed" });
          queryClient.invalidateQueries({ queryKey: getGetPresentationQueryKey(id) });
        },
      }
    );
  };

  const formatTime = (s: number) =>
    `${Math.floor(s / 60).toString().padStart(2, "0")}:${(s % 60).toString().padStart(2, "0")}`;

  if (isLoading || !presentation) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-muted-foreground animate-pulse">Loading editor…</div>
      </div>
    );
  }

  const currentSlide = presentation.slides.find((s) => s.index === currentSlideIndex);
  const isLastSlide = currentSlideIndex === presentation.slideCount - 1;
  const isFirstSlide = currentSlideIndex === 0;

  return (
    <div className="flex flex-col h-screen bg-background text-foreground overflow-hidden">
      {/* Header */}
      <header className="h-14 border-b border-border bg-card flex items-center justify-between px-4 shrink-0">
        <div className="flex items-center gap-3">
          <Link href="/">
            <Button variant="ghost" size="sm" className="gap-2 text-muted-foreground" data-testid="button-back">
              <ChevronLeft className="w-4 h-4" />
              Back
            </Button>
          </Link>
          <div className="h-4 w-px bg-border" />
          <h1 className="font-semibold text-sm truncate max-w-[220px] md:max-w-md" data-testid="text-filename">
            {presentation.filename}
          </h1>
        </div>
        <Link href={`/export/${id}`}>
          <Button size="sm" className="gap-2" data-testid="button-go-export">
            <FileVideo className="w-4 h-4" />
            Export Video
          </Button>
        </Link>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Slide Strip */}
        <div className="w-44 border-r border-border bg-card flex flex-col shrink-0">
          <div className="px-3 py-2 border-b border-border text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Slides ({presentation.slideCount})
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-2">
            {Array.from({ length: presentation.slideCount }).map((_, idx) => {
              const slide = presentation.slides.find((s) => s.index === idx);
              const isActive = idx === currentSlideIndex;
              return (
                <button
                  key={idx}
                  onClick={() => setCurrentSlideIndex(idx)}
                  className={`w-full relative rounded border-2 overflow-hidden transition-all text-left ${
                    isActive ? "border-primary" : "border-transparent hover:border-border"
                  }`}
                  data-testid={`slide-thumb-${idx}`}
                >
                  <div className="aspect-[16/9] bg-secondary flex items-center justify-center">
                    {slide?.imageUrl ? (
                      <img
                        src={slide.imageUrl}
                        alt={`Slide ${idx + 1}`}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <span className="text-xl font-black text-muted-foreground/30">{idx + 1}</span>
                    )}
                  </div>
                  <div className="absolute top-1 left-1 bg-background/80 text-[10px] px-1 rounded font-mono text-muted-foreground">
                    {idx + 1}
                  </div>
                  {slide?.hasAudio && (
                    <div className="absolute bottom-1 right-1 w-4 h-4 bg-primary rounded-full flex items-center justify-center shadow">
                      <Mic className="w-2.5 h-2.5 text-primary-foreground" />
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Main area */}
        <div className="flex-1 flex flex-col bg-[#0f0f1a]">
          {/* Slide Preview */}
          <div className="flex-1 flex items-center justify-center p-6">
            <div
              ref={slideContainerRef}
              className="aspect-[16/9] w-full max-w-4xl bg-[#1a1a2e] rounded-lg shadow-2xl border border-white/5 overflow-hidden flex items-center justify-center relative"
              data-testid="slide-preview"
            >
              {currentSlide?.imageUrl ? (
                <img
                  src={currentSlide.imageUrl}
                  alt={`Slide ${currentSlideIndex + 1}`}
                  className="w-full h-full object-contain"
                  crossOrigin="anonymous"
                />
              ) : (
                <div className="text-center select-none">
                  <div className="text-[120px] font-black text-white/5 leading-none">
                    {currentSlideIndex + 1}
                  </div>
                  <p className="text-white/20 text-sm mt-2">Slide {currentSlideIndex + 1}</p>
                </div>
              )}

              {/* Recording indicator overlay */}
              {isRecording && (
                <div className="absolute top-3 right-3 flex items-center gap-2 bg-black/60 backdrop-blur-sm rounded-full px-3 py-1.5">
                  <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                  <span className="text-white text-xs font-mono font-bold">{formatTime(recordingTime)}</span>
                </div>
              )}

              {isUploading && (
                <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                  <div className="text-white text-sm animate-pulse">Saving recording…</div>
                </div>
              )}
            </div>
          </div>

          {/* Controls bar */}
          <div className="h-36 border-t border-border bg-card shrink-0 flex items-center justify-center px-8">
            <div className="flex items-center gap-10 w-full max-w-2xl">
              {/* Navigation */}
              <div className="flex items-center gap-3">
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => setCurrentSlideIndex((p) => Math.max(0, p - 1))}
                  disabled={isFirstSlide || isRecording}
                  data-testid="button-prev-slide"
                >
                  <ArrowLeft className="w-4 h-4" />
                </Button>
                <span className="text-sm font-mono text-muted-foreground w-16 text-center">
                  {currentSlideIndex + 1} / {presentation.slideCount}
                </span>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() =>
                    setCurrentSlideIndex((p) => Math.min(presentation.slideCount - 1, p + 1))
                  }
                  disabled={isLastSlide || isRecording}
                  data-testid="button-next-slide"
                >
                  <ArrowRight className="w-4 h-4" />
                </Button>
              </div>

              {/* Record Button */}
              <div className="flex flex-col items-center gap-2 flex-1">
                {isRecording ? (
                  <Button
                    variant="destructive"
                    size="lg"
                    className="w-16 h-16 rounded-full shadow-lg shadow-red-900/40"
                    onClick={handleRecordStop}
                    data-testid="button-stop-record"
                  >
                    <Square className="w-5 h-5 fill-current" />
                  </Button>
                ) : (
                  <Button
                    size="lg"
                    className={`w-16 h-16 rounded-full shadow-lg transition-all ${
                      currentSlide?.hasAudio
                        ? "bg-secondary border border-border text-foreground hover:bg-secondary/80"
                        : "bg-primary hover:bg-primary/90 shadow-primary/30"
                    }`}
                    onClick={handleRecordStart}
                    disabled={isUploading}
                    data-testid="button-start-record"
                  >
                    <Mic className="w-6 h-6" />
                  </Button>
                )}
                <span className="text-xs text-muted-foreground h-4">
                  {isRecording
                    ? "Recording — click to stop"
                    : isUploading
                    ? "Saving…"
                    : currentSlide?.hasAudio
                    ? `Recorded · ${formatTime(currentSlide.audioDurationSeconds ?? 0)}`
                    : "Click to record voiceover"}
                </span>
              </div>

              {/* Delete */}
              <div className="w-20 flex justify-end">
                {currentSlide?.hasAudio && !isRecording && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive gap-1.5"
                    onClick={handleDeleteAudio}
                    data-testid="button-delete-audio"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Delete
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
