import {
  FormEvent,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:8000';

type ModeKey =
  | 'relocation'
  | 'life_on_campus'
  | 'study_abroad'
  | 'career_readiness';

type AskResponse = {
  answer: string;
  sources: string[];
  verticale: ModeKey;
};

type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

type ChatMessage =
  | {
      id: string;
      role: 'user';
      content: string;
      mode: ModeKey;
    }
  | {
      id: string;
      role: 'assistant';
      content: string;
      mode: ModeKey;
      sources: string[];
      createdAt: number;
    };

type RequestStatus =
  | { kind: 'idle' }
  | { kind: 'loading'; question: string }
  | { kind: 'error'; message: string; question: string };

type AppState = {
  activeMode: ModeKey;
  messages: ChatMessage[];
  requestStatus: RequestStatus;
  evidenceOpen: boolean;
  highlightedSource: string | null;
  selectedAssistantId: string | null;
  modePanelOpen: boolean;
};

type AppAction =
  | { type: 'set_mode'; mode: ModeKey }
  | { type: 'start_request'; question: string; mode: ModeKey; userId: string }
  | { type: 'receive_answer'; response: AskResponse; assistantId: string }
  | { type: 'request_error'; message: string }
  | { type: 'toggle_evidence'; open?: boolean }
  | { type: 'highlight_source'; source: string; assistantId: string }
  | { type: 'clear_highlight' }
  | { type: 'toggle_mode_panel'; open?: boolean };

type ModeDefinition = {
  key: ModeKey;
  label: string;
  shortLabel: string;
  description: string;
  intro: string;
  tintVar: string;
  icon: IconName;
  suggestions: string[];
};

type IconName =
  | 'compass'
  | 'building'
  | 'plane'
  | 'briefcase'
  | 'database'
  | 'send'
  | 'mic'
  | 'x'
  | 'check'
  | 'chevron';

type SpeechRecognitionResultLike = {
  readonly length: number;
  item(index: number): { transcript: string };
  [index: number]: { transcript: string };
};

type SpeechRecognitionEventLike = Event & {
  readonly results: {
    readonly length: number;
    item(index: number): SpeechRecognitionResultLike;
    [index: number]: SpeechRecognitionResultLike;
  };
};

type SpeechRecognitionLike = EventTarget & {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
    __compassAudioContextState?: AudioContextState | 'unavailable';
  }
}

const MODES: Record<ModeKey, ModeDefinition> = {
  relocation: {
    key: 'relocation',
    label: 'Settle in Milan',
    shortLabel: 'Milan',
    description: 'Visa, housing, transport, city admin.',
    intro: 'Visa, codice fiscale, rent, SIM. Ask anything about landing in Milan.',
    tintVar: '--color-vert-relocation',
    icon: 'compass',
    suggestions: [
      'How do I open an Italian bank account as a non-resident?',
      "What's a fair monthly rent budget near Bocconi?",
      'Where do I get my codice fiscale?',
    ],
  },
  life_on_campus: {
    key: 'life_on_campus',
    label: 'Campus Life',
    shortLabel: 'Campus',
    description: 'Library, dining, sport, associations.',
    intro: 'Library, dining, sports, associations. Find your way around campus.',
    tintVar: '--color-vert-life-on-campus',
    icon: 'building',
    suggestions: [
      'Can I bring guests into the library?',
      'What dining options are on campus?',
      'How do I join a student association?',
    ],
  },
  study_abroad: {
    key: 'study_abroad',
    label: 'Study Abroad',
    shortLabel: 'Abroad',
    description: 'Exchange, double degrees, deadlines.',
    intro: 'Exchange, double degrees, deadlines, scoring. Plan your semester away.',
    tintVar: '--color-vert-study-abroad',
    icon: 'plane',
    suggestions: [
      'Which partner universities offer Double Degrees in Finance?',
      'When do exchange applications open?',
      'How is the exchange selection score calculated?',
    ],
  },
  career_readiness: {
    key: 'career_readiness',
    label: 'Career',
    shortLabel: 'Career',
    description: 'Internships, scholarships, salaries.',
    intro: 'Internships, scholarships, salaries, services. Map your next step.',
    tintVar: '--color-vert-career-readiness',
    icon: 'briefcase',
    suggestions: [
      "What's the average salary for Bocconi MSc Finance grads?",
      'When does the curricular internship application close?',
      'Which scholarships are available for international MSc students?',
    ],
  },
};

