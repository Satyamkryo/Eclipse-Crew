export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  try {
    const { startRoutineScheduler } = await import("./lib/routines/scheduler");
    await startRoutineScheduler();
  } catch {
    console.error("Routine scheduler failed to start; scheduled routines are paused.");
  }
}
