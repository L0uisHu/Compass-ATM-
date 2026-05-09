import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { CSSProperties, FormEvent, KeyboardEvent } from 'react';
import {
  BookOpen,
  Briefcase,
  Building2,
  ChevronDown,
  CircleStop,
  Compass,
  Database,
  Globe,
  Mic,
  MicOff,
  Plane,
  Send,
  ShieldCheck,
  Sparkles,
  Volume2,
} from 'lucide-react';

const BACKEND_URL =
  (import.meta.env.VITE_BACKEND_URL as string | undefined) ??
  'http://localhost:8000';

type Verticale =
  | 'relocation'
  | 'life_on_campus'
  | 'study_abroad'
  | 'career_readiness';

type AskResponse = {
  answer: string;
  sources: string[];
  verticale: Verticale;
};

type Message =
  | { id: string; role: 'user'; text: string }
  | {
      id: string;
      role: 'assistant';
      text: string;
      sources: string[];
      verticale: Verticale;
      createdAt: number;
    };

type AskState =
  | { kind: 'idle' }
  | { kind: 'loading'; question: string }
  | { kind: 'error'; question: string; message: string };

type ChipKey = 'all' | Verticale;

type ModeMeta = {
  key: Verticale;
  label: string;
  description: string;
  Icon: typeof Compass;
  suggestions: string[];
};

const MODES: Record<Verticale, ModeMeta> = {
  relocation: {
    key: 'relocation',
    label: 'Settle in Milan',
    description: 'Visa, housing, transport, city admin.',
    Icon: Compass,
    suggestions: [
      'How do I open an Italian bank account as a non-resident?',
      "What's a fair monthly rent budget near Bocconi?",
      'Where do I get my codice fiscale?',
    ],
  },
  life_on_campus: {
    key: 'life_on_campus',
    label: 'Campus Life',
    description: 'Library, dining, sport, associations.',
    Icon: Building2,
    suggestions: [
      'Can I bring guests into the library?',
      'What dining options are on campus?',
      'How do I join a student association?',
    ],
  },
  study_abroad: {
    key: 'study_abroad',
    label: 'Study Abroad',
    description: 'Exchange, double degrees, deadlines.',
    Icon: Plane,
    suggestions: [
      'Which partner universities offer Double Degrees in Finance?',
      'When do exchange applications open?',
      'How is the exchange selection score calculated?',
    ],
  },
  career_readiness: {
    key: 'career_readiness',
    label: 'Career',
    description: 'Internships, scholarships, salaries.',
    Icon: Briefcase,
    suggestions: [
      "What's the average salary for Bocconi MSc Finance grads?",
      'When does the curricular internship application close?',
      'Which scholarships are available for international MSc students?',
    ],
  },
};

const CHIP_ORDER: ChipKey[] = [
  'all',
  'relocation',
  'life_on_campus',
  'study_abroad',
  'career_readiness',
];

const CHIP_LABEL: Record<ChipKey, string> = {
  all: 'Ask anything',
  relocation: 'Settle in Milan',
  life_on_campus: 'Campus Life',
  study_abroad: 'Study Abroad',
  career_readiness: 'Career',
};

const ABSTENTION_PATTERN =
  /\b(no information|i don't have|i do not have|not in (the )?sources|non ho (informazioni|le informazioni)|le fonti non)\b/i;

const NOTE_PREFIX = /^(note:|worth noting|caveat:|important:|however,)/i;

// Per-vertical accent palette. Used for AnswerCard left border, badge tint,
// active chip, and source-row dot. Falls back to indigo for unknown verts.
const VERT_COLOR: Record<Verticale, { fg: string; tint: string }> = {
  relocation:       { fg: '#1F3A8A', tint: '#EEF1FA' },
  life_on_campus:   { fg: '#0F8A5F', tint: '#E6F4EE' },
  study_abroad:     { fg: '#B45309', tint: '#FEF3E0' },
  career_readiness: { fg: '#BE185D', tint: '#FCE7F3' },
};

const ITALIAN_MARKERS =
  / (e|il|la|un|una|del|della|qual|come|quanto|quando|dove|che|cosa|sono|posso) | perch[eé]/i;

function detectLang(text: string): 'it-IT' | 'en-US' {
  return ITALIAN_MARKERS.test(' ' + text.toLowerCase() + ' ') ? 'it-IT' : 'en-US';
}

// Strip markdown + citations so TTS reads cleanly (no "asterisk asterisk").
function stripForSpeech(text: string): string {
  return text
    .replace(/\[source:\s*[^\]]+\]/gi, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^#+\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\|/g, ' ')
    .replace(/\n{2,}/g, '. ')
    .replace(/\s+/g, ' ')
    .trim();
}

type VoiceState = 'idle' | 'listening' | 'speaking';

type UseVoiceArgs = {
  onTranscript: (text: string) => void;
  lang: 'en-US' | 'it-IT';
};

// Wraps the browser's SpeechRecognition + SpeechSynthesis APIs.
// Pattern name: "imperative web-API hook" — stable callbacks via useCallback,
// stateful refs to avoid stale closures inside the recognition handlers.
function useVoice({ onTranscript, lang }: UseVoiceArgs) {
  const [state, setState] = useState<VoiceState>('idle');
  const [supported, setSupported] = useState<{ stt: boolean; tts: boolean }>({
    stt: false,
    tts: false,
  });
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  useEffect(() => {
    const SR =
      (window as unknown as { SpeechRecognition?: SpeechRecognitionCtor })
        .SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: SpeechRecognitionCtor })
        .webkitSpeechRecognition;
    const tts =
      typeof window !== 'undefined' && 'speechSynthesis' in window;
    setSupported({ stt: !!SR, tts });
    if (!SR) return;
    const rec: SpeechRecognitionInstance = new SR();
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.continuous = false;
    rec.onresult = (event) => {
      const text = event.results[0]?.[0]?.transcript ?? '';
      if (text) onTranscriptRef.current(text);
      setState('idle');
    };
    rec.onerror = () => setState('idle');
    rec.onend = () => setState((s) => (s === 'listening' ? 'idle' : s));
    recognitionRef.current = rec;
    return () => {
      try { rec.abort(); } catch { /* noop */ }
    };
  }, []);

  // Keep the language fresh between calls.
  useEffect(() => {
    if (recognitionRef.current) recognitionRef.current.lang = lang;
  }, [lang]);

  const startListening = useCallback(() => {
    const rec = recognitionRef.current;
    if (!rec) return;
    try {
      rec.lang = lang;
      rec.start();
      setState('listening');
    } catch {
      setState('idle');
    }
  }, [lang]);

  const stopListening = useCallback(() => {
    try { recognitionRef.current?.stop(); } catch { /* noop */ }
    setState('idle');
  }, []);

  const speak = useCallback(
    (text: string, speechLang: 'en-US' | 'it-IT') => {
      if (!supported.tts) return;
      window.speechSynthesis.cancel();
      const cleaned = stripForSpeech(text);
      if (!cleaned) return;
      const utter = new SpeechSynthesisUtterance(cleaned);
      utter.lang = speechLang;
      utter.rate = 1.05;
      utter.onend = () => setState((s) => (s === 'speaking' ? 'idle' : s));
      utter.onerror = () => setState((s) => (s === 'speaking' ? 'idle' : s));
      setState('speaking');
      window.speechSynthesis.speak(utter);
    },
    [supported.tts],
  );

  const stopSpeaking = useCallback(() => {
    if (supported.tts) window.speechSynthesis.cancel();
    setState((s) => (s === 'speaking' ? 'idle' : s));
  }, [supported.tts]);

  return { state, supported, startListening, stopListening, speak, stopSpeaking };
}