const MODE_ORDER: ModeKey[] = [
  'relocation',
  'life_on_campus',
  'study_abroad',
  'career_readiness',
];

const ABSTENTION_PATTERN =
  /\b(there is no|there are no|i don't have|i do not have|no information|not in (the )?sources|non ho (informazioni|le informazioni)|non c'è|non risulta|le fonti non)\b/i;

const COST_PATTERN = /€\s?\d[\d.,]*|\bEUR\s?\d[\d.,]*/g;
const DATE_PATTERN =
  /\b(?:between\s+[^.!?\n]{3,80}\s+and\s+[^.!?\n]{3,80}|applications?\s+open(?:s|ed)?\s+[^.!?\n]{0,80}|(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:,\s*\d{4})?|\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)(?:\s+\d{4})?)/gi;

function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'set_mode':
      return { ...state, activeMode: action.mode };
    case 'start_request': {
      const userMessage: ChatMessage = {
        id: action.userId,
        role: 'user',
        content: action.question,
        mode: action.mode,
      };
      return {
        ...state,
        messages: [...state.messages, userMessage],
        requestStatus: { kind: 'loading', question: action.question },
        activeMode: action.mode,
        modePanelOpen: false,
      };
    }
    case 'receive_answer': {
      const assistantMessage: ChatMessage = {
        id: action.assistantId,
        role: 'assistant',
        content: action.response.answer,
        sources: action.response.sources,
        mode: action.response.verticale,
        createdAt: Date.now(),
      };
      return {
        ...state,
        messages: [...state.messages, assistantMessage],
        requestStatus: { kind: 'idle' },
        activeMode: action.response.verticale,
        selectedAssistantId: action.assistantId,
        modePanelOpen: true,
      };
    }
    case 'request_error':
      if (state.requestStatus.kind !== 'loading') {
        return state;
      }
      return {
        ...state,
        requestStatus: {
          kind: 'error',
          message: action.message,
          question: state.requestStatus.question,
        },
      };
    case 'toggle_evidence':
      return {
        ...state,
        evidenceOpen: action.open ?? !state.evidenceOpen,
      };
    case 'highlight_source':
      return {
        ...state,
        evidenceOpen: true,
        highlightedSource: action.source,
        selectedAssistantId: action.assistantId,
      };
    case 'clear_highlight':
      return { ...state, highlightedSource: null };
    case 'toggle_mode_panel':
      return {
        ...state,
        modePanelOpen: action.open ?? !state.modePanelOpen,
      };
    default:
      return state;
  }
}

const initialState: AppState = {
  activeMode: 'relocation',
  messages: [],
  requestStatus: { kind: 'idle' },
  evidenceOpen: false,
  highlightedSource: null,
  selectedAssistantId: null,
  modePanelOpen: false,
};

