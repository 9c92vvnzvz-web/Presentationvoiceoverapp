import React, { useEffect, useState } from "react";
import { useParams, Link } from "wouter";
import { FileVideo, ArrowLeft, Download, CheckCircle2, Circle, Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { 
  useGetPresentation, 
  getGetPresentationQueryKey, 
  useStartExport,
  useGetExportStatus
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";

export default function Export() {
  const { id } = useParams();
  const { toast } = useToast();
  const [isExporting, setIsExporting] = useState(false);

  const { data: presentation, isLoading: isPresLoading } = useGetPresentation(id as string, {
    query: { enabled: !!id, queryKey: getGetPresentationQueryKey(id as string) }
  });

  const { data: exportJob } = useGetExportStatus(id as string, {
    query: { 
      enabled: !!id && isExporting,
      refetchInterval: isExporting ? 2000 : false
    }
  });

  const startExport = useStartExport();

  useEffect(() => {
    if (exportJob?.status === 'done') {
      setIsExporting(false);
      toast({ title: "Export complete", description: "Your video is ready to download." });
    } else if (exportJob?.status === 'error') {
      setIsExporting(false);
      toast({ title: "Export failed", description: exportJob.error || "Something went wrong.", variant: "destructive" });
    } else if (exportJob?.status === 'processing' || exportJob?.status === 'pending') {
      setIsExporting(true);
    }
  }, [exportJob?.status, toast]);

  // Initial check if an export is already running
  useEffect(() => {
    if (presentation?.exportStatus === 'processing' || presentation?.exportStatus === 'pending') {
      setIsExporting(true);
    }
  }, [presentation?.exportStatus]);

  const handleExport = () => {
    if (!id) return;
    setIsExporting(true);
    startExport.mutate({ id }, {
      onError: () => {
        setIsExporting(false);
        toast({ title: "Failed to start export", variant: "destructive" });
      }
    });
  };

  if (isPresLoading || !presentation) {
    return <div className="min-h-screen flex items-center justify-center"><p>Loading...</p></div>;
  }

  const recordedSlidesCount = presentation.slides.filter(s => s.hasAudio).length;
  const allSlidesRecorded = recordedSlidesCount === presentation.slideCount;

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <header className="h-14 border-b border-border bg-card flex items-center px-4 shrink-0 sticky top-0">
        <Link href={`/editor/${id}`}>
          <Button variant="ghost" size="sm" className="gap-2">
            <ArrowLeft className="w-4 h-4" />
            Back to Editor
          </Button>
        </Link>
      </header>

      <main className="flex-1 container mx-auto px-4 py-12 max-w-3xl">
        <h1 className="text-3xl font-bold mb-8">Export Project</h1>

        <div className="grid gap-8">
          
          <Card>
            <CardHeader>
              <CardTitle>Project Summary</CardTitle>
              <CardDescription>{presentation.filename}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between mb-6 p-4 rounded-lg bg-secondary/50">
                <div className="text-center flex-1">
                  <div className="text-3xl font-bold text-primary">{presentation.slideCount}</div>
                  <div className="text-sm text-muted-foreground">Total Slides</div>
                </div>
                <div className="w-px h-12 bg-border"></div>
                <div className="text-center flex-1">
                  <div className="text-3xl font-bold text-primary">{recordedSlidesCount}</div>
                  <div className="text-sm text-muted-foreground">Recorded Slides</div>
                </div>
              </div>

              {!allSlidesRecorded && (
                <div className="text-sm text-amber-500 bg-amber-500/10 p-3 rounded-md mb-6">
                  Warning: You have {presentation.slideCount - recordedSlidesCount} slides without voiceover. They will appear silently in the final video.
                </div>
              )}

              <div className="space-y-3">
                <h4 className="font-medium text-sm text-muted-foreground mb-2">Slide Status</h4>
                <div className="grid grid-cols-5 md:grid-cols-8 lg:grid-cols-10 gap-2">
                  {Array.from({ length: presentation.slideCount }).map((_, i) => {
                    const hasAudio = presentation.slides.find(s => s.index === i)?.hasAudio;
                    return (
                      <div 
                        key={i} 
                        className={`aspect-square rounded-md flex items-center justify-center font-mono text-sm border-2 ${hasAudio ? 'border-primary text-primary bg-primary/10' : 'border-border text-muted-foreground'}`}
                        title={`Slide ${i + 1}: ${hasAudio ? 'Recorded' : 'Empty'}`}
                      >
                        {i + 1}
                      </div>
                    );
                  })}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="border-primary/20 bg-primary/5">
            <CardContent className="pt-6">
              
              {exportJob?.status === 'done' ? (
                <div className="text-center py-6">
                  <div className="w-16 h-16 rounded-full bg-green-500/20 text-green-500 flex items-center justify-center mx-auto mb-4">
                    <CheckCircle2 className="w-8 h-8" />
                  </div>
                  <h3 className="text-xl font-bold mb-2">Export Complete!</h3>
                  <p className="text-muted-foreground mb-6">Your video is ready to download.</p>
                  
                  <Button asChild size="lg" className="gap-2">
                    <a href={exportJob.downloadUrl || `/api/presentations/${id}/export/download`} download>
                      <Download className="w-5 h-5" />
                      Download MP4 Video
                    </a>
                  </Button>
                </div>
              ) : (
                <div className="flex flex-col items-center py-4">
                  
                  <div className="w-full max-w-md space-y-6">
                    {isExporting ? (
                      <div className="space-y-4">
                        <div className="flex items-center justify-between text-sm">
                          <span className="font-medium flex items-center gap-2">
                            <Loader2 className="w-4 h-4 animate-spin text-primary" />
                            Rendering video...
                          </span>
                          <span className="text-muted-foreground font-mono">
                            {exportJob?.progress ? Math.round(exportJob.progress) : 0}%
                          </span>
                        </div>
                        <Progress value={exportJob?.progress || 0} className="h-2" />
                        <p className="text-xs text-center text-muted-foreground">
                          This may take a few minutes depending on presentation length.
                        </p>
                      </div>
                    ) : (
                      <div className="text-center">
                        <Button 
                          size="lg" 
                          className="w-full text-lg h-14 gap-2" 
                          onClick={handleExport}
                        >
                          <FileVideo className="w-6 h-6" />
                          Start Video Export
                        </Button>
                        <p className="text-sm text-muted-foreground mt-4">
                          Renders an MP4 video at 1080p, synchronizing your voiceovers with the slides.
                        </p>
                      </div>
                    )}
                  </div>

                </div>
              )}

            </CardContent>
          </Card>

        </div>
      </main>
    </div>
  );
}