// Minimal local typing for the Web Speech API (TS lib doesn't ship it by default).
type SpeechRecognitionInstance = {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult:
    | ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void)
    | null;
  onerror: ((event: unknown) => void) | null;
  onend: (() => void) | null;
};
type SpeechRecognitionCtor = new () => SpeechRecognitionInstance;

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [askState, setAskState] = useState<AskState>({ kind: 'idle' });
  const [composerValue, setComposerValue] = useState('');
  const [activeChip, setActiveChip] = useState<ChipKey>('all');
  const [healthStatus, setHealthStatus] =
    useState<'pending' | 'ok' | 'down'>('pending');
  const [voiceLang, setVoiceLang] = useState<'en-US' | 'it-IT'>('en-US');
  // Track whether the *next* assistant message should be auto-spoken (i.e., the
  // current question came in via mic, not keyboard).
  const speakNextRef = useRef(false);
  // The id of the message currently being spoken (or null). Lets the speak button
  // act as a toggle per-message.
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);

  const threadRef = useRef<HTMLDivElement | null>(null);
  const wasNearBottomRef = useRef(true);

  // Poll /health every 30s. Failure mode is silent — dot stays grey.
  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const res = await fetch(`${BACKEND_URL}/health`, { method: 'GET' });
        if (cancelled) return;
        setHealthStatus(res.ok ? 'ok' : 'down');
      } catch {
        if (cancelled) return;
        setHealthStatus('down');
      }
    }
    check();
    const id = window.setInterval(check, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  // Auto-scroll to bottom only if user was already near the bottom.
  useEffect(() => {
    const node = threadRef.current;
    if (!node) return;
    if (wasNearBottomRef.current) {
      node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
    }
  }, [messages.length, askState.kind]);

  function handleThreadScroll() {
    const node = threadRef.current;
    if (!node) return;
    const distance = node.scrollHeight - (node.scrollTop + node.clientHeight);
    wasNearBottomRef.current = distance < 120;
  }

  async function sendQuestion(question: string) {
    const trimmed = question.trim();
    if (!trimmed || askState.kind === 'loading') return;

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      text: trimmed,
    };
    setMessages((prev) => [...prev, userMsg]);
    setAskState({ kind: 'loading', question: trimmed });
    setComposerValue('');
    wasNearBottomRef.current = true;

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 30_000);

    try {
      const res = await fetch(`${BACKEND_URL}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: trimmed }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as AskResponse;
      const assistantMsg: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        text: data.answer,
        sources: data.sources ?? [],
        verticale: data.verticale,
        createdAt: Date.now(),
      };
      setMessages((prev) => [...prev, assistantMsg]);
      setAskState({ kind: 'idle' });

      // Auto-speak when the question came via voice. We pick the answer's
      // likely language by sampling the answer text — backend mirrors the
      // question's language, so this is usually a no-op vs voiceLang.
      if (speakNextRef.current) {
        speakNextRef.current = false;
        const lang = detectLang(data.answer);
        voice.speak(data.answer, lang);
        setSpeakingMessageId(assistantMsg.id);
      }
    } catch (err) {
      speakNextRef.current = false;
      const message =
        err instanceof DOMException && err.name === 'AbortError'
          ? 'Compass needed more than 30 seconds. Try a narrower question or retry shortly.'
          : 'Compass could not reach the backend. Your question is still here — retry when the service is available.';
      setAskState({ kind: 'error', question: trimmed, message });
    } finally {
      window.clearTimeout(timeout);
    }
  }

  const voice = useVoice({
    lang: voiceLang,
    onTranscript: (text) => {
      // Voice path: mark next answer to be spoken, then submit immediately.
      speakNextRef.current = true;
      sendQuestion(text);
    },
  });

  // Clear speaking-message highlight when speech ends.
  useEffect(() => {
    if (voice.state !== 'speaking') setSpeakingMessageId(null);
  }, [voice.state]);

  function handleSpeakAnswer(message: Extract<Message, { role: 'assistant' }>) {
    if (speakingMessageId === message.id && voice.state === 'speaking') {
      voice.stopSpeaking();
      return;
    }
    voice.speak(message.text, detectLang(message.text));
    setSpeakingMessageId(message.id);
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    sendQuestion(composerValue);
  }

  function handleChipClick(chip: ChipKey) {
    setActiveChip(chip);
    if (chip === 'all') return;
    const first = MODES[chip].suggestions[0];
    setComposerValue(first);
  }

  function handleSuggestion(text: string) {
    setComposerValue(text);
    sendQuestion(text);
  }

  const isLoading = askState.kind === 'loading';
  const isEmpty = messages.length === 0 && askState.kind !== 'loading';

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="h-16 px-4 md:px-8 flex items-center justify-between border-b border-border bg-bg">
        <div className="flex items-center gap-3 min-w-0">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-accent-tint text-accent">
            <Compass size={18} strokeWidth={2.2} />
          </span>
          <div className="min-w-0">
            <h1 className="text-base md:text-lg font-semibold tracking-tight text-ink leading-none">
              Compass ATM
            </h1>
            <p className="hidden sm:block text-xs text-ink-muted mt-1 leading-none">
              Ask Bocconi. Navigate Milan.
            </p>
          </div>
        </div>
        <StatusDot status={healthStatus} />
      </header>

      {/* Chip strip */}
      <nav
        aria-label="Mission shortcuts"
        className="px-4 md:px-8 py-3 border-b border-border bg-bg"
      >
        <div className="max-w-[1200px] mx-auto flex gap-2 overflow-x-auto no-scrollbar md:flex-wrap snap-x snap-mandatory">
          {CHIP_ORDER.map((chip) => {
            const active = activeChip === chip;
            const Icon =
              chip === 'all' ? Sparkles : MODES[chip as Verticale].Icon;
            return (
              <button
                key={chip}
                type="button"
                onClick={() => handleChipClick(chip)}
                className={[
                  'snap-start shrink-0 inline-flex items-center gap-2 h-9 px-3 rounded-md text-sm transition-colors duration-[120ms] ease-out',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                  active
                    ? 'bg-accent-tint text-accent border border-transparent font-medium'
                    : 'bg-surface-alt text-ink-muted border border-transparent hover:bg-surface hover:text-ink hover:border-border',
                ].join(' ')}
              >
                <Icon size={14} strokeWidth={2} />
                <span className="whitespace-nowrap">{CHIP_LABEL[chip]}</span>
              </button>
            );
          })}
        </div>
      </nav>

      {/* Main grid */}
      <div className="flex-1 px-4 md:px-8 pb-4 md:pb-8 min-h-0">
        <div className="max-w-[1200px] mx-auto md:grid md:grid-cols-[1fr_360px] md:gap-8 h-full">
          {/* Chat column */}
          <section
            aria-label="Chat with Compass"
            className="flex flex-col min-h-0 h-full"
          >
            <div
              ref={threadRef}
              onScroll={handleThreadScroll}
              className="flex-1 overflow-y-auto py-6 space-y-6 min-h-0"
            >
              {isEmpty ? (
                <EmptyState
                  activeChip={activeChip}
                  onPick={handleSuggestion}
                />
              ) : null}

              {messages.map((m) =>
                m.role === 'user' ? (
                  <UserBubble key={m.id} text={m.text} />
                ) : (
                  <AnswerCard
                    key={m.id}
                    message={m}
                    canSpeak={voice.supported.tts}
                    isSpeaking={
                      speakingMessageId === m.id && voice.state === 'speaking'
                    }
                    onToggleSpeak={() => handleSpeakAnswer(m)}
                  />
                ),
              )}

              {isLoading ? <SkeletonAnswer /> : null}
            </div>

            {askState.kind === 'error' ? (
              <div
                role="alert"
                className="mb-3 bg-bg border border-danger rounded-lg p-3 flex items-start gap-3"
              >
                <div className="flex-1 text-sm text-ink">
                  <p className="font-medium">Request paused</p>
                  <p className="text-ink-muted mt-1">{askState.message}</p>
                </div>
                <button
                  type="button"
                  onClick={() => sendQuestion(askState.question)}
                  className="text-sm text-danger underline hover:no-underline focus:outline-none focus-visible:ring-2 focus-visible:ring-danger rounded"
                >
                  Try again
                </button>
              </div>
            ) : null}

            <Composer
              value={composerValue}
              onChange={setComposerValue}
              onSubmit={handleSubmit}
              disabled={isLoading}
              voiceState={voice.state}
              voiceSupported={voice.supported.stt}
              voiceLang={voiceLang}
              onToggleVoiceLang={() =>
                setVoiceLang((l) => (l === 'en-US' ? 'it-IT' : 'en-US'))
              }
              onMicDown={voice.startListening}
              onMicStop={voice.stopListening}
            />
          </section>

          {/* Evidence column (desktop) */}
          <aside
            aria-label="Evidence"
            className="hidden md:block md:sticky md:top-4 md:self-start md:max-h-[calc(100vh-7rem)] md:overflow-y-auto"
          >
            <EvidencePanel messages={messages} />
          </aside>
        </div>
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: 'pending' | 'ok' | 'down' }) {
  const cls =
    status === 'ok'
      ? 'bg-success'
      : status === 'down'
        ? 'bg-danger'
        : 'bg-ink-subtle';
  const label =
    status === 'ok'
      ? 'Backend online'
      : status === 'down'
        ? 'Backend unreachable'
        : 'Checking backend';
  return (
    <span
      role="status"
      aria-live="polite"
      title={label}
      className="inline-flex items-center gap-2 text-xs text-ink-muted"
    >
      <span className={`inline-block h-2 w-2 rounded-full ${cls}`} />
      <span className="hidden sm:inline">
        {status === 'ok' ? 'online' : status === 'down' ? 'offline' : '…'}
      </span>
    </span>
  );
}

function EmptyState({
  activeChip,
  onPick,
}: {
  activeChip: ChipKey;
  onPick: (text: string) => void;
}) {
  // When a vertical chip is active, show that mode's 3-suggestion deck.
  // When "all" is active, render four mode cards (one per vertical) — each
  // showing the mode's first suggestion as a quick pick.
  const isAll = activeChip === 'all';

  return (
    <section className="py-8 md:py-12">
      {/* Hero */}
      <div className="hero-grid -mx-2 px-4 py-8 md:py-10 rounded-2xl">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
          <Sparkles size={12} strokeWidth={2.2} />
          Compass ATM · grounded RAG
        </div>
        <h2 className="text-3xl md:text-4xl font-semibold tracking-tight text-ink mt-3">
          Ask Bocconi. Navigate Milan.
        </h2>
        <p className="text-base text-ink-muted mt-3 max-w-xl">
          A grounded answer engine for relocation, campus life, exchange, and
          career questions. Every claim is cited; if the sources don't say it,
          Compass abstains.
        </p>
        {/* Capability strip — descriptors only, no invented metrics. */}
        <ul className="mt-5 flex flex-wrap gap-2">
          {[
            { Icon: Database, text: 'Hybrid retrieval (FAISS + BM25)' },
            { Icon: ShieldCheck, text: 'Grounded — no hallucination' },
            { Icon: BookOpen, text: 'Inline citations' },
            { Icon: Volume2, text: 'Voice in & out' },
          ].map(({ Icon, text }) => (
            <li
              key={text}
              className="inline-flex items-center gap-1.5 text-xs text-ink-muted bg-surface border border-border rounded-full px-2.5 py-1"
            >
              <Icon size={12} strokeWidth={2.2} />
              {text}
            </li>
          ))}
        </ul>
      </div>

      {/* Mode deck (when no specific vertical is selected) */}
      {isAll ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-6">
          {(['relocation', 'life_on_campus', 'study_abroad', 'career_readiness'] as Verticale[]).map(
            (v) => {
              const mode = MODES[v];
              const accent = VERT_COLOR[v];
              const suggestion = mode.suggestions[0];
              return (
                <button
                  key={v}
                  type="button"
                  onClick={() => onPick(suggestion)}
                  className="group text-left bg-surface border border-border rounded-xl p-4 transition-colors duration-[120ms] hover:border-border-strong active:scale-[0.99] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg shadow-[0_1px_0_rgba(14,17,22,0.04)]"
                  style={{ borderLeftColor: accent.fg, borderLeftWidth: 4 }}
                >
                  <div className="flex items-center gap-2.5">
                    <span
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md"
                      style={{ backgroundColor: accent.tint, color: accent.fg }}
                    >
                      <mode.Icon size={16} strokeWidth={2.2} />
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-ink leading-tight">
                        {mode.label}
                      </p>
                      <p className="text-xs text-ink-muted leading-tight mt-0.5">
                        {mode.description}
                      </p>
                    </div>
                  </div>
                  <p className="text-sm text-ink mt-3 group-hover:text-ink">
                    {suggestion}
                  </p>
                </button>
              );
            },
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-6">
          {MODES[activeChip as Verticale].suggestions.slice(0, 4).map((s) => {
            const accent = VERT_COLOR[activeChip as Verticale];
            return (
              <button
                key={s}
                type="button"
                onClick={() => onPick(s)}
                className="text-left bg-surface border border-border rounded-xl p-4 text-sm text-ink transition-colors duration-[120ms] hover:border-border-strong active:scale-[0.99] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg shadow-[0_1px_0_rgba(14,17,22,0.04)]"
                style={{ borderLeftColor: accent.fg, borderLeftWidth: 4 }}
              >
                {s}
              </button>
            );
          })}
        </div>
      )}

      {/* How it works — visible info strip explaining the pipeline at a glance */}
      <div className="mt-8 grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-3">
        {[
          { Icon: Globe, title: 'Curated corpus', sub: 'Bocconi + Milan sources' },
          { Icon: Database, title: 'Hybrid retrieval', sub: 'Dense + lexical, fused' },
          { Icon: Sparkles, title: 'LLM rerank', sub: 'GPT-5.4 scores chunks' },
          { Icon: ShieldCheck, title: 'Confidence gate', sub: 'Abstain if unsure' },
        ].map(({ Icon, title, sub }) => (
          <div
            key={title}
            className="bg-surface border border-border rounded-lg p-3"
          >
            <div className="inline-flex h-6 w-6 items-center justify-center rounded bg-accent-tint text-accent">
              <Icon size={12} strokeWidth={2.2} />
            </div>
            <p className="text-xs font-semibold text-ink mt-2">{title}</p>
            <p className="text-[11px] text-ink-muted leading-tight">{sub}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] md:max-w-[75%] bg-surface-alt rounded-xl px-4 py-3 text-base text-ink whitespace-pre-wrap">
        {text}
      </div>
    </div>
  );
}

function SkeletonAnswer() {
  return (
    <div className="space-y-3 py-2" aria-label="Compass is thinking">
      <div className="skeleton-line" style={{ width: '80%' }} />
      <div className="skeleton-line" style={{ width: '100%' }} />
      <div className="skeleton-line" style={{ width: '60%' }} />
    </div>
  );
}

function AnswerCard({
  message,
  canSpeak,
  isSpeaking,
  onToggleSpeak,
}: {
  message: Extract<Message, { role: 'assistant' }>;
  canSpeak: boolean;
  isSpeaking: boolean;
  onToggleSpeak: () => void;
}) {
  const mode = MODES[message.verticale];
  const Icon = mode.Icon;
  const accent = VERT_COLOR[message.verticale];

  const { lead, body, notes, isAbstention, cleanedText } = useMemo(
    () => structureAnswer(message.text),
    [message.text],
  );

  const sources = message.sources;
  // Left-edge accent stripe + tinted badge by vertical.
  const cardStyle: CSSProperties = {
    borderLeftColor: accent.fg,
    borderLeftWidth: 4,
  };
  const badgeStyle: CSSProperties = {
    backgroundColor: accent.tint,
    color: accent.fg,
  };

  if (isAbstention) {
    return (
      <article
        className="bg-surface border border-border rounded-xl p-5 md:p-6"
        style={cardStyle}
      >
        <div className="flex items-center justify-between gap-3 mb-3">
          <span
            className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider rounded px-2 py-0.5"
            style={badgeStyle}
          >
            <Icon size={12} strokeWidth={2.2} />
            {mode.label}
          </span>
          {canSpeak ? (
            <SpeakButton isSpeaking={isSpeaking} onClick={onToggleSpeak} />
          ) : null}
        </div>
        <p className="text-base text-ink-muted">{cleanedText}</p>
        {sources.length > 0 ? (
          <MobileSourcesDetails sources={sources} />
        ) : null}
      </article>
    );
  }

  return (
    <article
      className="bg-surface border border-border rounded-xl p-5 md:p-6"
      style={cardStyle}
    >
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider rounded px-2 py-0.5"
            style={badgeStyle}
          >
            <Icon size={12} strokeWidth={2.2} />
            {mode.label}
          </span>
          {sources.length > 0 ? (
            <span className="text-xs text-ink-muted">
              · {sources.length} source{sources.length === 1 ? '' : 's'}
            </span>
          ) : null}
        </div>
        {canSpeak ? (
          <SpeakButton isSpeaking={isSpeaking} onClick={onToggleSpeak} />
        ) : null}
      </div>

      {lead ? (
        <p className="text-lg leading-7 font-medium text-ink mb-4">{lead}</p>
      ) : null}

      <BlockList blocks={body} />

      {notes.length > 0 ? (
        <div className="mt-5 pt-4 border-t border-border">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted mb-2">
            Worth noting
          </p>
          {notes.length === 1 ? (
            <p className="text-sm text-ink-muted">{notes[0]}</p>
          ) : (
            <ul className="text-sm text-ink-muted list-disc pl-5 space-y-1">
              {notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {sources.length > 0 ? (
        <MobileSourcesDetails sources={sources} />
      ) : null}
    </article>
  );
}

function SpeakButton({
  isSpeaking,
  onClick,
}: {
  isSpeaking: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={isSpeaking ? 'Stop reading aloud' : 'Read answer aloud'}
      title={isSpeaking ? 'Stop reading aloud' : 'Read answer aloud'}
      className={[
        'shrink-0 inline-flex items-center justify-center h-7 w-7 rounded-md border transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
        isSpeaking
          ? 'bg-accent text-accent-fg border-accent'
          : 'bg-surface-alt text-ink-muted border-border hover:text-ink hover:border-border-strong',
      ].join(' ')}
    >
      {isSpeaking ? (
        <CircleStop size={13} strokeWidth={2.2} />
      ) : (
        <Volume2 size={13} strokeWidth={2.2} />
      )}
    </button>
  );
}

function MobileSourcesDetails({ sources }: { sources: string[] }) {
  return (
    <details className="md:hidden mt-4 pt-4 border-t border-border group">
      <summary className="list-none cursor-pointer text-sm text-accent inline-flex items-center gap-1.5 select-none">
        <ChevronDown
          size={14}
          className="transition-transform group-open:rotate-180"
        />
        {sources.length} source{sources.length === 1 ? '' : 's'}
      </summary>
      <ul className="mt-3 space-y-1">
        {sources.map((s) => (
          <li key={s}>
            <SourceRow path={s} />
          </li>
        ))}
      </ul>
    </details>
  );
}

function EvidencePanel({ messages }: { messages: Message[] }) {
  const latest = [...messages]
    .reverse()
    .find((m): m is Extract<Message, { role: 'assistant' }> => m.role === 'assistant');

  const sources = latest?.sources ?? [];

  return (
    <section className="bg-surface border border-border rounded-xl p-5 mt-4">
      <div className="flex items-center justify-between mb-4">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
          Evidence
        </p>
        {sources.length > 0 ? (
          <span className="text-xs text-ink-muted">
            {sources.length} source{sources.length === 1 ? '' : 's'}
          </span>
        ) : null}
      </div>

      {sources.length === 0 ? (
        <p className="text-sm text-ink-muted">
          Source rows appear here after Compass answers with citations.
        </p>
      ) : (
        <ul className="space-y-1">
          {sources.map((s) => (
            <li key={s}>
              <SourceRow path={s} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SourceRow({ path }: { path: string }) {
  const { label, caption } = useMemo(() => labelFromPath(path), [path]);
  return (
    <button
      type="button"
      title={path}
      aria-label={`Source: ${label}`}
      className="w-full text-left rounded-md p-3 transition-colors duration-[120ms] hover:bg-surface-alt focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
    >
      <p className="text-sm font-medium text-ink">{label}</p>
      <p className="text-xs text-ink-muted font-mono mt-1 break-all">
        {caption}
      </p>
    </button>
  );
}

function Composer({
  value,
  onChange,
  onSubmit,
  disabled,
  voiceState,
  voiceSupported,
  voiceLang,
  onToggleVoiceLang,
  onMicDown,
  onMicStop,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  disabled: boolean;
  voiceState: VoiceState;
  voiceSupported: boolean;
  voiceLang: 'en-US' | 'it-IT';
  onToggleVoiceLang: () => void;
  onMicDown: () => void;
  onMicStop: () => void;
}) {
  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.currentTarget.form?.requestSubmit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onChange('');
    }
  }

  const canSend = value.trim().length > 0 && !disabled;
  const isListening = voiceState === 'listening';
  const micDisabled = disabled || !voiceSupported;
  const langShort = voiceLang === 'en-US' ? 'EN' : 'IT';

  return (
    <form
      onSubmit={onSubmit}
      className="sticky bottom-0 bg-bg/95 backdrop-blur pt-3 pb-[max(env(safe-area-inset-bottom),12px)]"
    >
      {isListening ? (
        <div
          role="status"
          aria-live="polite"
          className="mb-2 flex items-center gap-2 text-xs text-danger"
        >
          <span className="inline-block h-2 w-2 rounded-full bg-danger voice-listening" />
          <span>Listening… speak naturally, I'll send it when you stop.</span>
        </div>
      ) : null}
      <label htmlFor="composer-input" className="sr-only">
        Ask Compass a question
      </label>
      <div className="bg-surface border border-border rounded-lg flex items-end gap-2 p-2 focus-within:border-accent focus-within:ring-1 focus-within:ring-accent/30 transition-colors">
        <textarea
          id="composer-input"
          rows={1}
          placeholder={
            isListening ? 'Listening…' : 'Ask about Bocconi, Milan, exchange, career…'
          }
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
          className="flex-1 min-h-[40px] max-h-40 bg-transparent text-base text-ink placeholder:text-ink-subtle outline-none disabled:text-ink-subtle disabled:cursor-not-allowed py-2 px-2"
        />
        {voiceSupported ? (
          <button
            type="button"
            onClick={onToggleVoiceLang}
            disabled={disabled || isListening}
            title={`Voice language: ${voiceLang}. Click to switch.`}
            aria-label={`Voice language: ${voiceLang}. Click to switch.`}
            className="hidden sm:inline-flex items-center justify-center h-9 px-2 rounded-md text-[11px] font-semibold tracking-wider text-ink-muted bg-surface-alt border border-border hover:text-ink hover:border-border-strong disabled:opacity-50"
          >
            {langShort}
          </button>
        ) : null}
        <button
          type="button"
          onClick={isListening ? onMicStop : onMicDown}
          disabled={micDisabled}
          aria-label={
            !voiceSupported
              ? 'Voice input not supported in this browser'
              : isListening
                ? 'Stop listening'
                : 'Start voice input'
          }
          title={
            !voiceSupported
              ? 'Voice input not supported in this browser'
              : isListening
                ? 'Stop listening'
                : 'Start voice input'
          }
          className={[
            'inline-flex items-center justify-center h-9 w-9 rounded-md border transition-colors',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
            isListening
              ? 'bg-danger text-bg border-danger voice-listening'
              : !voiceSupported
                ? 'bg-surface-alt text-ink-subtle border-border cursor-not-allowed'
                : 'bg-surface-alt text-ink-muted border-border hover:bg-surface hover:text-ink hover:border-border-strong',
          ].join(' ')}
        >
          {isListening ? (
            <CircleStop size={16} strokeWidth={2} />
          ) : !voiceSupported ? (
            <MicOff size={16} strokeWidth={2} />
          ) : (
            <Mic size={16} strokeWidth={2} />
          )}
        </button>
        <button
          type="submit"
          disabled={!canSend}
          className={[
            'inline-flex items-center justify-center gap-1.5 h-9 px-4 rounded-md font-medium text-sm transition-colors',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
            canSend
              ? 'bg-accent text-accent-fg hover:bg-[#16306B] active:scale-[0.98]'
              : 'bg-ink-subtle text-bg cursor-not-allowed',
          ].join(' ')}
        >
          {disabled ? (
            <Spinner />
          ) : (
            <>
              <Send size={14} strokeWidth={2.2} />
              <span>Send</span>
            </>
          )}
        </button>
      </div>
    </form>
  );
}

function Spinner() {
  return (
    <svg
      className="animate-spin"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.3"
        strokeWidth="3"
      />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ---------- Block rendering ----------

type Block =
  | { kind: 'heading'; level: 3 | 4; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'table'; rows: string[][] };

function BlockList({ blocks }: { blocks: Block[] }) {
  return (
    <div className="space-y-3">
      {blocks.map((block, i) => {
        if (block.kind === 'heading') {
          if (block.level === 3) {
            return (
              <h3 key={i} className="text-base font-semibold text-ink mt-2">
                <Inline text={block.text} />
              </h3>
            );
          }
          return (
            <h4 key={i} className="text-sm font-semibold text-ink mt-2">
              <Inline text={block.text} />
            </h4>
          );
        }
        if (block.kind === 'list') {
          if (block.ordered) {
            return (
              <ol key={i} className="space-y-2 mt-1">
                {block.items.map((item, idx) => (
                  <li key={idx} className="flex gap-3 text-base text-ink">
                    <span className="shrink-0 inline-flex items-center justify-center h-5 w-5 rounded-full bg-accent-tint text-accent text-xs font-semibold mt-0.5">
                      {idx + 1}
                    </span>
                    <span className="flex-1">
                      <Inline text={item} />
                    </span>
                  </li>
                ))}
              </ol>
            );
          }
          return (
            <ul key={i} className="list-disc pl-5 space-y-1.5 text-base text-ink">
              {block.items.map((item, idx) => (
                <li key={idx}>
                  <Inline text={item} />
                </li>
              ))}
            </ul>
          );
        }
        if (block.kind === 'table') {
          const [head, ...body] = block.rows;
          return (
            <div key={i} className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr>
                    {head.map((cell, c) => (
                      <th
                        key={c}
                        className="text-left font-semibold text-ink border-b border-border py-2 pr-3"
                      >
                        <Inline text={cell} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {body.map((row, r) => (
                    <tr key={r}>
                      {row.map((cell, c) => (
                        <td
                          key={c}
                          className="text-ink-muted border-b border-border py-2 pr-3 align-top"
                        >
                          <Inline text={cell} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        return (
          <p key={i} className="text-base text-ink-muted leading-7">
            <Inline text={block.text} />
          </p>
        );
      })}
    </div>
  );
}

// Inline formatter handles **bold** and *italic*. No markdown library.
function Inline({ text }: { text: string }) {
  const parts = parseInline(text);
  return (
    <>
      {parts.map((p, i) => {
        if (p.kind === 'bold')
          return <strong key={i} className="font-semibold text-ink">{p.text}</strong>;
        if (p.kind === 'italic') return <em key={i}>{p.text}</em>;
        if (p.kind === 'code')
          return (
            <code
              key={i}
              className="font-mono text-[0.9em] bg-surface-alt rounded px-1 py-0.5"
            >
              {p.text}
            </code>
          );
        return <Fragment key={i}>{p.text}</Fragment>;
      })}
    </>
  );
}

type InlinePart =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'italic'; text: string }
  | { kind: 'code'; text: string };

function parseInline(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  // Match in priority: code, bold (**), italic (*).
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) {
      parts.push({ kind: 'text', text: text.slice(last, m.index) });
    }
    const tok = m[0];
    if (tok.startsWith('**')) {
      parts.push({ kind: 'bold', text: tok.slice(2, -2) });
    } else if (tok.startsWith('`')) {
      parts.push({ kind: 'code', text: tok.slice(1, -1) });
    } else {
      parts.push({ kind: 'italic', text: tok.slice(1, -1) });
    }
    last = pattern.lastIndex;
  }
  if (last < text.length) {
    parts.push({ kind: 'text', text: text.slice(last) });
  }
  return parts.length > 0 ? parts : [{ kind: 'text', text }];
}

