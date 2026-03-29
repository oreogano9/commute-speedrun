import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Clock,
  Car,
  ParkingCircle,
  Bus,
  Flag,
  RotateCcw,
  Timer,
  Home,
  Building2,
  Save,
  History,
  TrendingUp,
  Zap,
  AlertCircle,
  Trash2,
  Download,
  Upload,
  AlertTriangle,
  X,
  ChevronDown,
  Flame,
  Rabbit
} from 'lucide-react';
import {
  initializeApp,
  getApps,
  type FirebaseApp
} from 'firebase/app';
import {
  getAuth,
  onAuthStateChanged,
  signInAnonymously
} from 'firebase/auth';
import {
  getFirestore,
  collection,
  addDoc,
  onSnapshot,
  doc,
  deleteDoc
} from 'firebase/firestore';

type Mode = 'forward' | 'reverse';
type StatsMode = Mode | 'combined';
type SegmentMap = Record<string, Date>;

type RunRecord = {
  id: string;
  category?: string;
  mode: Mode;
  totalMs: number;
  date: Date;
  segments: SegmentMap;
};

type Step = {
  id: string;
  label: string;
  segment?: string;
  icon: React.ReactElement;
};

type SegmentPrediction = {
  label: string;
  avgMs: number;
  sampleCount: number;
};

const firebaseConfigEnv = import.meta.env.VITE_FIREBASE_CONFIG as string | undefined;
const appId = (import.meta.env.VITE_FIREBASE_APP_ID as string | undefined) ?? 'commute-speedrun';
const usingFirebase = Boolean(firebaseConfigEnv && firebaseConfigEnv.trim().length > 0);

const colorMap: Record<string, string> = {
  Driving: 'border-orange-500/30 bg-orange-500/10 text-orange-200',
  'Driving Home': 'border-orange-500/30 bg-orange-500/10 text-orange-200',
  'Walk to Stop': 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
  'Wait for Bus': 'border-sky-500/30 bg-sky-500/10 text-sky-200',
  'Bus Transit': 'border-violet-500/30 bg-violet-500/10 text-violet-200',
  'Walk to Office': 'border-rose-500/30 bg-rose-500/10 text-rose-200',
  'Walk to Car': 'border-rose-500/30 bg-rose-500/10 text-rose-200',
  'Walk to 2nd Stop': 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
  'Wait for 2nd Bus': 'border-sky-500/30 bg-sky-500/10 text-sky-200',
  '2nd Bus Transit': 'border-violet-500/30 bg-violet-500/10 text-violet-200',
  'Total Trip': 'bg-slate-950 text-white border-slate-800'
};

const forwardSteps: Step[] = [
  { id: 'car', label: 'Got in Car', icon: <Car />, segment: 'Driving' },
  { id: 'parking', label: 'Arrived at Parking', icon: <ParkingCircle />, segment: 'Walk to Stop' },
  { id: 'busStop', label: 'At Bus Stop', icon: <Clock />, segment: 'Wait for Bus' },
  { id: 'busArrival', label: 'Bus Arrived', icon: <Bus />, segment: 'Bus Transit' },
  { id: 'busDest', label: 'Bus Destination', icon: <Timer />, segment: 'Walk to Office' },
  { id: 'checkpoint', label: 'At Checkpoint', icon: <Flag /> }
];

const reverseSteps: Step[] = [
  { id: 'checkpoint', label: 'Leave Checkpoint', icon: <Flag />, segment: 'Walk to Stop' },
  { id: 'busDest', label: 'At Bus Stop', icon: <Clock />, segment: 'Wait for Bus' },
  { id: 'busArrival', label: 'Bus Arrived', icon: <Bus />, segment: 'Bus Transit' },
  { id: 'busStop', label: 'Arrived at Parking', icon: <Timer />, segment: 'Walk to Car' },
  { id: 'parking', label: 'At Car', icon: <ParkingCircle />, segment: 'Driving Home' },
  { id: 'car', label: 'Got Home', icon: <Home /> }
];

const getSteps = (m: Mode) => (m === 'forward' ? forwardSteps : reverseSteps);

const supportedStepIds = new Set([...forwardSteps, ...reverseSteps].map((step) => step.id));
const canonicalSegmentIndexByMode: Record<Mode, number[]> = {
  forward: [0, 1, 2, 3, 4],
  reverse: [4, 2, 3, 1, 0]
};

const storageKey = 'csr_runs_v1';
const localUserKey = 'csr_user_id';
const inProgressKey = 'csr_in_progress_v1';

const getDurationInMs = (start?: Date, end?: Date) => {
  if (!start || !end) return null;
  return Math.max(0, end.getTime() - start.getTime());
};

const getDisplayedSegmentName = (steps: Step[], index: number) => {
  const step = steps[index];
  if (!step) return '';
  return step.segment ?? step.label;
};

const getMinutesIntoDay = (date: Date) => date.getHours() * 60 + date.getMinutes();

const getCircularMinuteDistance = (a: number, b: number) => {
  const diff = Math.abs(a - b);
  return Math.min(diff, 1440 - diff);
};

const getRunStartTime = (run: RunRecord) => {
  const steps = getSteps(run.mode);
  return run.segments[steps[0].id] ?? run.date;
};

const isNightRun = (run: Pick<RunRecord, 'category'>) => run.category === 'night';

const getAlignedDurations = (run: RunRecord, targetMode: Mode): Array<number | null> | null => {
  if (isNightRun(run)) return null;

  const runSteps = getSteps(run.mode);
  const runSlots = canonicalSegmentIndexByMode[run.mode];
  const targetSlots = canonicalSegmentIndexByMode[targetMode];
  const byCanonicalSlot: Array<number | null> = new Array(runSlots.length).fill(null);

  runSteps.slice(0, -1).forEach((step, index) => {
    const duration = getDurationInMs(run.segments[step.id], run.segments[runSteps[index + 1].id]);
    if (duration === null) return;
    byCanonicalSlot[runSlots[index]] = duration;
  });

  if (byCanonicalSlot.some((duration) => duration === null)) return null;
  return targetSlots.map((slot) => byCanonicalSlot[slot]);
};

const getStatsSteps = (mode: StatsMode) => getSteps(mode === 'combined' ? 'forward' : mode);

const formatDuration = (ms?: number | null) => {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '--';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const millis = Math.floor((ms % 1000) / 10);
  return `${minutes}:${seconds.toString().padStart(2, '0')}.${millis.toString().padStart(2, '0')}`;
};

const formatDurationCompact = (ms?: number | null) => {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '--';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
};

