import React, { useState, useCallback, useRef } from "react";
import { useLocation, Link } from "wouter";
import { UploadCloud, FileVideo, Trash2, ArrowRight, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { useListPresentations, useDeletePresentation, getListPresentationsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

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
    const files = e.dataTransfer.files;
    if (files.length) {
      handleFiles(files);
    }
  }, []);

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) {
      handleFiles(e.target.files);
    }
  };

  const handleFiles = async (files: FileList) => {
    const file = files[0];
    if (!file.name.endsWith('.pptx')) {
      toast({ title: "Invalid file", description: "Please upload a .pptx file", variant: "destructive" });
      return;
    }

    setIsUploading(true);
    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        throw new Error("Upload failed");
      }

      const presentation = await res.json();
      queryClient.invalidateQueries({ queryKey: getListPresentationsQueryKey() });
      setLocation(`/editor/${presentation.id}`);
    } catch (error) {
      toast({ title: "Upload failed", description: "There was an error uploading your presentation.", variant: "destructive" });
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
      onError: () => {
        toast({ title: "Failed to delete", variant: "destructive" });
      }
    });
  };

  return (
    <div className="min-h-screen w-full bg-background flex flex-col">
      <header className="border-b border-border/40 bg-card/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="container mx-auto px-4 h-16 flex items-center">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-md bg-primary flex items-center justify-center">
              <Video className="w-5 h-5 text-primary-foreground" />
            </div>
            <h1 className="font-semibold text-lg tracking-tight">PPTX Voiceover Studio</h1>
          </div>
        </div>
      </header>

      <main className="flex-1 container mx-auto px-4 py-12 max-w-4xl">
        <div className="flex flex-col gap-12">
          
          <div className="flex flex-col items-center text-center gap-4 max-w-xl mx-auto">
            <h2 className="text-4xl font-bold tracking-tight text-foreground">Record Voiceovers for Your Slides</h2>
            <p className="text-muted-foreground text-lg">
              Upload your PowerPoint presentation, record a voiceover for each slide in our studio editor, and export as a high-quality video.
            </p>
          </div>

          <Card className={`border-2 border-dashed transition-all duration-200 overflow-hidden ${isDragging ? "border-primary bg-primary/5" : "border-border/60 hover:border-primary/50 hover:bg-card/80"}`}>
            <div
              className="p-16 flex flex-col items-center justify-center text-center cursor-pointer min-h-[320px]"
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
            >
              <input 
                type="file" 
                ref={fileInputRef} 
                className="hidden" 
                accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation" 
                onChange={handleFileInput}
              />
              
              <div className="w-20 h-20 rounded-full bg-secondary/50 flex items-center justify-center mb-6">
                <UploadCloud className="w-10 h-10 text-primary" />
              </div>
              
              <h3 className="text-2xl font-semibold mb-2">Upload Presentation</h3>
              <p className="text-muted-foreground mb-6 max-w-md">
                Drag and drop your .pptx file here, or click to browse. We'll extract your slides so you can start recording immediately.
              </p>
              
              <Button size="lg" disabled={isUploading} className="pointer-events-none">
                {isUploading ? "Uploading & processing..." : "Select .pptx file"}
              </Button>
            </div>
          </Card>

          {(!isLoading && presentations && presentations.length > 0) && (
            <div className="space-y-6">
              <h3 className="text-xl font-semibold flex items-center gap-2">
                Recent Projects
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {presentations.map((p) => (
                  <Link href={`/editor/${p.id}`} key={p.id}>
                    <Card className="group cursor-pointer hover:border-primary/50 transition-colors h-full flex flex-col">
                      <CardHeader className="pb-3 flex-1">
                        <CardTitle className="line-clamp-1 text-base" title={p.filename}>{p.filename}</CardTitle>
                        <CardDescription>{new Date(p.createdAt).toLocaleDateString()}</CardDescription>
                      </CardHeader>
                      <CardContent className="pt-0 flex items-center justify-between mt-auto">
                        <div className="text-sm font-medium text-muted-foreground">
                          {p.slideCount} slide{p.slideCount !== 1 ? 's' : ''}
                        </div>
                        <div className="flex items-center gap-2">
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity" onClick={(e) => handleDelete(p.id, e)}>
                            <Trash2 className="w-4 h-4" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-primary">
                            <ArrowRight className="w-4 h-4" />
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