// ---------- Answer structuring ----------

type Structured = {
  lead: string | null;
  body: Block[];
  notes: string[];
  isAbstention: boolean;
  cleanedText: string;
};

function structureAnswer(raw: string): Structured {
  const cleaned = stripCitations(raw);
  const isAbstention = ABSTENTION_PATTERN.test(cleaned);

  if (isAbstention) {
    return {
      lead: null,
      body: [],
      notes: [],
      isAbstention: true,
      cleanedText: cleaned.trim(),
    };
  }

  const blocks = parseMarkdownBlocks(cleaned);

  // Pull out "worth noting" paragraphs — by prefix.
  const notes: string[] = [];
  const remaining: Block[] = [];
  for (const b of blocks) {
    if (b.kind === 'paragraph' && NOTE_PREFIX.test(b.text.trim())) {
      notes.push(b.text.replace(NOTE_PREFIX, '').trim().replace(/^[:,]\s*/, ''));
    } else {
      remaining.push(b);
    }
  }

  // Lead = first paragraph if short.
  let lead: string | null = null;
  let body = remaining;
  const first = remaining[0];
  if (first && first.kind === 'paragraph' && first.text.length <= 220) {
    lead = first.text;
    body = remaining.slice(1);
  }

  return { lead, body, notes, isAbstention: false, cleanedText: cleaned };
}