function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const sourceRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const assistantMessages = state.messages.filter(
    (message): message is Extract<ChatMessage, { role: 'assistant' }> =>
      message.role === 'assistant',
  );
  const selectedAssistant =
    assistantMessages.find((message) => message.id === state.selectedAssistantId) ??
    assistantMessages.at(-1) ??
    null;

  const latestConfidence = selectedAssistant
    ? getConfidence(selectedAssistant.content, selectedAssistant.sources)
    : 'LOW';

  async function askQuestion(question: string, mode = state.activeMode) {
    const trimmedQuestion = question.trim();
    if (!trimmedQuestion || state.requestStatus.kind === 'loading') {
      return;
    }

    const userId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    dispatch({ type: 'start_request', question: trimmedQuestion, mode, userId });

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 30_000);

    try {
      const response = await fetch(`${BACKEND_URL}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: trimmedQuestion }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
      }

      const data = (await response.json()) as AskResponse;
      dispatch({ type: 'receive_answer', response: data, assistantId });
    } catch (error) {
      const message =
        error instanceof DOMException && error.name === 'AbortError'
          ? 'Compass needed more than 30 seconds. Try a narrower question or retry when the backend is back.'
          : 'Compass could not reach the backend. Your question is still here; retry when the service is available.';
      dispatch({ type: 'request_error', message });
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function handleSourceClick(source: string, assistantId: string) {
    dispatch({ type: 'highlight_source', source, assistantId });
    window.setTimeout(() => {
      sourceRefs.current[source]?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }, 80);
    window.setTimeout(() => dispatch({ type: 'clear_highlight' }), 1_400);
  }

  return (
    <main className="app-shell">
      <Header
        activeMode={state.activeMode}
        onToggleEvidence={() => dispatch({ type: 'toggle_evidence' })}
      />

      <div className="mobile-modes">
        <ModePills
          activeMode={state.activeMode}
          onSelect={(mode) => dispatch({ type: 'set_mode', mode })}
        />
      </div>

      <div className="desktop-layout">
        <aside className="left-rail" aria-label="Mission modes">
          {MODE_ORDER.map((mode) => (
            <ModeTile
              key={mode}
              mode={MODES[mode]}
              active={state.activeMode === mode}
              onClick={() => dispatch({ type: 'set_mode', mode })}
            />
          ))}
        </aside>

        <section className="chat-column" aria-label="Chat with Compass">
          <ChatThread
            activeMode={state.activeMode}
            messages={state.messages}
            requestStatus={state.requestStatus}
            onAsk={askQuestion}
            onSourceClick={handleSourceClick}
          />

          <div className="mobile-plan">
            <button
              className="mode-panel-toggle"
              type="button"
              onClick={() => dispatch({ type: 'toggle_mode_panel' })}
            >
              <span>Plan from this answer</span>
              <Icon name="chevron" />
            </button>
            {state.modePanelOpen ? (
              <ModePanel
                mode={MODES[selectedAssistant?.mode ?? state.activeMode]}
                message={selectedAssistant}
                confidence={latestConfidence}
              />
            ) : null}
          </div>

          <Composer
            activeMode={state.activeMode}
            disabled={state.requestStatus.kind === 'loading'}
            onSubmit={askQuestion}
            retryQuestion={
              state.requestStatus.kind === 'error'
                ? state.requestStatus.question
                : null
            }
          />
        </section>

        <aside className="right-rail" aria-label="Plan and evidence">
          <ModePanel
            mode={MODES[selectedAssistant?.mode ?? state.activeMode]}
            message={selectedAssistant}
            confidence={latestConfidence}
          />
          <EvidenceDrawer
            message={selectedAssistant}
            confidence={latestConfidence}
            highlightedSource={state.highlightedSource}
            sourceRefs={sourceRefs}
          />
        </aside>
      </div>

      <MobileEvidenceSheet
        open={state.evidenceOpen}
        message={selectedAssistant}
        confidence={latestConfidence}
        highlightedSource={state.highlightedSource}
        sourceRefs={sourceRefs}
        onClose={() => dispatch({ type: 'toggle_evidence', open: false })}
      />
    </main>
  );
}

function Header({
  activeMode,
  onToggleEvidence,
}: {
  activeMode: ModeKey;
  onToggleEvidence: () => void;
}) {
  return (
    <header className="app-header">
      <div className="wordmark">
        <span
          className="wordmark-icon"
          style={{ '--mode-tint': `var(${MODES[activeMode].tintVar})` }}
        >
          <Icon name="compass" />
        </span>
        <div>
          <p className="eyebrow">Bocconi</p>
          <h1>Compass</h1>
        </div>
      </div>
      <button
        className="icon-button"
        type="button"
        aria-label="Open evidence drawer"
        onClick={onToggleEvidence}
      >
        <Icon name="database" />
      </button>
    </header>
  );
}

function ModePills({
  activeMode,
  onSelect,
}: {
  activeMode: ModeKey;
  onSelect: (mode: ModeKey) => void;
}) {
  return (
    <div className="mode-pills" aria-label="Mission mode picker">
      {MODE_ORDER.map((mode) => {
        const config = MODES[mode];
        return (
          <button
            key={mode}
            className={`mode-pill ${activeMode === mode ? 'is-active' : ''}`}
            type="button"
            style={{ '--mode-tint': `var(${config.tintVar})` }}
            onClick={() => onSelect(mode)}
          >
            <Icon name={config.icon} />
            <span>{config.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function ModeTile({
  mode,
  active,
  onClick,
}: {
  mode: ModeDefinition;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`mode-tile ${active ? 'is-active' : ''}`}
      type="button"
      style={{ '--mode-tint': `var(${mode.tintVar})` }}
      onClick={onClick}
    >
      <span className="tile-icon">
        <Icon name={mode.icon} />
      </span>
      <span>
        <strong>{mode.label}</strong>
        <small>{mode.description}</small>
      </span>
    </button>
  );
}

function ChatThread({
  activeMode,
  messages,
  requestStatus,
  onAsk,
  onSourceClick,
}: {
  activeMode: ModeKey;
  messages: ChatMessage[];
  requestStatus: RequestStatus;
  onAsk: (question: string, mode?: ModeKey) => void;
  onSourceClick: (source: string, assistantId: string) => void;
}) {
  const currentMode = MODES[activeMode];

  return (
    <div className="thread">
      {messages.length === 0 ? (
        <EmptyState mode={currentMode} onAsk={onAsk} />
      ) : (
        <div className="message-list">
          {messages.map((message) =>
            message.role === 'user' ? (
              <article key={message.id} className="message user-message">
                <p>{message.content}</p>
              </article>
            ) : (
              <article
                key={message.id}
                className={`message assistant-message ${
                  hasAbstention(message.content) ? 'is-abstention' : ''
                }`}
                style={{
                  '--mode-tint': `var(${MODES[message.mode].tintVar})`,
                }}
              >
                <div className="answer-meta">
                  <span className="mode-badge">
                    <Icon name={MODES[message.mode].icon} />
                    {MODES[message.mode].label}
                  </span>
                  <span className="source-count">
                    {message.sources.length} source
                    {message.sources.length === 1 ? '' : 's'}
                  </span>
                </div>
                <MarkdownAnswer
                  answer={message.content}
                  assistantId={message.id}
                  onSourceClick={onSourceClick}
                />
              </article>
            ),
          )}
        </div>
      )}

      {requestStatus.kind === 'loading' ? (
        <div className="message assistant-message skeleton-message">
          <div className="skeleton-line wide" />
          <div className="skeleton-line" />
          <div className="skeleton-line short" />
        </div>
      ) : null}

      {requestStatus.kind === 'error' ? (
        <div className="calm-error" role="status">
          <strong>Request paused</strong>
          <span>{requestStatus.message}</span>
          <button type="button" onClick={() => onAsk(requestStatus.question)}>
            Try again
          </button>
        </div>
      ) : null}
    </div>
  );
}

function EmptyState({
  mode,
  onAsk,
}: {
  mode: ModeDefinition;
  onAsk: (question: string, mode?: ModeKey) => void;
}) {
  return (
    <section
      className="empty-state"
      style={{ '--mode-tint': `var(${mode.tintVar})` }}
    >
      <div className="empty-icon">
        <Icon name={mode.icon} />
      </div>
      <p className="eyebrow">{mode.label}</p>
      <h2>{mode.intro}</h2>
      <div className="suggestion-grid">
        {mode.suggestions.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => onAsk(suggestion, mode.key)}
          >
            {suggestion}
          </button>
        ))}
      </div>
    </section>
  );
}

function MarkdownAnswer({
  answer,
  assistantId,
  onSourceClick,
}: {
  answer: string;
  assistantId: string;
  onSourceClick: (source: string, assistantId: string) => void;
}) {
  const blocks = useMemo(() => parseMarkdownBlocks(answer), [answer]);

  return (
    <div className="markdown-answer">
      {blocks.map((block, index) => {
        if (block.type === 'heading') {
          const HeadingTag = `h${block.level}` as 'h2' | 'h3';
          return (
            <HeadingTag key={`${block.type}-${index}`}>
              <InlineText
                text={block.text}
                assistantId={assistantId}
                onSourceClick={onSourceClick}
              />
            </HeadingTag>
          );
        }
        if (block.type === 'list') {
          const ListTag = block.ordered ? 'ol' : 'ul';
          return (
            <ListTag key={`${block.type}-${index}`}>
              {block.items.map((item) => (
                <li key={item}>
                  <InlineText
                    text={item}
                    assistantId={assistantId}
                    onSourceClick={onSourceClick}
                  />
                </li>
              ))}
            </ListTag>
          );
        }
        if (block.type === 'table') {
          return <SimpleTable key={`${block.type}-${index}`} rows={block.rows} />;
        }
        return (
          <p key={`${block.type}-${index}`}>
            <InlineText
              text={block.text}
              assistantId={assistantId}
              onSourceClick={onSourceClick}
            />
          </p>
        );
      })}
    </div>
  );
}

function InlineText({
  text,
  assistantId,
  onSourceClick,
}: {
  text: string;
  assistantId: string;
  onSourceClick: (source: string, assistantId: string) => void;
}) {
  const parts = splitCitationParts(text);
  return (
    <>
      {parts.map((part, index) =>
        part.type === 'text' ? (
          <span key={`${part.value}-${index}`}>{part.value}</span>
        ) : (
          <button
            key={`${part.value}-${index}`}
            className="source-chip"
            type="button"
            onClick={() => onSourceClick(part.value, assistantId)}
          >
            source: {basename(part.value)}
          </button>
        ),
      )}
    </>
  );
}

function SimpleTable({ rows }: { rows: string[][] }) {
  const [header, ...body] = rows;
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {header.map((cell) => (
              <th key={cell}>{stripMarkdown(cell)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={`${row.join('-')}-${rowIndex}`}>
              {row.map((cell, cellIndex) => (
                <td key={`${cell}-${cellIndex}`}>{stripMarkdown(cell)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Composer({
  activeMode,
  disabled,
  retryQuestion,
  onSubmit,
}: {
  activeMode: ModeKey;
  disabled: boolean;
  retryQuestion: string | null;
  onSubmit: (question: string, mode?: ModeKey) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const hardCapRef = useRef<number | null>(null);
  const [value, setValue] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const SpeechRecognitionApi =
    typeof window !== 'undefined'
      ? window.SpeechRecognition ?? window.webkitSpeechRecognition
      : undefined;

  useEffect(() => {
    return () => stopRecording();
  }, []);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const question = value;
    if (!question.trim()) {
      return;
    }
    onSubmit(question);
    setValue('');
  }

  function stopRecording() {
    if (hardCapRef.current) {
      window.clearTimeout(hardCapRef.current);
      hardCapRef.current = null;
    }
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setIsRecording(false);
  }

  function startRecording() {
    if (!SpeechRecognitionApi || disabled) {
      return;
    }
    if (isRecording) {
      stopRecording();
      return;
    }

    const recognition = new SpeechRecognitionApi();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = navigator.language.toLowerCase().startsWith('it')
      ? 'it-IT'
      : 'en-US';

    recognition.onresult = (event) => {
      let transcript = '';
      for (let index = 0; index < event.results.length; index += 1) {
        transcript += event.results[index][0]?.transcript ?? '';
      }
      setValue(transcript.trim());
    };
    recognition.onend = () => {
      if (hardCapRef.current) {
        window.clearTimeout(hardCapRef.current);
        hardCapRef.current = null;
      }
      recognitionRef.current = null;
      setIsRecording(false);
    };
    recognition.onerror = () => {
      recognitionRef.current = null;
      setIsRecording(false);
    };

    recognitionRef.current = recognition;
    setIsRecording(true);
    recognition.start();
    hardCapRef.current = window.setTimeout(() => stopRecording(), 30_000);
  }

  return (
    <div
      className={`composer-zone ${isRecording ? 'is-listening' : ''}`}
      style={{ '--mode-tint': `var(${MODES[activeMode].tintVar})` }}
    >
      <VoiceBrain active={isRecording} mode={MODES[activeMode]} />
      <form className="composer" onSubmit={handleSubmit}>
        <label htmlFor="question-input" className="sr-only">
          Ask Compass a question
        </label>
        <textarea
          id="question-input"
          ref={textareaRef}
          rows={2}
          placeholder={
            retryQuestion ?? 'Ask about Bocconi, Milan, exchange, career...'
          }
          disabled={disabled}
          readOnly={isRecording}
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        {SpeechRecognitionApi ? (
          <button
            className={`icon-button mic-button ${isRecording ? 'is-active' : ''}`}
            type="button"
            aria-label={isRecording ? 'Stop voice input' : 'Start voice input'}
            aria-pressed={isRecording}
            disabled={disabled}
            onClick={isRecording ? stopRecording : startRecording}
          >
            <Icon name="mic" />
          </button>
        ) : null}
        <button className="send-button" type="submit" disabled={disabled}>
          <Icon name="send" />
          <span>Send</span>
        </button>
      </form>
    </div>
  );
}

function VoiceBrain({ active, mode }: { active: boolean; mode: ModeDefinition }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!active || !canvasRef.current) {
      return undefined;
    }

    let frame = 0;
    let closed = false;
    let stream: MediaStream | null = null;
    let audioContext: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    const frequencyData = new Uint8Array(128);
    const dots = Array.from({ length: 42 }, (_, index) => ({
      angle: (index / 42) * Math.PI * 2,
      distance: 34 + (index % 7) * 8,
      base: 1.6 + (index % 5) * 0.35,
    }));

    async function setupAudio() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioContext = new AudioContext();
        window.__compassAudioContextState = audioContext.state;
        const source = audioContext.createMediaStreamSource(stream);
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        draw();
      } catch {
        window.__compassAudioContextState = 'unavailable';
        draw();
      }
    }

    function draw() {
      const canvas = canvasRef.current;
      if (!canvas || closed) {
        return;
      }
      const context = canvas.getContext('2d');
      if (!context) {
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(rect.width * scale));
      canvas.height = Math.max(1, Math.floor(rect.height * scale));
      context.setTransform(scale, 0, 0, scale, 0, 0);
      context.clearRect(0, 0, rect.width, rect.height);

      let mean = 18;
      if (analyser) {
        analyser.getByteFrequencyData(frequencyData);
        mean =
          frequencyData.reduce((total, value) => total + value, 0) /
          frequencyData.length;
      }

      const amplitude = Math.min(1, mean / 95);
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;
      context.fillStyle = getComputedStyle(canvas).getPropertyValue('--mode-tint');

      dots.forEach((dot, index) => {
        const wave = Math.sin(frame / 22 + index * 0.9) * 7 * amplitude;
        const radius = dot.distance + wave;
        const x = centerX + Math.cos(dot.angle) * radius;
        const y = centerY + Math.sin(dot.angle) * radius;
        context.globalAlpha = 0.18 + amplitude * 0.35;
        context.beginPath();
        context.arc(x, y, dot.base + amplitude * 4.5, 0, Math.PI * 2);
        context.fill();
      });

      context.globalAlpha = 0.14 + amplitude * 0.18;
      context.beginPath();
      context.arc(centerX, centerY, 24 + amplitude * 22, 0, Math.PI * 2);
      context.fill();
      context.globalAlpha = 1;
      frame = requestAnimationFrame(draw);
    }

    setupAudio();

    return () => {
      closed = true;
      cancelAnimationFrame(frame);
      stream?.getTracks().forEach((track) => track.stop());
      if (audioContext && audioContext.state !== 'closed') {
        void audioContext.close().then(() => {
          window.__compassAudioContextState = 'closed';
        });
      } else if (audioContext) {
        window.__compassAudioContextState = audioContext.state;
      }
    };
  }, [active]);

  if (!active) {
    return null;
  }

  return (
    <canvas
      ref={canvasRef}
      className="voice-brain"
      style={{ '--mode-tint': `var(${mode.tintVar})` }}
      aria-hidden="true"
    />
  );
}

function ModePanel({
  mode,
  message,
  confidence,
}: {
  mode: ModeDefinition;
  message: Extract<ChatMessage, { role: 'assistant' }> | null;
  confidence: Confidence;
}) {
  const plan = useMemo(
    () => (message ? parsePlan(message.content, confidence) : null),
    [message, confidence],
  );

  return (
    <section
      className="panel mode-panel"
      style={{ '--mode-tint': `var(${mode.tintVar})` }}
    >
      <div className="panel-header">
        <span className="panel-icon">
          <Icon name={mode.icon} />
        </span>
        <div>
          <h2>{mode.label}</h2>
          <p>Plan from this answer</p>
        </div>
      </div>

      <StaticHelper mode={mode.key} />

      {message && confidence === 'LOW' ? (
        <div className="no-guess-card">
          <strong>I won't guess</strong>
          <span>
            Compass didn't find a confident source for this. Try rephrasing or
            check the official channel.
          </span>
        </div>
      ) : null}

      {message && confidence !== 'LOW' && plan ? (
        <>
          <PlanList title="Action items" items={plan.actions} />
          <PillGroup title="Costs at a glance" items={plan.costs} />
          {plan.timeline ? (
            <div className="timeline-snippet">
              <span>Timeline</span>
              <p>{plan.timeline}</p>
            </div>
          ) : null}
        </>
      ) : null}

      {!message ? (
        <p className="empty-panel-copy">
          Ask a question and Compass will turn the answer into a short plan.
        </p>
      ) : null}
    </section>
  );
}

function StaticHelper({ mode }: { mode: ModeKey }) {
  if (mode === 'relocation') {
    return (
      <div className="helper-block">
        <span>Documents to gather</span>
        {['codice fiscale', 'residence permit', 'bank account', 'Italian SIM'].map(
          (item) => (
            <label key={item}>
              <input type="checkbox" readOnly />
              {item}
            </label>
          ),
        )}
      </div>
    );
  }
  if (mode === 'life_on_campus') {
    return (
      <div className="helper-block quick-links">
        <span>Quick links</span>
        {['Library', 'Dining', 'Sports', 'Associations'].map((item) => (
          <button key={item} type="button">
            {item}
          </button>
        ))}
      </div>
    );
  }
  if (mode === 'study_abroad') {
    return (
      <div className="helper-block sequence">
        <span>Timeline at a glance</span>
        <p>Apply {'->'} Selection {'->'} Pre-departure {'->'} Departure</p>
      </div>
    );
  }
  return (
    <div className="helper-block sequence">
      <span>Next steps</span>
      <p>Update CV {'->'} Book Career Service slot {'->'} Apply</p>
    </div>
  );
}

function PlanList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) {
    return null;
  }
  return (
    <div className="plan-list">
      <span>{title}</span>
      {items.map((item) => (
        <label key={item}>
          <input type="checkbox" readOnly />
          <span>{item}</span>
        </label>
      ))}
    </div>
  );
}

function PillGroup({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) {
    return null;
  }
  return (
    <div className="pill-group">
      <span>{title}</span>
      <div>
        {items.map((item) => (
          <small key={item}>{item}</small>
        ))}
      </div>
    </div>
  );
}

function EvidenceDrawer({
  message,
  confidence,
  highlightedSource,
  sourceRefs,
}: {
  message: Extract<ChatMessage, { role: 'assistant' }> | null;
  confidence: Confidence;
  highlightedSource: string | null;
  sourceRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>;
}) {
  const mode = message ? MODES[message.mode] : MODES.relocation;
  return (
    <section
      className="panel evidence-panel"
      style={{ '--mode-tint': `var(${mode.tintVar})` }}
    >
      <div className="evidence-top">
        <div>
          <p className="eyebrow">Evidence</p>
          <h2>Sources</h2>
        </div>
        <ConfidencePill confidence={confidence} />
      </div>

      {message && message.sources.length > 0 ? (
        <div className="source-list">
          {message.sources.map((source) => (
            <div
              key={source}
              ref={(element) => {
                sourceRefs.current[source] = element;
              }}
              className={`source-row ${
                highlightedSource === source ? 'is-highlighted' : ''
              }`}
            >
              <span className="source-dot" />
              <div>
                <strong>{basename(source)}</strong>
                <code>{source}</code>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="empty-panel-copy">
          Source rows appear here after Compass answers with citations.
        </p>
      )}
    </section>
  );
}

function MobileEvidenceSheet({
  open,
  message,
  confidence,
  highlightedSource,
  sourceRefs,
  onClose,
}: {
  open: boolean;
  message: Extract<ChatMessage, { role: 'assistant' }> | null;
  confidence: Confidence;
  highlightedSource: string | null;
  sourceRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>;
  onClose: () => void;
}) {
  return (
    <div className={`sheet-shell ${open ? 'is-open' : ''}`} aria-hidden={!open}>
      <button className="sheet-backdrop" type="button" onClick={onClose} />
      <div className="sheet-panel" role="dialog" aria-label="Evidence drawer">
        <button
          className="icon-button sheet-close"
          type="button"
          aria-label="Close evidence drawer"
          onClick={onClose}
        >
          <Icon name="x" />
        </button>
        <EvidenceDrawer
          message={message}
          confidence={confidence}
          highlightedSource={highlightedSource}
          sourceRefs={sourceRefs}
        />
      </div>
    </div>
  );
}

function ConfidencePill({ confidence }: { confidence: Confidence }) {
  return <span className={`confidence-pill ${confidence.toLowerCase()}`}>{confidence}</span>;
}

type MarkdownBlock =
  | { type: 'heading'; level: 2 | 3; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'table'; rows: string[][] };

function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.split('\n');
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index].trim();
    if (!line) {
      index += 1;
      continue;
    }

    if (line.startsWith('### ')) {
      blocks.push({ type: 'heading', level: 3, text: stripMarkdown(line.slice(4)) });
      index += 1;
      continue;
    }

    if (line.startsWith('## ')) {
      blocks.push({ type: 'heading', level: 2, text: stripMarkdown(line.slice(3)) });
      index += 1;
      continue;
    }

    if (isTableLine(line) && lines[index + 1] && isDividerLine(lines[index + 1])) {
      const rows: string[][] = [];
      while (index < lines.length && isTableLine(lines[index].trim())) {
        if (!isDividerLine(lines[index])) {
          rows.push(parseTableRow(lines[index]));
        }
        index += 1;
      }
      blocks.push({ type: 'table', rows });
      continue;
    }

    const listMatch = line.match(/^(\d+\.|[-*])\s+(.+)/);
    if (listMatch) {
      const ordered = /\d+\./.test(listMatch[1]);
      const items: string[] = [];
      while (index < lines.length) {
        const itemMatch = lines[index].trim().match(/^(\d+\.|[-*])\s+(.+)/);
        if (!itemMatch) {
          break;
        }
        items.push(stripMarkdown(itemMatch[2]));
        index += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    const paragraphLines: string[] = [line];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !lines[index].trim().match(/^(\d+\.|[-*])\s+(.+)/) &&
      !lines[index].trim().startsWith('## ') &&
      !isTableLine(lines[index].trim())
    ) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }
    blocks.push({
      type: 'paragraph',
      text: stripMarkdown(paragraphLines.join(' ')),
    });
  }

  return blocks;
}

function parsePlan(answer: string, confidence: Confidence) {
  if (confidence === 'LOW') {
    return { actions: [], costs: [], timeline: '' };
  }
  const actions = answer
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^(\d+\.|[-*])\s+/.test(line))
    .map((line) => stripMarkdown(line.replace(/^(\d+\.|[-*])\s+/, '')))
    .filter(Boolean)
    .slice(0, 6);

  const costs = Array.from(new Set(answer.match(COST_PATTERN) ?? [])).slice(0, 6);
  const timeline = Array.from(answer.matchAll(DATE_PATTERN))
    .map((match) => match[0])
    .slice(0, 3)
    .join(' | ');

  return { actions, costs, timeline };
}

function getConfidence(answer: string, sources: string[]): Confidence {
  const abstains = hasAbstention(answer);
  if (sources.length === 0 || abstains) {
    return 'LOW';
  }
  if (sources.length >= 2 && answer.length > 300) {
    return 'HIGH';
  }
  return 'MEDIUM';
}

function hasAbstention(answer: string) {
  return ABSTENTION_PATTERN.test(answer);
}

function splitCitationParts(text: string) {
  const parts: Array<{ type: 'text' | 'source'; value: string }> = [];
  const pattern = /\[source:\s*([^\]]+)\]/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', value: text.slice(lastIndex, match.index) });
    }
    parts.push({ type: 'source', value: match[1].trim() });
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push({ type: 'text', value: text.slice(lastIndex) });
  }

  return parts;
}

function stripMarkdown(value: string) {
  return value
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
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
    .map((cell) => cell.trim());
}

function basename(path: string) {
  return path.split('/').filter(Boolean).at(-1) ?? path;
}

function Icon({ name }: { name: IconName }) {
  if (name === 'send') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 11.5 20 4l-7.5 16-2.2-6.3L4 11.5Z" />
        <path d="m10.3 13.7 4.2-4.2" />
      </svg>
    );
  }
  if (name === 'mic') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 4a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V7a3 3 0 0 0-3-3Z" />
        <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
      </svg>
    );
  }
  if (name === 'database') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <ellipse cx="12" cy="6" rx="7" ry="3" />
        <path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
      </svg>
    );
  }
  if (name === 'building') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 21h16M6 21V5l8-2v18M14 8h4v13M9 8h1M9 12h1M9 16h1" />
      </svg>
    );
  }
  if (name === 'plane') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m3 11 18-7-7 18-3-8-8-3Z" />
        <path d="m11 14 4-4" />
      </svg>
    );
  }
  if (name === 'briefcase') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M9 7V5h6v2M4 8h16v11H4V8Z" />
        <path d="M4 13h16M10 13v2h4v-2" />
      </svg>
    );
  }
  if (name === 'x') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 6l12 12M18 6 6 18" />
      </svg>
    );
  }
  if (name === 'check') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m5 12 4 4L19 6" />
      </svg>
    );
  }
  if (name === 'chevron') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m6 9 6 6 6-6" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8" />
      <path d="m14.5 9.5-2 5-3 1 2-5 3-1Z" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </svg>
  );
}

export default App;
