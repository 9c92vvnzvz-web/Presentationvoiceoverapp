import { useState, useCallback, useRef } from "react";
import { useLocation, Link } from "wouter";
import { UploadCloud, Trash2, ArrowRight, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { useListPresentations, useDeletePresentation, getListPresentationsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import mascotImg from "@assets/IMG_6680_1778891792083.jpeg";

export default function Home() {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: presentations, isLoading } = useListPresentations();
  const deletePresentation = useDeletePresentation();

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  }, []);

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) handleFiles(e.target.files);
  };

  const handleFiles = async (files: FileList) => {
    const file = files[0];
    if (!file.name.toLowerCase().endsWith(".pptx")) {
      toast({ title: "Invalid file", description: "Please upload a .pptx file", variant: "destructive" });
      return;
    }
    setIsUploading(true);
    const formData = new FormData();
    formData.append("file", file);
    try {
      const res = await fetch("/api/upload", { method: "POST", body: formData });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Upload failed");
      }
      const presentation = await res.json();
      queryClient.invalidateQueries({ queryKey: getListPresentationsQueryKey() });
      setLocation(`/editor/${presentation.id}`);
    } catch (error) {
      toast({
        title: "Upload failed",
        description: error instanceof Error ? error.message : "There was an error uploading your presentation.",
        variant: "destructive",
      });
    } finally {
      setIsUploading(false);
    }
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    deletePresentation.mutate({ id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListPresentationsQueryKey() });
        toast({ title: "Presentation deleted" });
      },
      onError: () => toast({ title: "Failed to delete", variant: "destructive" }),
    });
  };

  return (
    <div className="min-h-screen w-full bg-background flex flex-col">
      {/* Header */}
      <header className="border-b border-border bg-card/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="container mx-auto px-4 h-16 flex items-center gap-3">
          <div className="w-8 h-8 rounded-full overflow-hidden border-2 border-primary/30 shadow-sm shrink-0">
            <img src={mascotImg} alt="mascot" className="w-full h-full object-cover object-top" />
          </div>
          <h1 className="font-bold text-lg tracking-tight text-foreground">
            PPTX Voiceover Studio
          </h1>
        </div>
      </header>

      <main className="flex-1 container mx-auto px-4 py-10 max-w-5xl">
        {/* Hero */}
        <div className="flex flex-col md:flex-row items-center gap-8 mb-12">
          {/* Text */}
          <div className="flex-1 space-y-4">
            <div className="inline-flex items-center gap-2 bg-primary/10 text-primary text-sm font-medium px-3 py-1 rounded-full border border-primary/20">
              <Sparkles className="w-3.5 h-3.5" />
              Record. Narrate. Export.
            </div>
            <h2 className="text-4xl font-bold tracking-tight text-foreground leading-tight">
              Give your slides<br />
              <span className="text-primary">a voice</span>
            </h2>
            <p className="text-muted-foreground text-base leading-relaxed max-w-sm">
              Upload any PowerPoint presentation, record a personal voiceover for each slide, then export the whole thing as a polished MP4 video.
            </p>
          </div>

          {/* Mascot */}
          <div className="shrink-0 relative">
            <div className="w-52 h-64 rounded-3xl overflow-hidden shadow-xl border-2 border-primary/20 bg-gradient-to-b from-pink-50 to-rose-50">
              <img
                src={mascotImg}
                alt="Studio mascot"
                className="w-full h-full object-cover object-top"
              />
            </div>
            <div className="absolute -top-2 -right-2 w-7 h-7 bg-primary rounded-full flex items-center justify-center shadow-md">
              <Sparkles className="w-3.5 h-3.5 text-white" />
            </div>
            <div className="absolute -bottom-2 -left-2 w-6 h-6 bg-rose-300 rounded-full opacity-70" />
          </div>
        </div>

        {/* Upload zone */}
        <div
          className={`border-2 border-dashed rounded-2xl transition-all duration-200 cursor-pointer mb-10 ${
            isDragging
              ? "border-primary bg-primary/5 scale-[1.01]"
              : "border-border hover:border-primary/50 hover:bg-card"
          }`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          data-testid="upload-zone"
        >
          <input
            type="file"
            ref={fileInputRef}
            className="hidden"
            accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
            onChange={handleFileInput}
          />
          <div className="flex flex-col items-center justify-center py-14 text-center select-none">
            <div className="w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mb-4">
              <UploadCloud className="w-8 h-8 text-primary" />
            </div>
            <h3 className="text-lg font-semibold text-foreground mb-1">
              {isUploading ? "Processing your presentation…" : "Drop your .pptx file here"}
            </h3>
            <p className="text-sm text-muted-foreground mb-5">
              {isUploading ? "Extracting slides, please wait" : "or click anywhere to browse files"}
            </p>
            <Button
              size="default"
              disabled={isUploading}
              className="pointer-events-none px-6"
              data-testid="button-select-file"
            >
              {isUploading ? "Uploading…" : "Select .pptx file"}
            </Button>
          </div>
        </div>

        {/* Recent presentations */}
        {!isLoading && presentations && presentations.length > 0 && (
          <div className="space-y-4">
            <h3 className="text-base font-semibold text-foreground">Recent Projects</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {presentations.map((p) => (
                <Link href={`/editor/${p.id}`} key={p.id}>
                  <Card className="group cursor-pointer hover:border-primary/40 hover:shadow-sm transition-all h-full flex flex-col">
                    <CardHeader className="pb-2 flex-1">
                      <CardTitle className="line-clamp-1 text-sm font-semibold" title={p.filename}>
                        {p.filename}
                      </CardTitle>
                      <CardDescription className="text-xs">
                        {new Date(p.createdAt).toLocaleDateString()} · {p.slideCount} slide{p.slideCount !== 1 ? "s" : ""}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="pt-0 flex items-center justify-between">
                      <div className="text-xs text-muted-foreground">
                        {p.slides?.filter((s) => s.hasAudio).length ?? 0} / {p.slideCount} recorded
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                          onClick={(e) => handleDelete(p.id, e)}
                          data-testid={`button-delete-${p.id}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-primary">
                          <ArrowRight className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