function stripCitations(text: string): string {
  return text.replace(/\[source:\s*[^\]]+\]/gi, '').replace(/[ \t]+\n/g, '\n');
}

function parseMarkdownBlocks(markdown: string): Block[] {
  const lines = markdown.split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) {
      i += 1;
      continue;
    }

    if (line.startsWith('### ')) {
      blocks.push({ kind: 'heading', level: 4, text: line.slice(4).trim() });
      i += 1;
      continue;
    }
    if (line.startsWith('## ')) {
      blocks.push({ kind: 'heading', level: 3, text: line.slice(3).trim() });
      i += 1;
      continue;
    }
    if (line.startsWith('# ')) {
      blocks.push({ kind: 'heading', level: 3, text: line.slice(2).trim() });
      i += 1;
      continue;
    }

    if (
      isTableLine(line) &&
      lines[i + 1] &&
      isDividerLine(lines[i + 1].trim())
    ) {
      const rows: string[][] = [];
      while (i < lines.length && isTableLine(lines[i].trim())) {
        if (!isDividerLine(lines[i].trim())) {
          rows.push(parseTableRow(lines[i]));
        }
        i += 1;
      }
      blocks.push({ kind: 'table', rows });
      continue;
    }

    const listMatch = line.match(/^(\d+\.|[-*])\s+(.+)/);
    if (listMatch) {
      const ordered = /\d+\./.test(listMatch[1]);
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i].trim().match(/^(\d+\.|[-*])\s+(.+)/);
        if (!m) break;
        const ord = /\d+\./.test(m[1]);
        if (ord !== ordered) break;
        items.push(m[2].trim());
        i += 1;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    const para: string[] = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].trim().match(/^(\d+\.|[-*])\s+(.+)/) &&
      !lines[i].trim().startsWith('#') &&
      !isTableLine(lines[i].trim())
    ) {
      para.push(lines[i].trim());
      i += 1;
    }
    blocks.push({ kind: 'paragraph', text: para.join(' ') });
  }

  return blocks;
}

