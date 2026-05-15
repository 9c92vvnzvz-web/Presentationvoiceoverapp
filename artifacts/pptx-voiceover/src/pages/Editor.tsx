import React, { useState, useEffect, useRef } from "react";
import { useParams, useLocation, Link } from "wouter";
import { Mic, Square, Play, ArrowLeft, ArrowRight, FileVideo, UploadCloud, ChevronLeft } from "lucide-react";
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
    query: { enabled: !!id, queryKey: getGetPresentationQueryKey(id as string) }
  });

  const [currentSlideIndex, setCurrentSlideIndex] = useState(0);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null);
  
  const audioChunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const slideContainerRef = useRef<HTMLDivElement>(null);
  const audioPlayerRef = useRef<HTMLAudioElement>(null);

  const deleteAudio = useDeleteSlideAudio();

  const handleRecordStart = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      
      audioChunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };
      
      recorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        await uploadAudio(audioBlob);
        
        // Stop all tracks
        stream.getTracks().forEach(track => track.stop());
      };
      
      recorder.start();
      setMediaRecorder(recorder);
      setIsRecording(true);
      setRecordingTime(0);
      
      timerRef.current = setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);
      
    } catch (err) {
      console.error("Microphone access denied or error:", err);
      toast({
        title: "Microphone Access Denied",
        description: "Please allow microphone access to record voiceovers.",
        variant: "destructive"
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

  const uploadAudio = async (audioBlob: Blob) => {
    if (!id) return;
    
    // 1. Upload audio
    const audioFormData = new FormData();
    audioFormData.append("audio", audioBlob, `slide-${currentSlideIndex}.webm`);
    
    try {
      const audioRes = await fetch(`/api/presentations/${id}/slides/${currentSlideIndex}/audio`, {
        method: "POST",
        body: audioFormData
      });
      
      if (!audioRes.ok) throw new Error("Audio upload failed");
      
      // 2. Capture and upload slide image
      if (slideContainerRef.current) {
        try {
          const canvas = await html2canvas(slideContainerRef.current);
          canvas.toBlob(async (imgBlob) => {
            if (imgBlob) {
              const imgFormData = new FormData();
              imgFormData.append("image", imgBlob, `slide-${currentSlideIndex}.png`);
              await fetch(`/api/presentations/${id}/slides/${currentSlideIndex}/image`, {
                method: "POST",
                body: imgFormData
              });
            }
          }, "image/png");
        } catch (e) {
          console.error("Failed to capture slide image", e);
        }
      }
      
      toast({ title: "Recording saved" });
      queryClient.invalidateQueries({ queryKey: getGetPresentationQueryKey(id) });
      
    } catch (err) {
      toast({ title: "Upload failed", variant: "destructive" });
    }
  };

  const handleDeleteAudio = () => {
    if (!id) return;
    deleteAudio.mutate({ id, slideIndex: currentSlideIndex }, {
      onSuccess: () => {
        toast({ title: "Audio removed" });
        queryClient.invalidateQueries({ queryKey: getGetPresentationQueryKey(id) });
      }
    });
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60).toString().padStart(2, '0');
    const s = (seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  if (isLoading || !presentation) {
    return <div className="min-h-screen flex items-center justify-center"><p>Loading editor...</p></div>;
  }

  const currentSlide = presentation.slides.find(s => s.index === currentSlideIndex);

  return (
    <div className="flex flex-col h-screen bg-background text-foreground overflow-hidden">
      {/* Header */}
      <header className="h-14 border-b border-border bg-card flex items-center justify-between px-4 shrink-0">
        <div className="flex items-center gap-4">
          <Link href="/">
            <Button variant="ghost" size="sm" className="gap-2 text-muted-foreground">
              <ChevronLeft className="w-4 h-4" />
              Back
            </Button>
          </Link>
          <div className="h-4 w-px bg-border"></div>
          <h1 className="font-semibold text-sm truncate max-w-[200px] md:max-w-md">{presentation.filename}</h1>
        </div>
        <div className="flex items-center gap-2">
          <Link href={`/export/${id}`}>
            <Button size="sm" className="gap-2">
              <FileVideo className="w-4 h-4" />
              Export
            </Button>
          </Link>
        </div>
      </header>

      {/* Main Workspace */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: Slide Strip */}
        <div className="w-48 border-r border-border bg-card flex flex-col shrink-0">
          <div className="p-3 border-b border-border font-medium text-sm text-muted-foreground">
            Slides ({presentation.slideCount})
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            {Array.from({ length: presentation.slideCount }).map((_, idx) => {
              const slide = presentation.slides.find(s => s.index === idx);
              const isActive = idx === currentSlideIndex;
              const hasAudio = slide?.hasAudio;

              return (
                <div 
                  key={idx}
                  onClick={() => setCurrentSlideIndex(idx)}
                  className={`relative cursor-pointer rounded-md overflow-hidden border-2 transition-all ${isActive ? 'border-primary' : 'border-transparent hover:border-border'}`}
                >
                  <div className="aspect-[16/9] bg-secondary flex items-center justify-center">
                    {slide?.imageUrl ? (
                      <img src={slide.imageUrl} alt={`Slide ${idx + 1}`} className="w-full h-full object-cover" />
                    ) : (
                      <span className="text-2xl font-bold text-muted-foreground opacity-50">{idx + 1}</span>
                    )}
                  </div>
                  <div className="absolute top-1 left-1 bg-background/80 backdrop-blur-sm text-xs px-1.5 rounded text-muted-foreground font-mono">
                    {idx + 1}
                  </div>
                  {hasAudio && (
                    <div className="absolute bottom-1 right-1 bg-primary text-primary-foreground p-1 rounded-full shadow-sm">
                      <Mic className="w-3 h-3" />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Center: Slide Editor & Controls */}
        <div className="flex-1 flex flex-col bg-secondary/30 relative">
          
          {/* Slide Display Area */}
          <div className="flex-1 flex items-center justify-center p-8 overflow-hidden">
            <div 
              ref={slideContainerRef}
              className="aspect-[16/9] w-full max-w-5xl bg-card rounded-xl shadow-lg border border-border flex items-center justify-center overflow-hidden relative"
            >
              {/* Fallback PPTX renderer placeholder - in reality pptxjs would render here */}
              <div className="text-center">
                <span className="text-8xl font-black text-muted-foreground/20">Slide {currentSlideIndex + 1}</span>
                <p className="text-muted-foreground mt-4 font-medium">(PPTX Renderer Placeholder)</p>
              </div>
            </div>
          </div>

          {/* Recording Controls Area */}
          <div className="h-40 border-t border-border bg-card shrink-0 p-6 flex items-center justify-center">
            
            <div className="flex items-center gap-12 max-w-3xl w-full">
              
              <div className="flex items-center gap-4 w-1/3">
                <Button 
                  variant="outline" 
                  size="icon" 
                  onClick={() => setCurrentSlideIndex(Math.max(0, currentSlideIndex - 1))}
                  disabled={currentSlideIndex === 0 || isRecording}
                >
                  <ArrowLeft className="w-5 h-5" />
                </Button>
                <div className="text-sm font-mono text-muted-foreground">
                  {currentSlideIndex + 1} / {presentation.slideCount}
                </div>
                <Button 
                  variant="outline" 
                  size="icon" 
                  onClick={() => setCurrentSlideIndex(Math.min(presentation.slideCount - 1, currentSlideIndex + 1))}
                  disabled={currentSlideIndex === presentation.slideCount - 1 || isRecording}
                >
                  <ArrowRight className="w-5 h-5" />
                </Button>
              </div>

              <div className="flex flex-col items-center justify-center gap-3 w-1/3">
                {isRecording ? (
                  <div className="flex items-center gap-4">
                    <Button 
                      variant="destructive" 
                      size="lg"
                      className="w-16 h-16 rounded-full shadow-lg shadow-destructive/20"
                      onClick={handleRecordStop}
                    >
                      <Square className="w-6 h-6 fill-current" />
                    </Button>
                  </div>
                ) : (
                  <Button 
                    variant="default" 
                    size="lg"
                    className={`w-16 h-16 rounded-full shadow-lg ${currentSlide?.hasAudio ? 'bg-secondary text-foreground hover:bg-secondary/80' : 'bg-primary hover:bg-primary/90'}`}
                    onClick={handleRecordStart}
                  >
                    <Mic className="w-6 h-6" />
                  </Button>
                )}
                
                <div className="text-center h-6">
                  {isRecording ? (
                    <span className="text-destructive font-mono font-bold flex items-center gap-2 animate-pulse">
                      <span className="w-2 h-2 rounded-full bg-destructive"></span>
                      Recording {formatTime(recordingTime)}
                    </span>
                  ) : currentSlide?.hasAudio ? (
                    <span className="text-muted-foreground text-sm flex items-center gap-2">
                      Recorded • {formatTime(currentSlide.audioDurationSeconds || 0)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground text-sm">Ready to record</span>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 w-1/3">
                {currentSlide?.hasAudio && !isRecording && (
                  <Button 
                    variant="ghost" 
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={handleDeleteAudio}
                  >
                    Delete Audio
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