const DurationDisplay = ({ ms }: { ms?: number | null }) => {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return <span>--</span>;
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const millis = Math.floor((ms % 1000) / 10);
  return (
    <>
      {minutes}:{seconds.toString().padStart(2, '0')}
      <span style={{ fontSize: '0.55em', opacity: 0.75 }}>.{millis.toString().padStart(2, '0')}</span>
    </>
  );
};

const formatClock = (date: Date) =>
  new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(date);

const formatFullDate = (date: Date) =>
  new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date);

const formatArrivalTime = (date: Date) =>
  new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date);

const parseDate = (val: unknown) => {
  if (!val) return new Date();
  if (val instanceof Date) return val;
  if (typeof val === 'object' && val !== null && 'seconds' in val) {
    const raw = val as { seconds: number; nanoseconds?: number };
    return new Date(raw.seconds * 1000 + (raw.nanoseconds ?? 0) / 1000000);
  }
  if (typeof val === 'object' && val !== null && '_seconds' in val) {
    const raw = val as { _seconds: number; _nanoseconds?: number };
    return new Date(raw._seconds * 1000 + (raw._nanoseconds ?? 0) / 1000000);
  }
  const parsed = new Date(val as string);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
};

const loadLocalRuns = (): RunRecord[] => {
  const raw = localStorage.getItem(storageKey);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Array<Omit<RunRecord, 'date' | 'segments'> & {
      date: string;
      category?: string;
      segments: Record<string, string>;
    }>;
    return parsed
      .filter((run) => run.category !== 'night')
      .map((run) => ({
      ...run,
      date: new Date(run.date),
      segments: Object.fromEntries(
        Object.entries(run.segments).map(([key, value]) => [key, new Date(value)])
      )
    }));
  } catch {
    return [];
  }
};

const persistLocalRuns = (runs: RunRecord[]) => {
  const serialized = runs.map((run) => ({
    ...run,
    date: run.date.toISOString(),
    segments: Object.fromEntries(
      Object.entries(run.segments).map(([key, value]) => [key, value.toISOString()])
    )
  }));
  localStorage.setItem(storageKey, JSON.stringify(serialized));
};


const ensureLocalUser = () => {
  const existing = localStorage.getItem(localUserKey);
  if (existing) return existing;
  const id = crypto.randomUUID ? crypto.randomUUID() : `local-${Date.now()}`;
  localStorage.setItem(localUserKey, id);
  return id;
};