function isTableLine(line: string) {
  return line.startsWith('|') && line.endsWith('|');
}
function isDividerLine(line: string) {
  return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(line.trim());
}
function parseTableRow(line: string) {
  return line
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());
}

// ---------- Source labeler ----------

const TLD_TOKENS = new Set([
  'com',
  'it',
  'eu',
  'org',
  'net',
  'xyz',
  'io',
  'edu',
  'gov',
  'ac',
  'info',
  'co',
]);
const GENERIC_PREFIX = new Set([
  'en',
  'it',
  'hc',
  'us',
  'articles',
  'article',
  'dataset',
  'sintesi',
  'scheda',
  'paese',
  'help',
  'support',
  'knowledge',
  'kb',
  'blog',
  'page',
  'pages',
  'p',
]);
const BRAND_LOOKUP: Array<[string, string]> = [
  ['bit.unibocconi', 'Bocconi Help'],
  ['unibocconi', 'Bocconi'],
  ['dati.comune.milano', 'Comune di Milano'],
  ['comune.milano', 'Comune di Milano'],
  ['almalaurea', 'AlmaLaurea'],
  ['viaggiaresicuri', 'Viaggiare Sicuri'],
  ['roomlessrent', 'Roomless Rent'],
];
const PLATFORM_TOKENS = new Set(['wixsite', 'wordpress', 'blogspot']);

