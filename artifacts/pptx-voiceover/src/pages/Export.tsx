import { useEffect, useState } from "react";
import { useParams, Link } from "wouter";
import { FileVideo, ArrowLeft, Download, CheckCircle2, Loader2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  useGetPresentation,
  getGetPresentationQueryKey,
  useStartExport,
  useGetExportStatus,
  getGetExportStatusQueryKey,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";

export default function Export() {
  const { id } = useParams();
  const { toast } = useToast();
  const [isExporting, setIsExporting] = useState(false);

  const { data: presentation, isLoading: isPresLoading } = useGetPresentation(
    id as string,
    { query: { enabled: !!id, queryKey: getGetPresentationQueryKey(id as string) } }
  );

  const { data: exportJob } = useGetExportStatus(id as string, {
    query: {
      enabled: !!id && isExporting,
      queryKey: getGetExportStatusQueryKey(id as string),
      refetchInterval: isExporting ? 2000 : false,
    },
  });

  const startExport = useStartExport();

  useEffect(() => {
    if (!exportJob) return;
    if (exportJob.status === "done") {
      setIsExporting(false);
      toast({ title: "Export complete", description: "Your video is ready to download." });
    } else if (exportJob.status === "error") {
      setIsExporting(false);
      toast({
        title: "Export failed",
        description: exportJob.error || "Something went wrong.",
        variant: "destructive",
      });
    } else if (exportJob.status === "processing" || exportJob.status === "pending") {
      setIsExporting(true);
    }
  }, [exportJob?.status]);

  // Resume polling if a prior export is still in progress
  useEffect(() => {
    if (
      presentation?.exportStatus === "processing" ||
      presentation?.exportStatus === "pending"
    ) {
      setIsExporting(true);
    }
  }, [presentation?.exportStatus]);

  const handleExport = () => {
    if (!id) return;
    setIsExporting(true);
    startExport.mutate(
      { id },
      {
        onError: (err: unknown) => {
          setIsExporting(false);
          const msg =
            err && typeof err === "object" && "message" in err
              ? String((err as { message: string }).message)
              : "Could not start export.";
          toast({ title: "Export failed to start", description: msg, variant: "destructive" });
        },
      }
    );
  };

  if (isPresLoading || !presentation) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-muted-foreground animate-pulse">Loading…</div>
      </div>
    );
  }

  const recordedCount = presentation.slides.filter((s) => s.hasAudio).length;
  const totalSlides = presentation.slideCount;
  const noneRecorded = recordedCount === 0;
  const allRecorded = recordedCount === totalSlides;
  const exportDone = exportJob?.status === "done";

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <header className="h-14 border-b border-border bg-card flex items-center px-4 shrink-0 sticky top-0 z-10">
        <Link href={`/editor/${id}`}>
          <Button variant="ghost" size="sm" className="gap-2" data-testid="button-back-editor">
            <ArrowLeft className="w-4 h-4" />
            Back to Editor
          </Button>
        </Link>
        <div className="ml-4 font-semibold text-sm truncate max-w-xs text-muted-foreground">
          {presentation.filename}
        </div>
      </header>

      <main className="flex-1 container mx-auto px-4 py-10 max-w-2xl space-y-6">
        <h1 className="text-2xl font-bold" data-testid="text-export-title">Export Video</h1>

        {/* Summary */}
        <Card>
          <CardHeader>
            <CardTitle>Presentation Summary</CardTitle>
            <CardDescription>{presentation.filename}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid grid-cols-2 gap-4">
              <div className="rounded-lg bg-secondary/50 p-4 text-center">
                <div className="text-3xl font-bold text-primary" data-testid="text-total-slides">{totalSlides}</div>
                <div className="text-xs text-muted-foreground mt-1">Total Slides</div>
              </div>
              <div className="rounded-lg bg-secondary/50 p-4 text-center">
                <div
                  className={`text-3xl font-bold ${recordedCount > 0 ? "text-primary" : "text-muted-foreground"}`}
                  data-testid="text-recorded-slides"
                >
                  {recordedCount}
                </div>
                <div className="text-xs text-muted-foreground mt-1">Recorded</div>
              </div>
            </div>

            {!allRecorded && recordedCount > 0 && (
              <div className="flex items-start gap-2 text-sm text-amber-400 bg-amber-400/10 border border-amber-400/20 rounded-md p-3">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>
                  {totalSlides - recordedCount} slide{totalSlides - recordedCount > 1 ? "s" : ""} without a voiceover will be skipped in the export.
                </span>
              </div>
            )}

            {noneRecorded && (
              <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md p-3">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>
                  No voiceovers recorded yet. Go back to the editor and record at least one slide.
                </span>
              </div>
            )}

            {/* Slide grid */}
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                Slide Status
              </p>
              <div className="grid grid-cols-8 gap-1.5">
                {Array.from({ length: totalSlides }).map((_, i) => {
                  const slide = presentation.slides.find((s) => s.index === i);
                  return (
                    <div
                      key={i}
                      className={`aspect-square rounded flex items-center justify-center text-xs font-mono border ${
                        slide?.hasAudio
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border text-muted-foreground/50"
                      }`}
                      title={`Slide ${i + 1}: ${slide?.hasAudio ? "Recorded" : "No audio"}`}
                      data-testid={`slide-status-${i}`}
                    >
                      {i + 1}
                    </div>
                  );
                })}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Export action */}
        <Card className={exportDone ? "border-green-500/30 bg-green-500/5" : "border-primary/20 bg-primary/5"}>
          <CardContent className="pt-6">
            {exportDone ? (
              <div className="text-center py-4 space-y-4">
                <div className="w-14 h-14 rounded-full bg-green-500/20 text-green-400 flex items-center justify-center mx-auto">
                  <CheckCircle2 className="w-7 h-7" />
                </div>
                <div>
                  <h3 className="text-lg font-bold">Export Complete</h3>
                  <p className="text-sm text-muted-foreground mt-1">Your MP4 video is ready.</p>
                </div>
                <Button asChild size="lg" className="gap-2" data-testid="button-download">
                  <a
                    href={exportJob?.downloadUrl ?? `/api/presentations/${id}/export/download`}
                    download
                  >
                    <Download className="w-4 h-4" />
                    Download MP4
                  </a>
                </Button>
              </div>
            ) : isExporting ? (
              <div className="space-y-4 py-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2 font-medium">
                    <Loader2 className="w-4 h-4 animate-spin text-primary" />
                    Rendering video…
                  </span>
                  <span className="font-mono text-muted-foreground">
                    {exportJob?.progress ?? 0}%
                  </span>
                </div>
                <Progress value={exportJob?.progress ?? 0} className="h-2" data-testid="export-progress" />
                <p className="text-xs text-center text-muted-foreground">
                  This can take a minute. You can keep this tab open.
                </p>
              </div>
            ) : (
              <div className="text-center space-y-3 py-2">
                <Button
                  size="lg"
                  className="w-full h-12 gap-2 text-base"
                  onClick={handleExport}
                  disabled={noneRecorded || startExport.isPending}
                  data-testid="button-start-export"
                >
                  <FileVideo className="w-5 h-5" />
                  Export MP4 Video
                </Button>
                <p className="text-xs text-muted-foreground">
                  Generates a 1280×720 MP4 with each recorded slide's voiceover.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