const App = () => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [userId, setUserId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('forward');
  const [segments, setSegments] = useState<SegmentMap>({});
  const [editingSegment, setEditingSegment] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [expandedSegment, setExpandedSegment] = useState<string | null>(null);
  const [showCharts, setShowCharts] = useState(false);
  const [history, setHistory] = useState<RunRecord[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [statsViewMode, setStatsViewMode] = useState<StatsMode>('forward');
  const [liveNow, setLiveNow] = useState<Date>(new Date());
  const timeOfDayMinutes = useMemo(() => getMinutesIntoDay(liveNow), [liveNow]);

  const firebaseApp = useMemo<FirebaseApp | null>(() => {
    if (!usingFirebase || !firebaseConfigEnv) return null;
    const parsed = JSON.parse(firebaseConfigEnv);
    if (getApps().length) return getApps()[0]!;
    return initializeApp(parsed);
  }, []);

  const auth = firebaseApp ? getAuth(firebaseApp) : null;
  const db = firebaseApp ? getFirestore(firebaseApp) : null;

  useEffect(() => {
    const interval = setInterval(() => setLiveNow(new Date()), 50);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const raw = localStorage.getItem(inProgressKey);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as { mode: Mode; segments: Record<string, string> };
      if (parsed?.segments && Object.keys(parsed.segments).length > 0) {
        const hasUnsupportedSteps = Object.keys(parsed.segments).some((stepId) => !supportedStepIds.has(stepId));
        if (hasUnsupportedSteps) {
          localStorage.removeItem(inProgressKey);
          return;
        }
        setMode(parsed.mode);
        setSegments(
          Object.fromEntries(
            Object.entries(parsed.segments).map(([key, value]) => [key, new Date(value)])
          )
        );
      }
    } catch {
      localStorage.removeItem(inProgressKey);
    }
  }, []);

  useEffect(() => {
    if (!usingFirebase) {
      const id = ensureLocalUser();
      setUserId(id);
      const localRuns = loadLocalRuns();
      setHistory(localRuns);
      return;
    }

    if (!auth) return;
    signInAnonymously(auth).catch(() => undefined);
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setUserId(user?.uid ?? null);
    });
    return () => unsubscribe();
  }, [auth]);

  useEffect(() => {
    if (!usingFirebase || !db || !userId) return;
    const q = collection(db, 'artifacts', appId, 'users', userId, 'runs');
    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const docs = snapshot.docs.map((snap) => ({
          id: snap.id,
          ...(snap.data() as Omit<RunRecord, 'id' | 'date' | 'segments'> & {
            date?: unknown;
            segments?: Record<string, unknown>;
          }),
          category: snap.data().category as string | undefined,
          date: parseDate(snap.data().date),
          segments: Object.fromEntries(
            Object.entries(snap.data().segments ?? {}).map(([key, value]) => [
              key,
              parseDate(value)
            ])
          )
        }));
        setHistory((docs as RunRecord[]).filter((run) => !isNightRun(run)));
      },
      () => undefined
    );
    return () => unsubscribe();
  }, [db, userId]);

  const currentSteps = getSteps(mode);
  const nextStepIndex = currentSteps.findIndex((step) => !segments[step.id]);
  const isFinished = nextStepIndex === -1 && Object.keys(segments).length > 0;

  const totalTimeMs = useMemo(() => {
    const first = segments[currentSteps[0].id];
    const last = segments[currentSteps[currentSteps.length - 1].id];
    if (first && !last) return getDurationInMs(first, liveNow) ?? null;
    return getDurationInMs(first, last);
  }, [segments, currentSteps, liveNow]);

  useEffect(() => {
    if (Object.keys(segments).length === 0 || isFinished) {
      localStorage.removeItem(inProgressKey);
      return;
    }
    const serialized = {
      mode,
      segments: Object.fromEntries(
        Object.entries(segments).map(([key, value]) => [key, value.toISOString()])
      )
    };
    localStorage.setItem(inProgressKey, JSON.stringify(serialized));
  }, [segments, mode, isFinished]);

  const comparableRunsByMode = useMemo(() => {
    const result: Record<Mode, Array<{ run: RunRecord; durations: Array<number | null> }>> = {
      forward: [],
      reverse: []
    };

    history.forEach((run) => {
      if (isNightRun(run)) return;
      (['forward', 'reverse'] as Mode[]).forEach((targetMode) => {
        const durations = getAlignedDurations(run, targetMode);
        if (!durations) return;
        result[targetMode].push({ run, durations });
      });
    });

    return result;
  }, [history]);

  const directRunsByMode = useMemo(() => {
    return {
      forward: history.filter((run) => !isNightRun(run) && run.mode === 'forward'),
      reverse: history.filter((run) => !isNightRun(run) && run.mode === 'reverse')
    } satisfies Record<Mode, RunRecord[]>;
  }, [history]);

  const detailedStats = useMemo(() => {
    const results: Partial<Record<StatsMode, { label: string; avg: number; best: number; worst: number }[]>> = {};

    (['forward', 'reverse'] as Mode[]).forEach((targetMode) => {
      const runs = directRunsByMode[targetMode];
      if (!runs.length) return;

      const steps = getSteps(targetMode);
      const stats = steps.slice(0, -1).map((step, index) => {
        const nextStep = steps[index + 1];
        const durations = runs
          .map((run) => getDurationInMs(run.segments[step.id], run.segments[nextStep.id]))
          .filter((value): value is number => value !== null);
        if (!durations.length) return null;
        return {
          label: step.segment ?? step.label,
          avg: Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length),
          best: Math.min(...durations),
          worst: Math.max(...durations)
        };
      }).filter((value): value is { label: string; avg: number; best: number; worst: number } => value !== null);

      const totalDurations = runs.map((run) => run.totalMs);
      if (totalDurations.length) {
        stats.push({
          label: 'Total Trip',
          avg: Math.round(totalDurations.reduce((sum, value) => sum + value, 0) / totalDurations.length),
          best: Math.min(...totalDurations),
          worst: Math.max(...totalDurations)
        });
      }

      results[targetMode] = stats;
    });

    const combinedRuns = comparableRunsByMode.forward;
    if (combinedRuns.length) {
      const steps = getStatsSteps('combined');
      const combinedStats = steps.slice(0, -1).map((step, index) => {
        const durations = combinedRuns
          .map(({ durations: alignedDurations }) => alignedDurations[index])
          .filter((value): value is number => value !== null);
        if (!durations.length) return null;
        return {
          label: step.segment ?? step.label,
          avg: Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length),
          best: Math.min(...durations),
          worst: Math.max(...durations)
        };
      }).filter((value): value is { label: string; avg: number; best: number; worst: number } => value !== null);

      const totalDurations = combinedRuns.map(({ run }) => run.totalMs);
      if (totalDurations.length) {
        combinedStats.push({
          label: 'Total Trip',
          avg: Math.round(totalDurations.reduce((sum, value) => sum + value, 0) / totalDurations.length),
          best: Math.min(...totalDurations),
          worst: Math.max(...totalDurations)
        });
      }

      results.combined = combinedStats;
    }

    return results;
  }, [comparableRunsByMode, directRunsByMode]);

  const personalBest = useMemo(() => {
    const modeRuns = history.filter((run) => !isNightRun(run) && run.mode === mode);
    if (!modeRuns.length) return null;
    return Math.min(...modeRuns.map((run) => run.totalMs));
  }, [history, mode]);

  const predictiveRuns = useMemo(() => {
    return history.filter((run) => !isNightRun(run) && run.mode === mode);
  }, [history, mode]);

  const goldSplits = useMemo(() => {
    const gold: Record<string, number> = {};
    comparableRunsByMode[mode].forEach(({ durations }) => {
      currentSteps.slice(0, -1).forEach((step, idx) => {
        const duration = durations[idx];
        if (duration === null) return;
        if (!gold[step.id] || duration < gold[step.id]) {
          gold[step.id] = duration;
        }
      });
    });
    return gold;
  }, [comparableRunsByMode, mode, currentSteps]);

  const averageSplits = useMemo(() => {
    const averages: Record<string, SegmentPrediction> = {};

    currentSteps.slice(0, -1).forEach((step, idx) => {
      let weightedSum = 0;
      let weightTotal = 0;
      let sampleCount = 0;

      predictiveRuns.forEach((run) => {
        const nextStep = currentSteps[idx + 1];
        const duration = getDurationInMs(run.segments[step.id], run.segments[nextStep.id]);
        if (duration === null) return;
        const timeWeight = 1 / (1 + getCircularMinuteDistance(getMinutesIntoDay(getRunStartTime(run)), timeOfDayMinutes) / 45);
        weightedSum += duration * timeWeight;
        weightTotal += timeWeight;
        sampleCount += 1;
      });

      if (!weightTotal || !sampleCount) return;

      averages[step.id] = {
        label: step.segment ?? step.label,
        avgMs: Math.round(weightedSum / weightTotal),
        sampleCount
      };
    });

    return averages;
  }, [predictiveRuns, currentSteps, timeOfDayMinutes]);

  const livePrediction = useMemo(() => {
    const hasStarted = Object.keys(segments).length > 0;

    let remainingMs = 0;
    let contributingSegments = 0;
    let sampleFloor: number | null = null;
    
    if (!hasStarted) {
      for (const step of currentSteps.slice(0, -1)) {
        const prediction = averageSplits[step.id];
        if (!prediction) return null;
        remainingMs += prediction.avgMs;
        contributingSegments += 1;
        sampleFloor = sampleFloor === null ? prediction.sampleCount : Math.min(sampleFloor, prediction.sampleCount);
      }
    } else {
      let foundActiveSegment = false;
      for (let idx = 0; idx < currentSteps.length - 1; idx += 1) {
        const step = currentSteps[idx];
        const nextStep = currentSteps[idx + 1];
        const start = segments[step.id];
        const end = segments[nextStep.id];

        if (!start) continue;
        if (end) continue;

        const currentPrediction = averageSplits[step.id];
        if (!currentPrediction) return null;

        remainingMs += Math.max(0, currentPrediction.avgMs - (getDurationInMs(start, liveNow) ?? 0));
        contributingSegments += 1;
        sampleFloor = sampleFloor === null ? currentPrediction.sampleCount : Math.min(sampleFloor, currentPrediction.sampleCount);

        for (let futureIdx = idx + 1; futureIdx < currentSteps.length - 1; futureIdx += 1) {
          const futurePrediction = averageSplits[currentSteps[futureIdx].id];
          if (!futurePrediction) return null;
          remainingMs += futurePrediction.avgMs;
          contributingSegments += 1;
          sampleFloor = sampleFloor === null ? futurePrediction.sampleCount : Math.min(sampleFloor, futurePrediction.sampleCount);
        }

        foundActiveSegment = true;
        break;
      }

      if (!foundActiveSegment) return null;
    }

    if (contributingSegments === 0) return null;

    const eta = new Date(liveNow.getTime() + remainingMs);
    return {
      eta,
      remainingMs,
      contributingSegments,
      sampleFloor
    };
  }, [segments, currentSteps, averageSplits, liveNow]);

  const logTime = (stepId: string) => {
    setSegments((prev) => ({ ...prev, [stepId]: new Date() }));
  };

  const reset = () => {
    if (Object.keys(segments).length > 0 && !isFinished) {
      if (!confirm('Discard current progress?')) return;
    }
    setSegments({});
    localStorage.removeItem(inProgressKey);
  };

  const deleteSegment = (stepId: string) => {
    setSegments((prev) => {
      const updated = { ...prev };
      delete updated[stepId];
      return updated;
    });
  };

  const adjustSegment = (stepId: string, deltaMs: number) => {
    setSegments((prev) => {
      if (!prev[stepId]) return prev;
      return { ...prev, [stepId]: new Date(prev[stepId].getTime() + deltaMs) };
    });
  };

  const commitEditingSegment = (stepId: string) => {
    // Parse HH:MM:SS or MM:SS or H:MM:SS etc.
    const parts = editingValue.trim().split(':').map(Number);
    if (parts.some(isNaN) || parts.length < 2 || parts.length > 3) {
      setEditingSegment(null);
      return;
    }
    const [h, m, s] = parts.length === 3 ? parts : [0, ...parts];
    const existing = segments[stepId];
    if (!existing) { setEditingSegment(null); return; }
    const newDate = new Date(existing);
    newDate.setHours(h, m, Math.floor(s), (s % 1) * 1000);
    setSegments((prev) => ({ ...prev, [stepId]: newDate }));
    setEditingSegment(null);
  };

  const saveRun = async () => {
    if (!userId || isSaving || !isFinished) return;
    setIsSaving(true);
    try {
      const run: RunRecord = {
        id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}`,
        mode,
        totalMs: totalTimeMs ?? 0,
        date: new Date(),
        segments: Object.keys(segments).reduce<SegmentMap>((acc, key) => {
          acc[key] = segments[key];
          return acc;
        }, {})
      };

      if (usingFirebase && db) {
        await addDoc(collection(db, 'artifacts', appId, 'users', userId, 'runs'), {
          mode: run.mode,
          totalMs: run.totalMs,
          date: run.date,
          segments: run.segments
        });
      } else {
        const updated = [run, ...history];
        setHistory(updated);
        persistLocalRuns(updated);
      }
      setSegments({});
      localStorage.removeItem(inProgressKey);
    } finally {
      setIsSaving(false);
    }
  };

  const deleteRun = async (id: string) => {
    if (!confirm('Delete this record?')) return;
    if (usingFirebase && db && userId) {
      await deleteDoc(doc(db, 'artifacts', appId, 'users', userId, 'runs', id));
      return;
    }
    const updated = history.filter((run) => run.id !== id);
    setHistory(updated);
    persistLocalRuns(updated);
  };

  const exportHistory = () => {
    const dataStr = JSON.stringify(history, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `commute_history_${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const importHistory = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !userId) return;

    setIsImporting(true);
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const importedData = JSON.parse(String(e.target?.result ?? '[]')) as Array<
          Partial<RunRecord>
        >;
        const cleaned = importedData.map((item) => {
          const cleanSegments: SegmentMap = {};
          if (item.segments) {
            Object.entries(item.segments).forEach(([key, val]) => {
              cleanSegments[key] = parseDate(val);
            });
          }
          return {
            id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}`,
            mode: (item.mode ?? 'forward') as Mode,
            totalMs: item.totalMs ?? 0,
            date: item.date ? new Date(item.date) : new Date(),
            segments: cleanSegments
          } as RunRecord;
        }).filter((item) => !isNightRun(item));

        if (usingFirebase && db) {
          for (const item of cleaned) {
            await addDoc(collection(db, 'artifacts', appId, 'users', userId, 'runs'), {
              mode: item.mode,
              totalMs: item.totalMs,
              date: item.date,
              segments: item.segments
            });
          }
        } else {
          const updated = [...cleaned, ...history];
          setHistory(updated);
          persistLocalRuns(updated);
        }
        alert(`Imported ${cleaned.length} records!`);
      } catch {
        alert('Import failed. Check file format.');
      } finally {
        setIsImporting(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    };
    reader.readAsText(file);
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const getDelta = (segmentId: string, duration: number | null) => {
    if (!duration || !goldSplits[segmentId]) return null;
    return duration - goldSplits[segmentId];
  };

  const handleModeSwitch = (nextMode: Mode) => {
    if (Object.keys(segments).length && !confirm('Reset split order?')) return;
    setLiveNow(new Date());
    setExpandedSegment(null);
    setEditingSegment(null);
    setEditingValue('');
    setMode(nextMode);
    setSegments({});
  };

  return (
    <div className="min-h-screen px-4 py-6 md:py-10 md:px-10">
      <div className="max-w-5xl mx-auto space-y-6">
        <header className="overflow-hidden rounded-[28px] border border-slate-800 bg-slate-900 shadow-xl">
          {/* Always-visible title row */}
          <div className="flex items-center gap-3 px-6 py-4">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-slate-800 text-white flex-shrink-0">
              <Timer className="h-5 w-5" />
            </div>
            <p className="flex-1 text-xs font-bold uppercase tracking-[0.35em] text-slate-400">Commute Speedrun</p>
            <button
              onClick={() => setShowHistory((prev) => !prev)}
              className={`flex h-10 w-10 items-center justify-center rounded-full border text-xs font-bold uppercase tracking-widest transition-all flex-shrink-0 ${
                showHistory
                  ? 'bg-slate-100 text-slate-900 border-slate-200'
                  : 'bg-slate-900/80 text-slate-400 border-slate-800 hover:text-slate-100'
              }`}
              aria-label={showHistory ? 'Back to Timer' : 'Run History'}
              title={showHistory ? 'Back to Timer' : 'Run History'}
            >
              <History className="h-4 w-4" />
            </button>
          </div>
          {/* Collapsible body */}
          <motion.div
            animate={{ height: showHistory ? 0 : 'auto', opacity: showHistory ? 0 : 1 }}
            transition={{ duration: 0.35, ease: [0.4, 0, 0.2, 1] }}
            style={{ overflow: 'hidden' }}
          >
          <div className="relative grid gap-6 px-6 pb-6 md:grid-cols-[1.1fr,0.9fr] md:items-center">
            <div className="space-y-3">
              <p className="text-sm text-slate-500 max-w-xl">
                Split your commute like a game run. Track gold segments, chase PBs, and
                export your runs to share.
              </p>
              <div className="flex flex-wrap gap-2">
                <span className="px-3 py-1 rounded-full bg-slate-900 text-white text-xs font-bold uppercase tracking-wide">
                  {mode === 'forward' ? 'To Work' : 'To Home'}
                </span>
                {personalBest && (
                  <span className="px-3 py-1 rounded-full bg-emerald-100 text-emerald-700 text-xs font-bold tracking-wide flex items-center gap-1">
                    <Flame className="h-3 w-3" /> PB <DurationDisplay ms={personalBest} />
                  </span>
                )}
                {!usingFirebase && (
                  <span className="px-3 py-1 rounded-full bg-slate-800 text-slate-400 text-xs font-semibold uppercase tracking-wide">
                    Local Mode
                  </span>
                )}
              </div>
            </div>
            <div className="flex flex-col gap-4">
              <div className="rounded-3xl border border-slate-800 bg-slate-950 text-white p-5 shadow-2xl">
                <div className="flex items-center justify-between text-xs uppercase tracking-[0.3em] text-slate-400">
                  <span>Live Time</span>
                  <span className="mono text-slate-400">{formatClock(liveNow)}</span>
                </div>
                <div className="mt-3 flex items-end justify-between">
                  <div className={`mono text-4xl md:text-5xl font-bold transition-colors ${Object.keys(segments).length === 0 ? 'text-slate-600' : 'text-cyan-300'}`}>
                    {Object.keys(segments).length === 0 ? '--:--' : <DurationDisplay ms={totalTimeMs} />}
                  </div>
                  <div className="text-right">
                    <div className="text-xs uppercase tracking-[0.3em] text-slate-400">
                      {Object.keys(segments).length === 0
                        ? 'Ready'
                        : isFinished
                          ? `${currentSteps.length} / ${currentSteps.length}`
                          : `Split ${nextStepIndex + 1} / ${currentSteps.length}`}
                    </div>
                    {Object.keys(segments).length === 0 && (
                      <p className="text-[9px] uppercase tracking-widest text-slate-600 mt-0.5">tap split to start</p>
                    )}
                  </div>
                </div>
                {/* Progress bar */}
                {Object.keys(segments).length > 0 && (
                  <div className="mt-4 h-1 rounded-full bg-slate-800 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-cyan-400 transition-all duration-300"
                      style={{
                        width: `${(Object.keys(segments).length / currentSteps.length) * 100}%`
                      }}
                    />
                  </div>
                )}
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <button
                  onClick={() => handleModeSwitch('forward')}
                  className={`flex items-center justify-center gap-2 rounded-2xl border px-4 py-3 text-xs font-bold uppercase tracking-widest ${
                    mode === 'forward'
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-slate-900/80 text-slate-400 border-slate-800'
                  }`}
                >
                  <Building2 className="h-4 w-4" />
                  Going to Work
                </button>
                <button
                  onClick={() => handleModeSwitch('reverse')}
                  className={`flex items-center justify-center gap-2 rounded-2xl border px-4 py-3 text-xs font-bold uppercase tracking-widest ${
                    mode === 'reverse'
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'bg-slate-900/80 text-slate-400 border-slate-800'
                  }`}
                >
                  <Home className="h-4 w-4" />
                  Going Home
                </button>
              </div>
            </div>
          </div>
          </motion.div>
        </header>

        <AnimatePresence mode="wait">
          {!showHistory ? (
            <motion.section
              key="tracker"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.4 }}
              className="grid gap-6 lg:grid-cols-[1.15fr,0.85fr]"
            >
              <div className="space-y-4">
                <div className="rounded-3xl border border-slate-800 bg-slate-900/80 p-4 shadow-lg">
                  <div className="flex items-center justify-between border-b border-slate-800/60 pb-3">
                    <div>
                      <p className="text-[10px] font-black uppercase tracking-[0.35em] text-slate-400">
                        Active Split Board
                      </p>
                      <h2 className="text-lg font-black text-slate-100">{mode === 'forward' ? 'Work Route' : 'Home Route'}</h2>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={reset}
                        className="rounded-xl border border-slate-800 bg-slate-900/80 p-2 text-slate-400 hover:text-rose-500"
                        title="Reset run"
                      >
                        <RotateCcw className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                  <div className="divide-y divide-slate-800/60">
                    {currentSteps.map((step, idx) => {
                      const timestamp = segments[step.id];
                      const isLogged = Boolean(timestamp);
                      const isNext = idx === nextStepIndex;
                      const duration =
                        idx < currentSteps.length - 1
                          ? getDurationInMs(segments[step.id], segments[currentSteps[idx + 1].id]) ??
                            (segments[step.id] ? getDurationInMs(segments[step.id], liveNow) : null)
                          : null;
                      const delta = duration ? getDelta(step.id, duration) : null;

                      return (
                        <div key={step.id} className={`${isNext ? 'bg-slate-800/60' : ''}`}>
                          <div className="flex items-center gap-4 p-4">
                            <div
                              className={`flex h-11 w-11 items-center justify-center rounded-2xl text-sm font-bold transition-all flex-shrink-0 ${
                                isLogged
                                  ? 'bg-emerald-100 text-emerald-600'
                                  : isNext
                                    ? 'bg-slate-900 text-white shadow-lg'
                                    : 'bg-slate-800/60 text-slate-500'
                              }`}
                            >
                              {React.cloneElement(step.icon, { size: 18 })}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className={`text-sm font-bold ${isLogged ? 'text-slate-300' : 'text-slate-100'}`}>
                                {getDisplayedSegmentName(currentSteps, idx)}
                              </p>
                              {step.segment && (
                                <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">
                                  Split at {step.label}
                                </p>
                              )}
                              {timestamp && (
                                editingSegment === step.id ? (
                                  <input
                                    autoFocus
                                    className="mono text-[10px] font-bold text-slate-100 bg-slate-700 rounded px-1 w-20 outline-none"
                                    value={editingValue}
                                    onChange={(e) => setEditingValue(e.target.value)}
                                    onBlur={() => commitEditingSegment(step.id)}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') commitEditingSegment(step.id);
                                      if (e.key === 'Escape') setEditingSegment(null);
                                    }}
                                  />
                                ) : (
                                  <p
                                    className="mono text-[10px] font-bold text-slate-400 cursor-pointer hover:text-slate-200 underline decoration-dotted"
                                    onClick={() => { setEditingSegment(step.id); setEditingValue(formatClock(timestamp)); }}
                                  >
                                    {formatClock(timestamp)}
                                  </p>
                                )
                              )}
                            </div>
                            <div className="text-right flex-shrink-0">
                              {duration !== null && (
                                <p className="mono text-xs font-bold text-slate-200"><DurationDisplay ms={duration} /></p>
                              )}
                              {delta !== null && (
                                <p className={`text-[10px] font-bold ${delta <= 0 ? 'text-emerald-600' : 'text-rose-500'}`}>
                                  {delta <= 0 ? '-' : '+'}
                                  {formatDurationCompact(Math.abs(delta))}
                                </p>
                              )}
                            </div>
                            {isLogged ? (
                              <button
                                onClick={() => setExpandedSegment(expandedSegment === step.id ? null : step.id)}
                                className="p-1.5 rounded-lg text-slate-500 hover:text-slate-300 flex-shrink-0"
                              >
                                <ChevronDown className={`h-4 w-4 transition-transform ${expandedSegment === step.id ? 'rotate-180' : ''}`} />
                              </button>
                            ) : (
                              <button
                                onClick={() => logTime(step.id)}
                                disabled={idx > nextStepIndex}
                                className={`px-4 py-2 rounded-xl text-[10px] font-black uppercase flex-shrink-0 ${
                                  isNext
                                    ? 'bg-slate-900 text-white'
                                    : 'bg-slate-800/60 text-slate-500 cursor-not-allowed'
                                }`}
                              >
                                Split
                              </button>
                            )}
                          </div>
                          {isLogged && expandedSegment === step.id && (
                            <div className="flex items-center gap-2 px-4 pb-4">
                              <button
                                onClick={() => adjustSegment(step.id, -30000)}
                                className="flex-1 py-2.5 rounded-xl text-xs font-black text-slate-300 bg-slate-800 active:bg-slate-700"
                              >
                                −30s
                              </button>
                              <button
                                onClick={() => adjustSegment(step.id, +30000)}
                                className="flex-1 py-2.5 rounded-xl text-xs font-black text-slate-300 bg-slate-800 active:bg-slate-700"
                              >
                                +30s
                              </button>
                              <button
                                onClick={() => { deleteSegment(step.id); setExpandedSegment(null); }}
                                className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-xs font-black text-rose-400 bg-slate-800 active:bg-slate-700"
                              >
                                <X className="h-3.5 w-3.5" /> Delete
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {isFinished && (
                    <div className="p-4">
                      <button
                        onClick={saveRun}
                        disabled={isSaving}
                        className="w-full flex items-center justify-center gap-2 rounded-2xl bg-slate-900 text-white py-3 text-sm font-black shadow-xl disabled:opacity-60"
                      >
                        {isSaving ? 'Saving...' : (
                          <>
                            <Save className="h-4 w-4" /> Save Run
                          </>
                        )}
                      </button>
                    </div>
                  )}
                </div>

                {Object.keys(segments).length > 1 && (
                  <div className="rounded-3xl border border-slate-800 bg-slate-900/80 p-5 shadow-lg">
                    <div className="flex items-center justify-between">
                      <h3 className="text-[10px] font-black uppercase tracking-[0.35em] text-slate-400">
                        Live Segment Breakdown
                      </h3>
                      <TrendingUp className="h-4 w-4 text-slate-500" />
                    </div>
                    <div className="mt-4 space-y-3">
                      {currentSteps.slice(0, -1).map((step, idx) => {
                        if (!segments[step.id]) return null;
                        const dur = getDurationInMs(segments[step.id], segments[currentSteps[idx + 1].id]) ??
                          getDurationInMs(segments[step.id], liveNow);
                        const gold = goldSplits[step.id];
                        return (
                          <div key={step.id} className="flex items-center justify-between text-sm">
                            <span className="font-bold text-slate-500">{step.segment}</span>
                            <div className="flex items-center gap-2">
                              {gold && dur && (
                                <span className="text-[10px] font-bold uppercase text-emerald-500">Gold {formatDurationCompact(gold)}</span>
                              )}
                              <span className="mono font-black text-slate-100"><DurationDisplay ms={dur} /></span>
                            </div>
                          </div>
                        );
                      })}
                      <div className="mt-4 flex items-center justify-between border-t border-slate-800/60 pt-3">
                        <span className="text-sm font-black text-slate-100">Total</span>
                        <span className="rounded-lg bg-slate-900 px-3 py-1 text-sm font-black text-white">
                          <DurationDisplay ms={totalTimeMs} />
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-4">
                <div className="rounded-3xl border border-slate-800 bg-slate-900/80 p-5 shadow-lg">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-[10px] font-black uppercase tracking-[0.35em] text-slate-400">Split Goals</p>
                      <h3 className="text-lg font-black text-slate-100">Golds & Targets</h3>
                    </div>
                    <div className="flex items-center gap-3 text-xs font-bold">
                      <span className="flex items-center gap-1 text-emerald-500"><span className="text-base leading-none">●</span> Gold</span>
                      <span className="flex items-center gap-1 text-slate-400"><span className="text-base leading-none">●</span> Current</span>
                    </div>
                  </div>
                  <div className="mt-4 space-y-3">
                    {currentSteps.slice(0, -1).map((step) => {
                      const gold = goldSplits[step.id];
                      const stepIndex = currentSteps.findIndex((s) => s.id === step.id);
                      const nextStep = stepIndex >= 0 ? currentSteps[stepIndex + 1] : undefined;
                      const duration = nextStep ? getDurationInMs(segments[step.id], segments[nextStep.id]) : null;
                      return (
                        <div key={step.id} className="rounded-2xl border border-slate-800/60 px-3 py-3">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-bold text-slate-400">{step.segment}</span>
                            {gold ? (
                              <span className="mono text-xs font-black text-emerald-600"><DurationDisplay ms={gold} /></span>
                            ) : (
                              <span className="text-[10px] font-bold uppercase text-slate-500">No data</span>
                            )}
                          </div>
                          <div className="mt-2 flex items-center justify-between">
                            <span className="text-[10px] uppercase text-slate-400">Current</span>
                            <span className={`mono text-xs font-black ${duration ? 'text-slate-100' : 'text-slate-500'}`}>
                              {duration ? <DurationDisplay ms={duration} /> : '--'}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

              </div>
            </motion.section>
          ) : (
            <motion.section
              key="history"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.4 }}
              className="space-y-4"
            >
              {/* SEGMENT PERFORMANCE BLOCK */}
              {detailedStats && Object.keys(detailedStats).length > 0 && (() => {
                const runCount = statsViewMode === 'combined'
                  ? comparableRunsByMode.forward.length
                  : directRunsByMode[statsViewMode].length;
                return (
                  <div className="rounded-3xl border border-slate-800 bg-slate-900/80 shadow-lg overflow-hidden">
                    <div className="px-4 py-3 border-b border-slate-800/60">
                      <div className="flex items-center justify-between gap-3">
                        <h2 className="text-[10px] font-black uppercase tracking-[0.35em] text-slate-400">
                          Segment Performance
                        </h2>
                        {statsViewMode === 'combined' && (
                          <p className="text-[8px] font-bold uppercase tracking-[0.2em] text-slate-500">
                            Combined mirrored data
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-px bg-slate-800/60 border-b border-slate-800/60">
                      {([['forward', 'To Work'], ['reverse', 'To Home'], ['combined', 'Combined']] as [StatsMode, string][]).map(([m, label]) => {
                        const isActive = statsViewMode === m;
                        return (
                          <button
                            key={m}
                            onClick={() => setStatsViewMode(m)}
                            className={`px-2 py-2 text-[8px] font-black uppercase tracking-wider transition-colors ${
                              isActive
                                ? 'bg-slate-700 text-white'
                                : 'bg-slate-900/80 text-slate-500 hover:text-slate-300'
                            }`}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                    <div className="p-4">
                      {detailedStats[statsViewMode] && detailedStats[statsViewMode]!.length > 0 ? (
                        <>
                          {runCount > 0 && (
                            <p className="text-[9px] font-bold uppercase tracking-widest text-slate-500 text-right mb-3">
                              {runCount} {runCount === 1 ? 'run' : 'runs'}
                            </p>
                          )}
                          <div className="space-y-2">
                            {detailedStats[statsViewMode]!.map((stat) => {
                              const colors = colorMap[stat.label] ?? 'bg-slate-800/60 border-slate-800/60 text-slate-400';
                              const isSingleRun = stat.best === stat.worst;
                              return (
                                <div key={stat.label} className={`rounded-2xl border px-4 py-3 ${colors}`}>
                                  <p className="text-[9px] font-black uppercase tracking-widest opacity-60 mb-2">{stat.label}</p>
                                  <div className="flex gap-3 mt-1">
                                    <div className="flex-1 min-w-0">
                                      <p className="text-[10px] font-bold uppercase opacity-50 mb-0.5">Avg</p>
                                      <p className="mono text-base font-black truncate"><DurationDisplay ms={stat.avg} /></p>
                                    </div>
                                    {!isSingleRun && (
                                      <>
                                        <div className="flex-1 min-w-0">
                                          <p className="text-[10px] font-bold uppercase opacity-50 mb-0.5 flex items-center gap-0.5"><Zap className="h-3 w-3" />Best</p>
                                          <p className="mono text-base font-black opacity-80 truncate"><DurationDisplay ms={stat.best} /></p>
                                        </div>
                                        <div className="flex-1 min-w-0">
                                          <p className="text-[10px] font-bold uppercase opacity-50 mb-0.5 flex items-center gap-0.5"><AlertCircle className="h-3 w-3" />Worst</p>
                                          <p className="mono text-base font-black opacity-80 truncate"><DurationDisplay ms={stat.worst} /></p>
                                        </div>
                                      </>
                                    )}
                                    {isSingleRun && (
                                      <p className="text-[7px] font-bold uppercase opacity-30 tracking-widest self-center">only 1 run</p>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </>
                      ) : (
                        <div className="text-center py-6">
                          <AlertTriangle className="mx-auto h-8 w-8 text-slate-500" />
                          <p className="mt-2 text-[10px] font-bold uppercase text-slate-500">
                            No {statsViewMode === 'forward' ? 'To Work' : 'To Home'} data yet
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()}

              {/* RUN TIME CHARTS */}
              {(() => {
                const chartRuns = statsViewMode === 'combined'
                  ? comparableRunsByMode.forward
                      .map(({ run, durations }) => ({ run, durations }))
                      .sort((a, b) => a.run.date.getTime() - b.run.date.getTime())
                  : directRunsByMode[statsViewMode]
                      .sort((a, b) => a.date.getTime() - b.date.getTime())
                      .map((run) => ({ run }));
                if (chartRuns.length < 2) return null;

                const renderChart = (times: number[], color: string, height = 80) => {
                  const windowSize = 5;
                  const avg = times.map((_, i) => {
                    const start = Math.max(0, i - windowSize + 1);
                    const slice = times.slice(start, i + 1);
                    return slice.reduce((a, b) => a + b, 0) / slice.length;
                  });
                  const minMs = Math.min(...times);
                  const maxMs = Math.max(...times);
                  const pad = { t: 8, r: 10, b: 8, l: 10 };
                  const W = 360, H = height;
                  const pw = W - pad.l - pad.r;
                  const ph = H - pad.t - pad.b;
                  const xScale = (i: number) => pad.l + (times.length === 1 ? pw / 2 : (i / (times.length - 1)) * pw);
                  const yScale = (ms: number) => {
                    const range = maxMs - minMs || 1;
                    return pad.t + ph - ((ms - minMs) / range) * ph;
                  };
                  const avgLine = avg.map((v, i) => `${xScale(i)},${yScale(v)}`).join(' ');
                  const pbIdx = times.indexOf(minMs);
                  return (
                    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
                      {times.map((ms, i) => (
                        <circle key={i} cx={xScale(i)} cy={yScale(ms)} r="3" fill="rgb(148 163 184)" opacity="0.55" />
                      ))}
                      <polyline points={avgLine} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
                      <circle cx={xScale(pbIdx)} cy={yScale(minMs)} r="4" fill="rgb(250 204 21)" />
                    </svg>
                  );
                };

                const steps = getStatsSteps(statsViewMode);
                const segmentSeries = steps.slice(0, -1).map((step, idx) => {
                  const nextStep = steps[idx + 1];
                  const times = chartRuns
                    .map((entry) => {
                      if (statsViewMode === 'combined') return entry.durations?.[idx] ?? null;
                      return getDurationInMs(entry.run.segments[step.id], entry.run.segments[nextStep.id]);
                    })
                    .filter((v): v is number => v !== null && v > 0);
                  return { label: step.segment ?? step.label, stepId: step.id, times };
                }).filter(s => s.times.length >= 2);

                const totalTimes = chartRuns.map((entry) => entry.run.totalMs);
                const segmentColors: Record<string, string> = {
                  'Driving': 'rgb(251 146 60)',
                  'Walk to Stop': 'rgb(52 211 153)',
                  'Wait for Bus': 'rgb(96 165 250)',
                  'Bus Transit': 'rgb(167 139 250)',
                  'Walk to Office': 'rgb(251 113 133)',
                  'Walk to Car': 'rgb(251 113 133)',
                  'Walk to 2nd Stop': 'rgb(52 211 153)',
                  'Wait for 2nd Bus': 'rgb(96 165 250)',
                  '2nd Bus Transit': 'rgb(167 139 250)',
                  'Driving Home': 'rgb(251 146 60)',
                };

                return (
                  <div className="rounded-3xl border border-slate-800 bg-slate-900/80 shadow-lg overflow-hidden">
                    <button
                      onClick={() => setShowCharts(p => !p)}
                      className="w-full flex items-center justify-between px-4 py-4"
                    >
                      <p className="text-[10px] font-black uppercase tracking-[0.35em] text-slate-400">Trends</p>
                      <div className="flex items-center gap-3">
                        <div className="flex items-center gap-3 text-[9px] font-bold text-slate-600">
                          <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-slate-500 opacity-60"></span>Run</span>
                          <span className="flex items-center gap-1"><span className="inline-block w-4 h-0.5 bg-emerald-600 rounded"></span>5-run avg</span>
                          <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-yellow-500"></span>PB</span>
                        </div>
                        <ChevronDown className={`h-4 w-4 text-slate-500 transition-transform ${showCharts ? 'rotate-180' : ''}`} />
                      </div>
                    </button>
                    {showCharts && (
                      <div className="px-4 pb-4 space-y-4 border-t border-slate-800/60 pt-4">
                        <div>
                          <p className="text-[10px] font-black uppercase tracking-[0.35em] text-slate-400 mb-1">Total Trip</p>
                          {renderChart(totalTimes, 'rgb(34 197 94)', 90)}
                        </div>
                        {segmentSeries.map(({ label, times }) => (
                          <div key={label}>
                            <p className="text-[10px] font-black uppercase tracking-[0.35em] mb-1" style={{ color: segmentColors[label] ?? 'rgb(148 163 184)' }}>{label}</p>
                            {renderChart(times, segmentColors[label] ?? 'rgb(148 163 184)', 70)}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* RUN LOG */}
              <div className="space-y-3">
                <div className="flex items-center justify-between px-1">
                  <h3 className="text-[10px] font-black uppercase tracking-[0.35em] text-slate-400">Run Log</h3>
                  <div className="flex gap-2">
                    <button
                      onClick={exportHistory}
                      className="flex items-center gap-1.5 rounded-xl border border-slate-800 bg-slate-900/80 px-3 py-1.5 text-[9px] font-black uppercase tracking-widest text-slate-500 hover:text-slate-300 transition-colors"
                    >
                      <Download className="h-3 w-3" /> Export
                    </button>
                    <button
                      onClick={handleImportClick}
                      disabled={isImporting}
                      className="flex items-center gap-1.5 rounded-xl border border-slate-800 bg-slate-900/80 px-3 py-1.5 text-[9px] font-black uppercase tracking-widest text-slate-500 hover:text-slate-300 transition-colors disabled:opacity-60"
                    >
                      <Upload className="h-3 w-3" /> Import
                    </button>
                    <input type="file" ref={fileInputRef} onChange={importHistory} accept=".json" className="hidden" />
                  </div>
                </div>
                {history.length === 0 ? (
                  <div className="rounded-2xl border border-slate-800 border-dashed bg-slate-900/40 p-10 flex flex-col items-center gap-3 text-center">
                    <Rabbit className="h-8 w-8 text-slate-600" />
                    <p className="text-xs font-black uppercase tracking-widest text-slate-500">No runs yet</p>
                    <p className="text-[10px] text-slate-600 max-w-[18ch]">Head back to the timer and log your first split</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {[...history]
                      .sort((a, b) => b.date.getTime() - a.date.getTime())
                      .map((run) => (
                        <div
                          key={run.id}
                          className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4 shadow-sm transition-all hover:border-slate-700"
                        >
                          <div className="flex items-center gap-3">
                            <div
                              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
                                run.mode === 'forward'
                                  ? 'bg-blue-950 text-blue-400'
                                  : 'bg-indigo-950 text-indigo-400'
                              }`}
                            >
                              {run.mode === 'forward'
                                ? <Building2 size={16} />
                                : <Home size={16} />}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-[9px] font-bold uppercase tracking-tight text-slate-500">
                                {formatFullDate(run.date)}
                              </p>
                              <div className="flex items-baseline gap-2 flex-wrap">
                                <p className="mono text-base font-black text-slate-100"><DurationDisplay ms={run.totalMs} /></p>
                                <span className={`text-[8px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded-md shrink-0 ${
                                  run.mode === 'forward'
                                    ? 'text-blue-400 bg-blue-950'
                                    : 'text-indigo-400 bg-indigo-950'
                                }`}>
                                  {run.mode === 'forward' ? 'To Work' : 'To Home'}
                                </span>
                              </div>
                            </div>
                            <button
                              onClick={() => deleteRun(run.id)}
                              className="shrink-0 rounded-xl p-2 text-slate-600 transition-colors hover:text-rose-400"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </div>
                      ))}
                  </div>
                )}
              </div>
            </motion.section>
          )}
        </AnimatePresence>
      </div>

      {/* Floating split button */}
      <AnimatePresence>
        {!showHistory && (
          <motion.div
            key="fab"
            initial={{ opacity: 0, scale: 0.8, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.8, y: 20 }}
            transition={{ duration: 0.2 }}
            className="fixed bottom-6 right-6 z-50 flex items-stretch"
          >
            {livePrediction && !isFinished && (
              <div className="flex items-center rounded-l-2xl border border-r-0 border-slate-700 bg-slate-800/95 px-3 text-slate-200 shadow-2xl">
                <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-400">
                  ETA:
                </span>
                <span className="mono ml-2 text-sm font-bold text-slate-100">
                  {formatArrivalTime(livePrediction.eta)}
                </span>
              </div>
            )}
            <button
              disabled={isFinished && isSaving}
              onClick={() => {
                if (isFinished) {
                  saveRun();
                } else {
                  const nextStep = currentSteps[nextStepIndex === -1 ? 0 : nextStepIndex];
                  if (nextStep) logTime(nextStep.id);
                }
              }}
              className={`flex flex-col items-center justify-center rounded-2xl px-5 py-3 text-white shadow-2xl active:scale-95 transition-transform disabled:opacity-60 ${
                livePrediction && !isFinished ? 'rounded-l-none' : ''
              } ${
                isFinished ? 'bg-emerald-600' : 'bg-blue-600'
              }`}
            >
              <span className="text-[9px] font-black uppercase tracking-[0.25em] opacity-70">
                {isFinished
                  ? isSaving ? 'Saving...' : 'Run complete'
                  : Object.keys(segments).length === 0
                    ? 'Tap to begin'
                  : getDisplayedSegmentName(currentSteps, nextStepIndex)}
              </span>
              <span className="text-base font-black uppercase tracking-widest">
                {isFinished ? 'Save Run' : Object.keys(segments).length === 0 ? 'Start' : 'Split'}
              </span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default App;