function basename(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path;
}

function labelFromPath(path: string): { label: string; caption: string } {
  try {
    let p = path;
    // Strip leading verticale/
    p = p.replace(/^(relocation|life_on_campus|study_abroad|career_readiness)\//, '');
    // Strip trailing .md
    p = p.replace(/\.md$/, '');

    const tokens = p.split('-').filter(Boolean);
    if (tokens.length === 0) {
      throw new Error('empty');
    }

    // Collect domain tokens until we hit a TLD.
    const domain: string[] = [];
    let cut = 0;
    for (let idx = 0; idx < tokens.length; idx += 1) {
      domain.push(tokens[idx]);
      if (TLD_TOKENS.has(tokens[idx])) {
        cut = idx + 1;
        break;
      }
    }
    if (cut === 0) {
      // No TLD found — assume first token is domain.
      cut = 1;
    }
    const tail = tokens.slice(cut);
    const domainStr = domain.join('.');

    // Brand lookup.
    let brand: string | null = null;
    for (const [needle, b] of BRAND_LOOKUP) {
      if (domainStr.includes(needle)) {
        brand = b;
        break;
      }
    }
    if (!brand) {
      // Skip platform tokens; pick first non-platform domain token.
      const root =
        domain.find((t) => !PLATFORM_TOKENS.has(t) && !TLD_TOKENS.has(t)) ??
        domain[0];
      brand = titleCase(root);
    }

    // Drop generic URL noise, then strip leading purely-numeric tokens
    // (KB article IDs like "4405876182418"). Keep numeric tokens that appear
    // mid-slug — they often carry meaning ("2024", "ds538").
    const filtered = tail.filter((t) => !GENERIC_PREFIX.has(t));
    let start = 0;
    while (start < filtered.length && /^\d+$/.test(filtered[start])) {
      start += 1;
    }
    const labelTail = filtered
      .slice(start)
      .map((t) => titleCaseToken(t))
      .join(' ')
      .trim();

    let label = labelTail
      ? `${brand} · ${labelTail}`
      : brand;
    if (label.length > 70) {
      label = label.slice(0, 69).trimEnd() + '…';
    }

    const caption = tail.length
      ? `${domainStr} · ${tail.join('/')}`
      : domainStr;

    return { label, caption };
  } catch {
    const fallback = basename(path).replace(/-/g, ' ').replace(/\.md$/, '');
    return { label: fallback, caption: path };
  }
}

function titleCase(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Keep numeric/ID tokens like "ds538" or "2024" verbatim; otherwise capitalize.
function titleCaseToken(t: string): string {
  if (/\d/.test(t)) return t;
  return titleCase(t);
}

export default App;
