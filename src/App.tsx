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
  CircleDot,
  CircleDashed,
  Flame,
  Moon,
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
type Category = 'normal' | 'night';
type RunKey = `${Category}:${Mode}`;
type SegmentMap = Record<string, Date>;

const makeRunKey = (cat: Category, m: Mode): RunKey => `${cat}:${m}`;

type RunRecord = {
  id: string;
  category: Category;
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

const nightForwardSteps: Step[] = [
  { id: 'car', label: 'Got in Car', icon: <Car />, segment: 'Driving' },
  { id: 'parking', label: 'Arrived at Parking', icon: <ParkingCircle />, segment: 'Walk to Stop' },
  { id: 'busStop', label: 'At Bus Stop', icon: <Clock />, segment: 'Wait for Bus' },
  { id: 'busArrival', label: 'Bus Arrived', icon: <Bus />, segment: 'Bus Transit' },
  { id: 'busDest', label: 'Bus Destination', icon: <Timer />, segment: 'Walk to 2nd Stop' },
  { id: 'busStop2', label: 'At 2nd Bus Stop', icon: <Clock />, segment: 'Wait for 2nd Bus' },
  { id: 'busArrival2', label: '2nd Bus Arrived', icon: <Bus />, segment: '2nd Bus Transit' },
  { id: 'checkpoint', label: 'At Checkpoint', icon: <Flag /> }
];

const nightReverseSteps: Step[] = reverseSteps;

const getSteps = (cat: Category, m: Mode): Step[] => {
  if (cat === 'night') return m === 'forward' ? nightForwardSteps : nightReverseSteps;
  return m === 'forward' ? forwardSteps : reverseSteps;
};

const storageKey = 'csr_runs_v1';
const localUserKey = 'csr_user_id';
const inProgressKey = 'csr_in_progress_v1';

const getDurationInMs = (start?: Date, end?: Date) => {
  if (!start || !end) return null;
  return Math.max(0, end.getTime() - start.getTime());
};

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
    return parsed.map((run) => ({
      ...run,
      category: (run.category ?? 'normal') as Category,
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
  const [category, setCategory] = useState<Category>('normal');
  const [mode, setMode] = useState<Mode>('forward');
  const [segments, setSegments] = useState<SegmentMap>({});
  const [editingSegment, setEditingSegment] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [history, setHistory] = useState<RunRecord[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [statsViewCategory, setStatsViewCategory] = useState<Category>('normal');
  const [statsViewMode, setStatsViewMode] = useState<Mode>('forward');
  const [liveNow, setLiveNow] = useState<Date>(new Date());

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
      const parsed = JSON.parse(raw) as { category?: string; mode: Mode; segments: Record<string, string> };
      if (parsed?.segments && Object.keys(parsed.segments).length > 0) {
        setCategory((parsed.category ?? 'normal') as Category);
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
            category?: string;
          }),
          category: ((snap.data().category ?? 'normal') as Category),
          date: parseDate(snap.data().date),
          segments: Object.fromEntries(
            Object.entries(snap.data().segments ?? {}).map(([key, value]) => [
              key,
              parseDate(value)
            ])
          )
        }));
        setHistory(docs as RunRecord[]);
      },
      () => undefined
    );
    return () => unsubscribe();
  }, [db, userId]);

  const currentSteps = getSteps(category, mode);
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
      category,
      mode,
      segments: Object.fromEntries(
        Object.entries(segments).map(([key, value]) => [key, value.toISOString()])
      )
    };
    localStorage.setItem(inProgressKey, JSON.stringify(serialized));
  }, [segments, mode, category, isFinished]);

  const detailedStats = useMemo(() => {
    if (history.length === 0) return null;
    const allKeys: RunKey[] = ['normal:forward', 'normal:reverse', 'night:forward', 'night:reverse'];
    const results: Partial<Record<RunKey, { label: string; avg: number; best: number; worst: number }[]>> = {};

    allKeys.forEach((key) => {
      const [cat, m] = key.split(':') as [Category, Mode];
      const steps = getSteps(cat, m);
      const keyedRuns = history.filter(
        (h) => (h.category ?? 'normal') === cat && h.mode === m
      );
      if (!keyedRuns.length) return;

      const segmentDurations: Record<string, number[]> = {};
      keyedRuns.forEach((run) => {
        for (let i = 0; i < steps.length - 1; i += 1) {
          const label = steps[i].segment ?? steps[i].label;
          const start = run.segments[steps[i].id];
          const end = run.segments[steps[i + 1].id];
          const dur = getDurationInMs(start, end);
          if (dur !== null) {
            if (!segmentDurations[label]) segmentDurations[label] = [];
            segmentDurations[label].push(dur);
          }
        }
        if (!segmentDurations['Total Trip']) segmentDurations['Total Trip'] = [];
        segmentDurations['Total Trip'].push(run.totalMs);
      });

      results[key] = Object.entries(segmentDurations).map(([label, durs]) => ({
        label,
        avg: Math.round(durs.reduce((a, b) => a + b, 0) / durs.length),
        best: Math.min(...durs),
        worst: Math.max(...durs)
      }));
    });

    return results;
  }, [history]);

  const personalBest = useMemo(() => {
    const modeRuns = history.filter(
      (run) => (run.category ?? 'normal') === category && run.mode === mode
    );
    if (!modeRuns.length) return null;
    return Math.min(...modeRuns.map((run) => run.totalMs));
  }, [history, mode, category]);

  const goldSplits = useMemo(() => {
    const modeRuns = history.filter(
      (run) => (run.category ?? 'normal') === category && run.mode === mode
    );
    const steps = currentSteps;
    const gold: Record<string, number> = {};
    modeRuns.forEach((run) => {
      steps.forEach((step, idx) => {
        if (idx === steps.length - 1) return;
        const start = run.segments[step.id];
        const end = run.segments[steps[idx + 1].id];
        const duration = getDurationInMs(start, end);
        if (duration === null) return;
        if (!gold[step.id] || duration < gold[step.id]) {
          gold[step.id] = duration;
        }
      });
    });
    return gold;
  }, [history, mode, category, currentSteps]);

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
        category,
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
          category: run.category,
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
            category: (item.category ?? 'normal') as Category,
            mode: (item.mode ?? 'forward') as Mode,
            totalMs: item.totalMs ?? 0,
            date: item.date ? new Date(item.date) : new Date(),
            segments: cleanSegments
          } as RunRecord;
        });

        if (usingFirebase && db) {
          for (const item of cleaned) {
            await addDoc(collection(db, 'artifacts', appId, 'users', userId, 'runs'), {
              category: item.category,
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
                  {category === 'night' ? 'Night% · ' : ''}{mode === 'forward' ? 'To Work' : 'To Home'}
                </span>
                {personalBest && (
                  <span className="px-3 py-1 rounded-full bg-emerald-100 text-emerald-700 text-xs font-bold tracking-wide flex items-center gap-1">
                    <Flame className="h-3 w-3" /> PB {formatDuration(personalBest)}
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
                    {Object.keys(segments).length === 0 ? '--:--' : formatDuration(totalTimeMs)}
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
              {/* Category tabs */}
              <div className="flex gap-1 rounded-2xl border border-slate-800 bg-slate-900/80 p-1">
                {(['normal', 'night'] as Category[]).map((cat) => {
                  const isActive = category === cat;
                  const hasProgress = isActive && Object.keys(segments).length > 0 && !isFinished;
                  return (
                    <button
                      key={cat}
                      onClick={() => {
                        if (Object.keys(segments).length && !confirm('Switch category? This will reset splits.')) return;
                        setCategory(cat);
                        setSegments({});
                      }}
                      className={`relative flex-1 rounded-xl px-3 py-2 text-[10px] font-black uppercase tracking-widest transition-all ${
                        isActive
                          ? cat === 'night'
                            ? 'bg-slate-800 text-cyan-300 border border-cyan-500/30'
                            : 'bg-slate-700 text-white'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {cat === 'night' ? 'Night%' : 'Normal%'}
                    </button>
                  );
                })}
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <button
                  onClick={() => {
                    if (Object.keys(segments).length && !confirm('Reset split order?')) return;
                    setMode('forward');
                    setSegments({});
                  }}
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
                  onClick={() => {
                    if (Object.keys(segments).length && !confirm('Reset split order?')) return;
                    setMode('reverse');
                    setSegments({});
                  }}
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
                      <h2 className="text-lg font-black text-slate-100">{category === 'night' ? 'Night% · ' : ''}{mode === 'forward' ? 'Work Route' : 'Home Route'}</h2>
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
                        <div key={step.id} className={`flex items-center gap-4 p-4 ${isNext ? 'bg-slate-800/60' : ''}`}>
                          <div
                            className={`flex h-11 w-11 items-center justify-center rounded-2xl text-sm font-bold transition-all ${
                              isLogged
                                ? 'bg-emerald-100 text-emerald-600'
                                : isNext
                                  ? 'bg-slate-900 text-white shadow-lg'
                                  : 'bg-slate-800/60 text-slate-500'
                            }`}
                          >
                            {React.cloneElement(step.icon, { size: 18 })}
                          </div>
                          <div className="flex-1">
                            <p className={`text-sm font-bold ${isLogged ? 'text-slate-400' : 'text-slate-100'}`}>
                              {step.label}
                            </p>
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
                          <div className="text-right">
                            {duration !== null && (
                              <p className="mono text-xs font-bold text-slate-200">{formatDuration(duration)}</p>
                            )}
                            {delta !== null && (
                              <p className={`text-[10px] font-bold ${delta <= 0 ? 'text-emerald-600' : 'text-rose-500'}`}>
                                {delta <= 0 ? '-' : '+'}
                                {formatDurationCompact(Math.abs(delta))}
                              </p>
                            )}
                          </div>
                          {isLogged ? (
                            <div className="flex items-center gap-1">
                              <button
                                onClick={() => adjustSegment(step.id, -30000)}
                                className="px-2 py-1 rounded-lg text-[9px] font-black text-slate-400 hover:text-white bg-slate-800/60 hover:bg-slate-700"
                              >
                                −30s
                              </button>
                              <button
                                onClick={() => adjustSegment(step.id, +30000)}
                                className="px-2 py-1 rounded-lg text-[9px] font-black text-slate-400 hover:text-white bg-slate-800/60 hover:bg-slate-700"
                              >
                                +30s
                              </button>
                              <button
                                onClick={() => deleteSegment(step.id)}
                                className="p-1.5 rounded-lg text-slate-500 hover:text-rose-400 bg-slate-800/60 hover:bg-slate-800"
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => logTime(step.id)}
                              disabled={idx > nextStepIndex}
                              className={`px-4 py-2 rounded-xl text-[10px] font-black uppercase ${
                                isNext
                                  ? 'bg-slate-900 text-white'
                                  : 'bg-slate-800/60 text-slate-500 cursor-not-allowed'
                              }`}
                            >
                              Split
                            </button>
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
                              <span className="mono font-black text-slate-100">{formatDuration(dur)}</span>
                            </div>
                          </div>
                        );
                      })}
                      <div className="mt-4 flex items-center justify-between border-t border-slate-800/60 pt-3">
                        <span className="text-sm font-black text-slate-100">Total</span>
                        <span className="rounded-lg bg-slate-900 px-3 py-1 text-sm font-black text-white">
                          {formatDuration(totalTimeMs)}
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
                    <div className="flex items-center gap-2 text-xs text-slate-400">
                      <CircleDot className="h-4 w-4" /> Gold
                      <CircleDashed className="h-4 w-4" /> Pending
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
                              <span className="mono text-xs font-black text-emerald-600">{formatDuration(gold)}</span>
                            ) : (
                              <span className="text-[10px] font-bold uppercase text-slate-500">No data</span>
                            )}
                          </div>
                          <div className="mt-2 flex items-center justify-between">
                            <span className="text-[10px] uppercase text-slate-400">Current</span>
                            <span className={`mono text-xs font-black ${duration ? 'text-slate-100' : 'text-slate-500'}`}>
                              {duration ? formatDuration(duration) : '--'}
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
                const statsKey = makeRunKey(statsViewCategory, statsViewMode);
                const runCount = history.filter(
                  (h) => (h.category ?? 'normal') === statsViewCategory && h.mode === statsViewMode
                ).length;
                return (
                  <div className="rounded-3xl border border-slate-800 bg-slate-900/80 shadow-lg overflow-hidden">
                    <div className="px-4 py-3 border-b border-slate-800/60">
                      <h2 className="text-[10px] font-black uppercase tracking-[0.35em] text-slate-400">
                        Segment Performance
                      </h2>
                    </div>
                    {/* Compact 2×2 tab grid */}
                    <div className="grid grid-cols-2 gap-px bg-slate-800/60 border-b border-slate-800/60">
                      {([['normal', 'forward', 'Normal% · To Work'], ['normal', 'reverse', 'Normal% · To Home'], ['night', 'forward', 'Night% · To Work'], ['night', 'reverse', 'Night% · To Home']] as [Category, Mode, string][]).map(([cat, m, label]) => {
                        const isActive = statsViewCategory === cat && statsViewMode === m;
                        return (
                          <button
                            key={`${cat}:${m}`}
                            onClick={() => { setStatsViewCategory(cat); setStatsViewMode(m); }}
                            className={`px-2 py-2 text-[8px] font-black uppercase tracking-wider transition-colors ${
                              isActive
                                ? cat === 'night'
                                  ? 'bg-slate-800 text-cyan-300'
                                  : 'bg-slate-700 text-white'
                                : 'bg-slate-900/80 text-slate-500 hover:text-slate-300'
                            }`}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                    <div className="p-4">
                      {detailedStats[statsKey] && detailedStats[statsKey]!.length > 0 ? (
                        <>
                          {runCount > 0 && (
                            <p className="text-[9px] font-bold uppercase tracking-widest text-slate-500 text-right mb-3">
                              {runCount} {runCount === 1 ? 'run' : 'runs'}
                            </p>
                          )}
                          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                            {detailedStats[statsKey]!.map((stat) => {
                              const colors = colorMap[stat.label] ?? 'bg-slate-800/60 border-slate-800/60 text-slate-500';
                              const isTotal = stat.label === 'Total Trip';
                              const isSingleRun = stat.best === stat.worst;
                              return (
                                <div key={stat.label} className={`rounded-2xl border p-3 ${colors} ${isTotal ? 'col-span-2 sm:col-span-1' : ''}`}>
                                  <p className={`text-[9px] font-black uppercase tracking-tight opacity-70 ${isTotal ? 'text-blue-100' : ''}`}>
                                    {stat.label}
                                  </p>
                                  <p className="mono text-base font-black mt-1">
                                    {formatDuration(stat.avg)}
                                  </p>
                                  {isSingleRun ? (
                                    <p className="mt-1 text-[7px] font-bold uppercase opacity-30 tracking-widest leading-tight">only 1 run</p>
                                  ) : (
                                    <div className="mt-2 flex gap-2 text-[8px] font-bold uppercase opacity-60">
                                      <span className="flex items-center gap-0.5"><Zap className="h-2.5 w-2.5" />{formatDuration(stat.best)}</span>
                                      <span className="flex items-center gap-0.5"><AlertCircle className="h-2.5 w-2.5" />{formatDuration(stat.worst)}</span>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </>
                      ) : (
                        <div className="text-center py-6">
                          <AlertTriangle className="mx-auto h-8 w-8 text-slate-500" />
                          <p className="mt-2 text-[10px] font-bold uppercase text-slate-500">
                            No {statsViewCategory === 'night' ? 'Night% ' : ''}{statsViewMode === 'forward' ? 'To Work' : 'To Home'} data yet
                          </p>
                        </div>
                      )}
                    </div>
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
                                (run.category ?? 'normal') === 'night'
                                  ? 'bg-cyan-950 text-cyan-400 border border-cyan-800/40'
                                  : run.mode === 'forward'
                                    ? 'bg-blue-950 text-blue-400'
                                    : 'bg-indigo-950 text-indigo-400'
                              }`}
                            >
                              {(run.category ?? 'normal') === 'night'
                                ? <Moon size={16} />
                                : run.mode === 'forward'
                                  ? <Building2 size={16} />
                                  : <Home size={16} />}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-[9px] font-bold uppercase tracking-tight text-slate-500">
                                {formatFullDate(run.date)}
                              </p>
                              <div className="flex items-baseline gap-2 flex-wrap">
                                <p className="mono text-base font-black text-slate-100">{formatDuration(run.totalMs)}</p>
                                <span className={`text-[8px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded-md shrink-0 ${
                                  (run.category ?? 'normal') === 'night'
                                    ? 'text-cyan-400 bg-cyan-950'
                                    : run.mode === 'forward'
                                      ? 'text-blue-400 bg-blue-950'
                                      : 'text-indigo-400 bg-indigo-950'
                                }`}>
                                  {(run.category ?? 'normal') === 'night' ? 'Night%' : 'Normal%'} · {run.mode === 'forward' ? 'To Work' : 'To Home'}
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
          <motion.button
            key="fab"
            initial={{ opacity: 0, scale: 0.8, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.8, y: 20 }}
            transition={{ duration: 0.2 }}
            disabled={isFinished && isSaving}
            onClick={() => {
              if (isFinished) {
                saveRun();
              } else {
                const nextStep = currentSteps[nextStepIndex === -1 ? 0 : nextStepIndex];
                if (nextStep) logTime(nextStep.id);
              }
            }}
            className={`fixed bottom-6 right-6 z-50 flex flex-col items-center justify-center rounded-2xl shadow-2xl px-5 py-3 text-white active:scale-95 transition-transform disabled:opacity-60 ${
              isFinished ? 'bg-emerald-600' : 'bg-blue-600'
            }`}
          >
            <span className="text-[9px] font-black uppercase tracking-[0.25em] opacity-70">
              {isFinished
                ? isSaving ? 'Saving...' : 'Run complete'
                : Object.keys(segments).length === 0
                  ? 'Tap to begin'
                  : currentSteps[nextStepIndex]?.label}
            </span>
            <span className="text-base font-black uppercase tracking-widest">
              {isFinished ? 'Save Run' : Object.keys(segments).length === 0 ? 'Start' : 'Split'}
            </span>
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
};

export default App;
