"use client";

import { useState } from "react";
import { Header } from "./header";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { X, AlertTriangle } from "lucide-react";
import { getApiClient } from "@/lib/api-client";
import { useLiveState } from "@/lib/hooks";

type AdminAction = "pause" | "resume" | "wipe" | null;

export function SettingsPage() {
  const { refetch: refetchStats } = useLiveState();
  const [activeAction, setActiveAction] = useState<AdminAction>(null);
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const closeDialog = () => {
    setActiveAction(null);
    setPassword("");
    setError(null);
    setSuccess(null);
  };

  const handleActionClick = (action: AdminAction) => {
    setActiveAction(action);
    setPassword("");
    setError(null);
    setSuccess(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) {
      setError("Admin password is required.");
      return;
    }

    setLoading(true);
    setError(null);
    setSuccess(null);

    const api = getApiClient();
    try {
      if (activeAction === "pause") {
        await api.pauseSystem(password);
        setSuccess("Engine successfully paused.");
      } else if (activeAction === "resume") {
        await api.resumeSystem(password);
        setSuccess("Engine successfully resumed.");
      } else if (activeAction === "wipe") {
        await api.wipeSystem(password);
        setSuccess("Database wiped. Engine is paused — resume to start trading.");
      }

      await refetchStats();

      setTimeout(() => {
        closeDialog();
      }, 1500);
    } catch (err: any) {
      setError(err.message || "Failed to execute action. Invalid password?");
    } finally {
      setLoading(false);
    }
  };

  const getActionTitle = () => {
    switch (activeAction) {
      case "pause": return "Pause Engine";
      case "resume": return "Resume Engine";
      case "wipe": return "Wipe Database";
      default: return "";
    }
  };

  return (
    <div className="min-h-screen bg-background flex flex-col font-mono text-foreground overflow-x-hidden selection:bg-primary/20">
      <Header />
      
      <main className="flex-1 container mx-auto px-4 py-6 md:py-8 max-w-4xl flex flex-col gap-6">
        <div className="space-y-1">
          <h2 className="text-xl font-bold tracking-tight">SETTINGS</h2>
          <p className="text-xs text-muted-foreground">Manage administrative controls and system configuration.</p>
        </div>

        {success && !activeAction && (
          <div className="p-4 bg-emerald-500/10 border border-emerald-500/20 text-emerald-500 text-sm rounded-md">
            {success}
          </div>
        )}

        <div className="border border-border/40 rounded-xl overflow-hidden bg-card/40 backdrop-blur-sm">
          <div className="px-5 py-4 border-b border-border/20 bg-muted/20">
            <h3 className="text-sm font-semibold tracking-wider text-foreground">ADMIN CONTROLS</h3>
          </div>
          
          <div className="p-5 flex flex-col gap-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 border border-border/20 rounded-lg bg-background/50">
              <div className="space-y-1">
                <div className="text-sm font-semibold text-foreground">Pause Engine</div>
                <div className="text-xs text-muted-foreground">Stops new trades from executing. Existing positions will still be tracked.</div>
              </div>
              <button 
                onClick={() => handleActionClick("pause")}
                className="px-4 py-2 bg-amber-500/10 hover:bg-amber-500/20 text-amber-500 border border-amber-500/20 rounded text-xs font-bold transition-colors whitespace-nowrap"
              >
                PAUSE ENGINE
              </button>
            </div>

            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 border border-border/20 rounded-lg bg-background/50">
              <div className="space-y-1">
                <div className="text-sm font-semibold text-foreground">Resume Engine</div>
                <div className="text-xs text-muted-foreground">Re-enables the strategy engine to scan for and execute new trades.</div>
              </div>
              <button 
                onClick={() => handleActionClick("resume")}
                className="px-4 py-2 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-500 border border-emerald-500/20 rounded text-xs font-bold transition-colors whitespace-nowrap"
              >
                RESUME ENGINE
              </button>
            </div>

            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 border border-red-500/20 rounded-lg bg-red-500/5">
              <div className="space-y-1">
                <div className="text-sm font-semibold text-red-500">Wipe Database</div>
                <div className="text-xs text-red-500/70">Permanently deletes all trades, resets portfolio, and halts the engine.</div>
              </div>
              <button 
                onClick={() => handleActionClick("wipe")}
                className="px-4 py-2 bg-red-500 hover:bg-red-600 text-white rounded text-xs font-bold transition-colors whitespace-nowrap"
              >
                WIPE DATABASE
              </button>
            </div>
          </div>
        </div>
      </main>

      <Dialog open={!!activeAction} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent className="sm:max-w-md bg-background border-border p-0 gap-0 overflow-hidden font-mono rounded-xl">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border/40 bg-muted/20">
            <DialogTitle className="text-sm font-bold text-foreground flex items-center gap-2">
              {activeAction === "wipe" && <AlertTriangle className="w-4 h-4 text-red-500" />}
              {getActionTitle()}
            </DialogTitle>
            <button
              onClick={closeDialog}
              className="p-1 hover:bg-muted/50 rounded-md transition-colors"
            >
              <X className="w-4 h-4 text-muted-foreground" />
            </button>
          </div>
          
          <div className="p-5">
            {activeAction === "wipe" && (
              <div className="mb-6 p-3 bg-red-500/10 border border-red-500/20 rounded-md text-red-400 text-xs leading-relaxed">
                <strong className="block mb-1 text-red-500">WARNING: DESTRUCTIVE ACTION</strong>
                This action is irreversible. It will permanently delete all trades, market history, and portfolio data. The engine will be paused automatically.
              </div>
            )}
            
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <label className="text-xs text-muted-foreground tracking-wider uppercase">Admin Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={loading || !!success}
                  className="w-full bg-background border border-border/40 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/50 transition-all placeholder:text-muted-foreground/30"
                  placeholder="••••••••••••"
                  autoFocus
                />
              </div>

              {error && (
                <div className="text-xs text-red-500 bg-red-500/10 p-2 rounded">
                  {error}
                </div>
              )}
              
              {success && (
                <div className="text-xs text-emerald-500 bg-emerald-500/10 p-2 rounded">
                  {success}
                </div>
              )}

              <div className="pt-2 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={closeDialog}
                  disabled={loading || !!success}
                  className="px-4 py-2 text-xs font-bold text-muted-foreground hover:text-foreground transition-colors"
                >
                  CANCEL
                </button>
                <button
                  type="submit"
                  disabled={loading || !!success || !password}
                  className={`px-4 py-2 text-xs font-bold rounded transition-colors ${
                    activeAction === "wipe" 
                      ? "bg-red-500 hover:bg-red-600 text-white disabled:bg-red-500/50" 
                      : "bg-primary hover:bg-primary/90 text-primary-foreground disabled:bg-primary/50"
                  }`}
                >
                  {loading ? "EXECUTING..." : "CONFIRM"}
                </button>
              </div>
            </form>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
