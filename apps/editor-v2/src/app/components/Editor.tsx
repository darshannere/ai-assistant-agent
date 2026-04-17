import CodeMirror from '@uiw/react-codemirror';
import { python } from '@codemirror/lang-python';
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels"
import { Button, Title, Container, Group, Tabs, Badge, Drawer, Text, Code, Divider } from "@mantine/core"
import styles from "./Editor.module.css"
import { yCollab } from 'y-codemirror.next';
import * as Y from 'yjs';
import ReactAnsi from "react-ansi";
import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import GraphComponent from './SMM';
import { ReactFlowProvider } from '@xyflow/react';
import { EditorView, ViewPlugin, ViewUpdate, Decoration, WidgetType, GutterMarker, gutter } from "@codemirror/view";
import { Extension, StateField, EditorState, RangeSetBuilder } from "@codemirror/state";
import { createPersonalEditorUpdateExtension } from './modals/extension';
import HelpSessionStartedModal from './modals/HelpSessionModal';
import { BACKEND_URL, WS_URL } from '../config';
import ParticipantLabel from './ParticipantLabel';

// --- Inline Help Widget (shows "X can help with Y" badge inline in code) ---
class InlineHelpWidget extends WidgetType {
  constructor(private readonly text: string, private readonly mode: 'suggestion' | 'pending' = 'suggestion') { super(); }
  toDOM() {
    const btn = document.createElement("button");
    btn.style.marginLeft = "12px";
    btn.style.padding = "4px 12px";
    btn.style.borderRadius = "6px";
    btn.style.border = "none";
    btn.style.fontSize = "13px";
    btn.style.fontWeight = "600";
    btn.style.lineHeight = "1.4";
    btn.style.verticalAlign = "middle";
    btn.style.fontFamily = "inherit";

    if (this.mode === 'pending') {
      btn.style.background = "#f59e0b";
      btn.style.color = "#ffffff";
      btn.style.cursor = "default";
      btn.style.boxShadow = "0 1px 3px rgba(0, 0, 0, 0.15)";
      btn.textContent = `🧑‍💻 ${this.text}`;
    } else {
      btn.style.background = "#1f2937";
      btn.style.color = "#ffffff";
      btn.style.cursor = "pointer";
      btn.style.boxShadow = "0 2px 6px rgba(0, 0, 0, 0.25)";
      btn.textContent = `🧑‍💻 ${this.text}`;
      btn.addEventListener("mouseenter", () => { btn.style.background = "#374151"; });
      btn.addEventListener("mouseleave", () => { btn.style.background = "#1f2937"; });
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        document.dispatchEvent(new CustomEvent("inline-help-click"));
      });
    }
    return btn;
  }
  eq(other: InlineHelpWidget) { return this.text === other.text && this.mode === other.mode; }
  ignoreEvent() { return false; }
}

function buildInlineHelpDecoration(state: EditorState, message: string, anchorText: string, mode: 'suggestion' | 'pending' = 'suggestion') {
  if (!anchorText) return Decoration.none;
  const doc = state.doc.toString();
  const anchor = doc.indexOf(anchorText);
  if (anchor < 0) return Decoration.none;
  const anchorEnd = anchor + anchorText.length;
  return Decoration.set([
    Decoration.widget({
      widget: new InlineHelpWidget(message, mode),
      side: 1,
    }).range(anchorEnd),
  ]);
}

function createInlineHelpField(message: string, anchorText: string, mode: 'suggestion' | 'pending' = 'suggestion') {
  return StateField.define({
    create(state) { return buildInlineHelpDecoration(state, message, anchorText, mode); },
    update(decorations, tr) {
      if (!tr.docChanged) return decorations.map(tr.changes);
      return buildInlineHelpDecoration(tr.state, message, anchorText, mode);
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}

// --- Run Icon Gutter (green play button on def lines) ---
class RunIconMarker extends GutterMarker {
  toDOM() {
    const span = document.createElement("span");
    span.textContent = "\u25B6";
    span.style.color = "#22c55e";
    span.style.fontSize = "20px";
    span.style.fontWeight = "800";
    span.style.lineHeight = "1";
    span.style.display = "inline-flex";
    span.style.alignItems = "center";
    span.style.justifyContent = "right";
    span.style.width = "16px";
    span.style.cursor = "pointer";
    span.title = "Test function";
    return span;
  }
}

const runIconMarker = new RunIconMarker();

function updateTripleQuoteState(lineText: string, currentState: `'''` | `"""` | null) {
  let state = currentState;
  for (let i = 0; i < lineText.length; i += 1) {
    const quote = lineText.slice(i, i + 3);
    if (!state) {
      if ((quote === `'''` || quote === `"""`) && lineText[i - 1] !== "\\") {
        state = quote as `'''` | `"""`;
        i += 2;
      }
      continue;
    }

    if (quote === state && lineText[i - 1] !== "\\") {
      state = null;
      i += 2;
    }
  }
  return state;
}

function buildRunIconMarkers(state: EditorState) {
  const builder = new RangeSetBuilder<GutterMarker>();
  let tripleQuoteState: `'''` | `"""` | null = null;

  for (let lineNo = 1; lineNo <= state.doc.lines; lineNo += 1) {
    const line = state.doc.line(lineNo);
    const lineText = line.text;
    const trimmedLine = lineText.trimStart();
    const isDefinitionLine = !tripleQuoteState && /^\s*def\s+\w+\s*\(/.test(lineText);
    const isCommentLine = trimmedLine.startsWith("#");

    if (isDefinitionLine && !isCommentLine) {
      builder.add(line.from, line.from, runIconMarker);
    }

    tripleQuoteState = updateTripleQuoteState(lineText, tripleQuoteState);
  }
  return builder.finish();
}

const runIconField = StateField.define({
  create(state) { return buildRunIconMarkers(state); },
  update(markers, tr) {
    if (!tr.docChanged) return markers.map(tr.changes);
    return buildRunIconMarkers(tr.state);
  },
});

function createRunIconGutter(onRunFunction?: (functionCode: string) => void) {
  return gutter({
    class: "cm-run-icon-gutter",
    markers: (view) => view.state.field(runIconField),
    initialSpacer: () => runIconMarker,
    domEventHandlers: onRunFunction ? {
      mousedown(view, line) {
        const lineText = view.state.doc.lineAt(line.from).text;
        if (!/^\s*def\s+\w+\s*\(/.test(lineText)) return false;
        const activeFunction = getFunctionAtPosition(view.state.doc.toString(), line.from);
        if (!activeFunction) return false;
        onRunFunction(activeFunction.text);
        return true;
      },
    } : undefined,
  });
}

const runIconGutterTheme = EditorView.theme({
  ".cm-run-icon-gutter": { width: "22px" },
});

// --- All Participants ---
const ALL_PARTICIPANTS = ['A', 'B', 'C'];
type HistoryEntry = [Date, string, boolean];
type ParticipantProfile = { name: string; photo: string | null };
type FunctionRange = {
  from: number;
  to: number;
  text: string;
  name: string;
};
type RemoteCursor = {
  userId: string;
  name: string;
  photo: string | null;
  color: string;
  colorLight: string;
  anchor: number;
  head: number;
};

const userColors = [
  { color: '#30bced', light: '#30bced33' },
  { color: '#6eeb83', light: '#6eeb8333' },
  { color: '#ffbc42', light: '#ffbc4233' },
  { color: '#ecd444', light: '#ecd44433' },
  { color: '#ee6352', light: '#ee635233' },
  { color: '#9ac2c9', light: '#9ac2c933' },
  { color: '#8acb88', light: '#8acb8833' },
  { color: '#1be7ff', light: '#1be7ff33' },
];

function getParticipantColor(participantId: string) {
  const seed = participantId.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return userColors[seed % userColors.length];
}

function clampPosition(pos: number, max: number) {
  return Math.max(0, Math.min(pos, max));
}

function getFunctionRanges(code: string): FunctionRange[] {
  const lines = code.split('\n');
  const lineStarts: number[] = [];
  let offset = 0;

  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }

  const functionHeaders = lines.flatMap((line, index) => {
    const match = line.match(/^def\s+([A-Za-z_]\w*)\s*\(/);
    if (!match) return [];
    return [{
      lineIndex: index,
      from: lineStarts[index],
      name: match[1],
    }];
  });

  return functionHeaders.map((header, index) => {
    const end = index + 1 < functionHeaders.length ? functionHeaders[index + 1].from : code.length;
    return {
      from: header.from,
      to: end,
      text: code.slice(header.from, end).trimEnd(),
      name: header.name,
    };
  });
}

function getFunctionAtPosition(code: string, position: number): FunctionRange | null {
  const functionRanges = getFunctionRanges(code);
  const clampedPosition = clampPosition(position, code.length);

  for (const range of functionRanges) {
    if (clampedPosition >= range.from && clampedPosition < range.to) {
      return range;
    }
  }

  return functionRanges.find((range) => clampedPosition < range.from) || null;
}

class RemoteCursorWidget extends WidgetType {
  constructor(private readonly cursor: RemoteCursor) { super(); }

  toDOM() {
    const wrapper = document.createElement('span');
    wrapper.className = styles.remoteCursor;
    wrapper.style.setProperty('--remote-cursor-color', this.cursor.color);

    const caret = document.createElement('span');
    caret.className = styles.remoteCursorCaret;
    wrapper.appendChild(caret);

    const tooltip = document.createElement('span');
    tooltip.className = styles.remoteCursorTooltip;

    const avatar = this.cursor.photo ? document.createElement('img') : document.createElement('span');
    avatar.className = styles.remoteCursorAvatar;
    if (this.cursor.photo) {
      avatar.setAttribute('src', this.cursor.photo);
      avatar.setAttribute('alt', this.cursor.name);
    } else {
      avatar.textContent = this.cursor.name.charAt(0).toUpperCase();
      avatar.classList.add(styles.remoteCursorAvatarFallback);
    }

    const label = document.createElement('span');
    label.className = styles.remoteCursorTooltipLabel;
    label.textContent = this.cursor.name;

    tooltip.appendChild(avatar);
    tooltip.appendChild(label);
    wrapper.appendChild(tooltip);

    return wrapper;
  }

  eq(other: RemoteCursorWidget) {
    return other.cursor.userId === this.cursor.userId
      && other.cursor.head === this.cursor.head
      && other.cursor.anchor === this.cursor.anchor
      && other.cursor.name === this.cursor.name
      && other.cursor.photo === this.cursor.photo
      && other.cursor.color === this.cursor.color;
  }

  ignoreEvent() { return true; }
}

function buildRemoteCursorDecorations(state: EditorState, remoteCursors: RemoteCursor[]) {
  const decorations = [];
  const docLength = state.doc.length;

  for (const cursor of remoteCursors) {
    const anchor = clampPosition(cursor.anchor, docLength);
    const head = clampPosition(cursor.head, docLength);
    const from = Math.min(anchor, head);
    const to = Math.max(anchor, head);

    if (from !== to) {
      decorations.push(Decoration.mark({
        attributes: {
          style: `background-color: ${cursor.colorLight}; border-bottom: 1px solid ${cursor.color};`,
        },
      }).range(from, to));
    }

    decorations.push(Decoration.widget({
      widget: new RemoteCursorWidget(cursor),
      side: 1,
    }).range(head));
  }

  return Decoration.set(decorations, true);
}

function createRemoteCursorExtension(remoteCursors: RemoteCursor[]) {
  const remoteCursorField = StateField.define({
    create(state) {
      return buildRemoteCursorDecorations(state, remoteCursors);
    },
    update(decorations, tr) {
      if (!tr.docChanged) return decorations.map(tr.changes);
      return buildRemoteCursorDecorations(tr.state, remoteCursors);
    },
    provide: (field) => EditorView.decorations.from(field),
  });

  return [remoteCursorField];
}

function replaceEditorDoc(view: EditorView, nextDoc: string) {
  const currentDoc = view.state.doc.toString();
  if (currentDoc === nextDoc) return;

  const currentSelection = view.state.selection.main;
  const clampedAnchor = Math.min(currentSelection.anchor, nextDoc.length);
  const clampedHead = Math.min(currentSelection.head, nextDoc.length);

  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: nextDoc },
    selection: { anchor: clampedAnchor, head: clampedHead },
  });
}

export default function Editor() {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [personalCode, setPersonalCode] = useState("");
  // backendServer replaced by config imports — see top of file
  const wsRef = useRef<WebSocket | null>(null);
  const id = localStorage.getItem('participant-id') || 'D';
  const storedUserId = id.replace(/"/g, '');
  const [activeTab, setActiveTab] = useState<string | null>('team');

  // Helpee-side state
  const [helpSessionActive, setHelpSessionActive] = useState(false);
  const [helpSessionHelper, setHelpSessionHelper] = useState('');
  const [helpSessionTimeLeft, setHelpSessionTimeLeft] = useState(0);

  // Helper-side state (when someone else requests help — inline widget)
  const [incomingHelpRequest, setIncomingHelpRequest] = useState<{
    helpeeId: string;
    helpeeName: string;
    helpeePhoto: string | null;
  } | null>(null);
  const [helpCardVisible, setHelpCardVisible] = useState(false);

  // Other participants' personal editor code
  const [otherEditors, setOtherEditors] = useState<Record<string, string>>({});

  // Inline help extension for the personal editor (driven by backend helperSuggestion events)
  const [inlineHelpExtension, setInlineHelpExtension] = useState<Extension[]>([]);

  // State for the inline help popup card (triggered by clicking the inline widget)
  const [inlineHelpCardOpen, setInlineHelpCardOpen] = useState(false);
  const [inlineHelpRequested, setInlineHelpRequested] = useState(false);

  // Current suggestion from backend (used to populate the popup card)
  const [currentSuggestion, setCurrentSuggestion] = useState<{
    helperId: string; helperName: string; helperPhoto: string | null; concepts: string[];
  } | null>(null);
  const [currentAnchorKeyword, setCurrentAnchorKeyword] = useState<string | null>(null);

  // Proactive helper suggestions (inline widgets in helpee's editor)
  const [helperSuggestions, setHelperSuggestions] = useState<Array<{
    helperId: string; helperName: string; helperPhoto: string | null; concepts: string[];
  }>>([]);
  const [selectedHelper, setSelectedHelper] = useState<{
    helperId: string; helperName: string; helperPhoto: string | null; concepts: string[];
  } | null>(null);

  // Task detail drawer state (LeetCode-style)
  const [taskDrawerOpen, setTaskDrawerOpen] = useState(false);
  const [selectedTask, setSelectedTask] = useState<{
    name: string; description: string; concepts: string;
    example_input: string; example_output: string; starter_code: string;
  } | null>(null);

  const handleNodeSelect = useCallback(async (nodeId: string) => {
    // Skip non-function nodes (like "Customer", "Restaurant")
    if (nodeId === 'Customer' || nodeId === 'Restaurant') return;
    try {
      const res = await fetch(`${BACKEND_URL}/task/${nodeId}`);
      const data = await res.json();
      if (data.status === 'ok') {
        setSelectedTask(data);
        setPersonalCode(data.starter_code);
        setTaskDrawerOpen(true);
      }
    } catch (e) {
      console.error('Failed to fetch task details:', e);
    }
  }, []);

  // Listen for clicks on the inline help widget button
  useEffect(() => {
    const handler = () => {
      if (!inlineHelpRequested) {
        setInlineHelpCardOpen(true);
      }
    };
    document.addEventListener("inline-help-click", handler);
    return () => document.removeEventListener("inline-help-click", handler);
  }, [inlineHelpRequested]);

  // Handle "Help Me When Free" from the inline help card
  const inlineDismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleInlineHelpRequest = () => {
    setInlineHelpCardOpen(false);
    setInlineHelpRequested(true);
    // Swap the inline widget to orange "will ping when free" mode
    const helperName = currentSuggestion?.helperName || 'Helper';
    const anchor = currentAnchorKeyword || 'pass';
    setInlineHelpExtension([
      createInlineHelpField(`${helperName} will ping when free`, anchor, "pending"),
    ]);
    // Auto-dismiss after 5 seconds
    if (inlineDismissTimer.current) clearTimeout(inlineDismissTimer.current);
    inlineDismissTimer.current = setTimeout(() => {
      setInlineHelpExtension([]);
      setInlineHelpRequested(false);
    }, 5000);
    // Send help request via WebSocket (existing mechanism)
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        event: 'helpRequest',
        payload: { helpeeId: storedUserId, helpeeName: storedUserId, helpeePhoto: null }
      }));
    }
  };

  const [personalEditorExtensions, setPersonalEditorExtensions] = useState<Extension[]>(() => [python()]);
  const [isSessionStartedModalOpen, setIsSessionStartedModalOpen] = useState(false);
  const [sessionDetails, setSessionDetails] = useState({
    totalDurationSeconds: 150,
    taskContext: '',
    helperName: ''
  });
  const [taskSuggestionOptions, setTaskSuggestionOptions] = useState<unknown[]>([]);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [typingUsers, setTypingUsers] = useState<Record<string, string>>({});
  const [participantProfiles, setParticipantProfiles] = useState<Record<string, ParticipantProfile>>({});
  const [remoteTeamCursors, setRemoteTeamCursors] = useState<RemoteCursor[]>([]);
  const suppressTeamSyncRef = useRef(false);
  const participantProfilesRef = useRef<Record<string, ParticipantProfile>>({});
  const teamEditorViewRef = useRef<EditorView | null>(null);
  const personalEditorViewRef = useRef<EditorView | null>(null);
  const leftEditorViewRefs = useRef<Record<string, EditorView | null>>({});

  const otherParticipants = ALL_PARTICIPANTS.filter(p => p !== storedUserId);

  useEffect(() => {
    const localProfiles = ALL_PARTICIPANTS.reduce<Record<string, ParticipantProfile>>((acc, participantId) => {
      const rawProfile = localStorage.getItem(`participant_${participantId}`);
      if (!rawProfile) return acc;
      try {
        const parsed = JSON.parse(rawProfile);
        acc[participantId] = {
          name: parsed?.name || participantId,
          photo: parsed?.photo || null,
        };
      } catch (error) {
        console.warn(`Failed to parse local profile for ${participantId}:`, error);
      }
      return acc;
    }, {});

    setParticipantProfiles(localProfiles);
    participantProfilesRef.current = localProfiles;

    fetch(`${BACKEND_URL}/profiles`)
      .then((response) => response.json())
      .then((data) => {
        if (data.status !== 'success' || !data.profiles) return;
        const backendProfiles = Object.entries(data.profiles).reduce<Record<string, ParticipantProfile>>((acc, [participantId, profile]: [string, any]) => {
          const cleanId = participantId.replace(/"/g, '');
          acc[cleanId] = {
            name: profile?.name || cleanId,
            photo: profile?.photo || null,
          };
          return acc;
        }, {});
        setParticipantProfiles((prev) => {
          const nextProfiles = { ...prev, ...backendProfiles };
          participantProfilesRef.current = nextProfiles;
          return nextProfiles;
        });
      })
      .catch((error) => {
        console.warn('Failed to load participant profiles:', error);
      });
  }, []);

  const getParticipantProfile = useCallback((participantId: string) => {
    return participantProfiles[participantId] || { name: participantId, photo: null };
  }, [participantProfiles]);

  const remoteCursorExtension = useMemo(
    () => createRemoteCursorExtension(remoteTeamCursors),
    [remoteTeamCursors]
  );

  const handlePersonalEditorChange = useCallback((value: string) => {
    setPersonalCode(value);
  }, []);

  useEffect(() => {
    const view = personalEditorViewRef.current;
    if (!view) return;
    replaceEditorDoc(view, personalCode);
  }, [personalCode]);

  const testSingleFunction = useCallback(async (functionCode: string) => {
    const channel = storedUserId;
    await fetch(`${BACKEND_URL}/testFunction`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: functionCode, channel }),
    });
  }, [storedUserId]);

  const personalRunIconGutter = useMemo(
    () => createRunIconGutter((functionCode) => {
      void testSingleFunction(functionCode);
    }),
    [testSingleFunction]
  );

  const sharedRunIconGutter = useMemo(
    () => createRunIconGutter((functionCode) => {
      void testSingleFunction(functionCode);
    }),
    [testSingleFunction]
  );

  const personalEditorResolvedExtensions = useMemo(
    () => [
      ...personalEditorExtensions,
      runIconField,
      personalRunIconGutter,
      runIconGutterTheme,
      ...inlineHelpExtension,
    ],
    [personalEditorExtensions, personalRunIconGutter, inlineHelpExtension]
  );

  // Help session countdown timer (helpee side)
  useEffect(() => {
    if (!helpSessionActive || helpSessionTimeLeft <= 0) return;
    const interval = setInterval(() => {
      setHelpSessionTimeLeft(prev => {
        if (prev <= 1) {
          setHelpSessionActive(false);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [helpSessionActive, helpSessionTimeLeft]);

  const sendTypingEvent = useCallback((editor: 'team' | 'personal') => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ event: 'typing', payload: { id: storedUserId, editor } }));
    }
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ event: 'stoppedTyping', payload: { id: storedUserId } }));
      }
    }, 2000);
  }, [storedUserId]);

  const syncTeamEditorToBackend = useCallback((doc: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const teamView = teamEditorViewRef.current;
    const selection = teamView && teamView.hasFocus && teamView.dom.ownerDocument.hasFocus()
      ? teamView.state.selection.main
      : null;

    ws.send(JSON.stringify({
      event: 'updateMaster',
      payload: {
        cursor: selection ? {
          anchor: selection.anchor,
          head: selection.head,
        } : null,
        doc,
        name: storedUserId,
        timeStamp: new Date().getTime(),
      },
    }));
  }, [storedUserId]);

  function extractJsons(text: string): object[] {
    const jsonMatches = [...text.matchAll(/```json\n([\s\S]*?)\n```/g)];
    return jsonMatches.map(match => {
      try { return JSON.parse(match[1].trim()); }
      catch (error) { console.error("Failed to parse JSON:", match[1]); return null; }
    }).filter(json => json !== null);
  }

  const handleCloseSessionStartedModal = () => {
    setIsSessionStartedModalOpen(false);
  };

  useEffect(() => {
    if (storedUserId && !wsRef.current) {
      console.log(`Raw value from localStorage: "${storedUserId}"`);
      const wsUrl = `${WS_URL}/ws/${storedUserId}`;
      console.log("WebSocket URL:", wsUrl);
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log("WebSocket connection established");
        console.log("Configuring personal editor WebSocket extension for user:", storedUserId);
        const playgroundUpdateExtension = createPersonalEditorUpdateExtension(ws, storedUserId);
        setPersonalEditorExtensions([python(), playgroundUpdateExtension]);
      };

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        console.log("Received message:", data);
        if (data['event'] === 'run') {
          console.log(data);
          appendToHistory(data['stdout'], data['all']);
        }
        if (data['event'] === 'initial') {
          if (typeof data?.payload?.doc === 'string') {
            suppressTeamSyncRef.current = true;
            ytext.delete(0, ytext.length);
            ytext.insert(0, data.payload.doc);
            suppressTeamSyncRef.current = false;
          }
        }
        if (data['event'] === 'document_update') {
          const updateSourceUser = typeof data?.payload?.user === 'string'
            ? data.payload.user.replace(/"/g, '')
            : null;
          const nextDoc = typeof data?.payload?.doc === 'string' ? data.payload.doc : ytext.toString();
          const isRemoteDocumentChange = updateSourceUser !== storedUserId;

          if (isRemoteDocumentChange && nextDoc !== ytext.toString()) {
            suppressTeamSyncRef.current = true;
            ytext.delete(0, ytext.length);
            ytext.insert(0, nextDoc);
            suppressTeamSyncRef.current = false;
          }

          const incomingCursors = data?.payload?.cursors || {};
          const nextRemoteCursors = Object.entries(incomingCursors).flatMap(([participantId, cursor]: [string, any]) => {
            const cleanId = participantId.replace(/"/g, '');
            if (cleanId === storedUserId || !cursor) return [];
            const profile = participantProfilesRef.current[cleanId] || { name: cleanId, photo: null };
            const color = getParticipantColor(cleanId);
            return [{
              userId: cleanId,
              name: profile.name || cleanId,
              photo: profile.photo || null,
              color: color.color,
              colorLight: color.light,
              anchor: typeof cursor.anchor === 'number' ? cursor.anchor : (typeof cursor.head === 'number' ? cursor.head : 0),
              head: typeof cursor.head === 'number' ? cursor.head : (typeof cursor.anchor === 'number' ? cursor.anchor : 0),
            }];
          });
          setRemoteTeamCursors(nextRemoteCursors);
        }
        if (data['event'] === 'StartHelpSession') {
          const { helper, helpee, time, hint } = data['payload'];
          if (helper === storedUserId || helpee === storedUserId) {
            const totalDurationSeconds = time;
            const taskContext = hint + " please go over to their screen and help them. ";
            const helperName = helper;
            setSessionDetails({ totalDurationSeconds, taskContext, helperName });
            setIsSessionStartedModalOpen(true);

            // Helpee side: track active help session
            if (helpee === storedUserId) {
              setHelpSessionActive(true);
              setHelpSessionHelper(helper);
              setHelpSessionTimeLeft(totalDurationSeconds);
            }
          }
        }
        if (data['event'] === 'Suggestion') {
          const taskSuggestions = data['payload']['options'];
          console.log("Task suggestions:", taskSuggestions);
          setTaskSuggestionOptions(taskSuggestions['options']);
        }
        if (data['event'] === 'monitorPlayground') {
          const editors = data['payload']['editors'] || {};
          setOtherEditors(editors);
        }
        if (data['event'] === 'helpRequest') {
          const { helpeeId, helpeeName, helpeePhoto } = data['payload'];
          // Only show to other participants, not the one who sent it
          if (helpeeId !== storedUserId) {
            setIncomingHelpRequest({ helpeeId, helpeeName, helpeePhoto });
            setHelpCardVisible(true);
          }
        }
        if (data['event'] === 'helperSuggestion') {
          const { suggestion, detectedConcepts, anchorKeyword } = data['payload'];
          if (suggestion && !inlineHelpRequested) {
            setCurrentSuggestion(suggestion);
            setCurrentAnchorKeyword(anchorKeyword || detectedConcepts[0] || 'pass');
            const anchor = anchorKeyword || 'pass';
            const conceptLabel = detectedConcepts[0] || 'this';
            setInlineHelpExtension([
              createInlineHelpField(
                `${suggestion.helperName} can help with ${conceptLabel}`,
                anchor,
                "suggestion"
              ),
            ]);
            // Auto-dismiss inline help badge after 10 seconds
            setTimeout(() => setInlineHelpExtension([]), 10000);
          }
        }
        if (data['event'] === 'typing') {
          const { id: tid, editor } = data['payload'];
          setTypingUsers(prev => ({ ...prev, [tid]: editor }));
        }
        if (data['event'] === 'stoppedTyping') {
          const { id: tid } = data['payload'];
          setTypingUsers(prev => {
            const next = { ...prev };
            delete next[tid];
            return next;
          });
        }
      };

      ws.onclose = (event) => {
        console.log(`WebSocket connection closed: Code=${event.code}, Reason=${event.reason}, WasClean=${event.wasClean}`);
      };

      ws.onerror = (error) => {
        console.error("WebSocket specific error event:", error);
      };
    }
  }, []);

  function clearCode() {
    setHistory([]);
    console.log("Cleared code");
  }

  async function testCodePlayground() {
    const functionsToTest = getFunctionRanges(personalCode);
    if (functionsToTest.length === 0) {
      console.warn("No top-level functions found in personal editor to test.");
      return;
    }

    for (const fn of functionsToTest) {
      await testSingleFunction(fn.text);
    }
    console.log("testing personal code sequentially:", functionsToTest.map((fn) => fn.name));
  }

  function mergeCollaborativeCode() {
    const code = ytext.toString();
    console.log("Merging code:", code);
  }

  async function runPersonalCode() {
    const code = personalCode;
    const channel = storedUserId;
    try {
      await fetch(`${BACKEND_URL}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code, channel: channel }),
      });
      console.log("Running personal code:", code);
    } catch (e) {
      console.error("Execution error:", e);
    }
  }

  function appendToHistory(output: string, all: boolean) {
    setHistory((prev) => [...prev, [new Date(), output, all]]);
  }

  const dismissHelpCard = () => {
    setHelpCardVisible(false);
    setIncomingHelpRequest(null);
    setInlineHelpExtension([]);
  };

  const copyLeftToPersonal = () => {
    if (!activeTab) return;

    const sourceView = leftEditorViewRefs.current[activeTab];
    const sourceCode = activeTab === 'team' ? ytext.toString() : otherEditors[activeTab];
    if (!sourceView || !sourceCode) return;

    const sourceFunction = getFunctionAtPosition(sourceCode, sourceView.state.selection.main.head);
    if (!sourceFunction) {
      console.warn('No active function found to copy from the left editor.');
      return;
    }

    setPersonalCode((prev) => {
      const trimmedPrev = prev.trimEnd();
      const separator = trimmedPrev.length > 0 ? '\n\n' : '';
      return `${trimmedPrev}${separator}${sourceFunction.text}\n`;
    });
  };

  const copyPersonalToTeam = () => {
    const personalView = personalEditorViewRef.current;
    const teamView = teamEditorViewRef.current;
    const currentTeamCode = ytext.toString();
    if (!personalView || !teamView) return;

    const sourceFunction = getFunctionAtPosition(personalCode, personalView.state.selection.main.head);
    const targetFunction = getFunctionAtPosition(currentTeamCode, teamView.state.selection.main.head);

    if (!sourceFunction || !targetFunction) {
      console.warn('Unable to find both source and target functions for copy-to-team.');
      return;
    }

    ytext.delete(targetFunction.from, targetFunction.to - targetFunction.from);
    ytext.insert(targetFunction.from, `${sourceFunction.text}\n\n`);
    syncTeamEditorToBackend(ytext.toString());
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60).toString().padStart(2, '0');
    const s = (seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  return (
    <>
      <Container fluid h={"90vh"} p={0}>
        {/* Helpee-side banners */}
        {helpSessionActive && (
          <div className={styles.helpSessionBanner}>
            <Group justify="space-between" px="sm">
              <Group gap="xs" align="center">
                <span className={styles.helpSessionDot} />
                <span>Help session active with <strong>{helpSessionHelper}</strong></span>
              </Group>
              <Badge color="green" variant="filled" size="sm">{formatTime(helpSessionTimeLeft)}</Badge>
            </Group>
          </div>
        )}

        <PanelGroup direction="vertical">
          <Panel defaultSize={50} minSize={20}>
            <PanelGroup direction="horizontal">
              {/* LEFT SIDE: Tabs (Team Editor + other participants) */}
              <Panel defaultSize={50} minSize={20}>
                <Tabs value={activeTab} onChange={setActiveTab} style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                  <Tabs.List>
                    <Tabs.Tab value="team">
                      Team Editor
                      {Object.entries(typingUsers).filter(([uid]) => uid !== storedUserId).filter(([, ed]) => ed === 'team').length > 0 && (
                        <span className={styles.typingDot} />
                      )}
                    </Tabs.Tab>
                    {otherParticipants.map(p => (
                      <Tabs.Tab key={p} value={p}>
                        <ParticipantLabel
                          id={p}
                          name={getParticipantProfile(p).name}
                          photo={getParticipantProfile(p).photo}
                          suffix="'s Editor"
                          avatarSize={18}
                          textSize={13}
                        />
                        {typingUsers[p] && <span className={styles.typingDot} />}
                      </Tabs.Tab>
                    ))}
                  </Tabs.List>

                  {/* Team Editor Tab */}
                  <Tabs.Panel value="team" style={{ flexGrow: 1, display: activeTab === 'team' ? 'flex' : 'none', flexDirection: 'column', minHeight: 0 }}>
                    <Group justify="space-between" p="xs" style={{ borderBottom: '1px solid #ccc', flexShrink: 0 }}>
                      <Group gap="xs" align="center">
                        {Object.entries(typingUsers).filter(([, ed]) => ed === 'team').map(([uid]) => (
                          <span key={uid} className={styles.typingIndicator}>
                            <ParticipantLabel
                              id={uid}
                              name={getParticipantProfile(uid).name}
                              photo={getParticipantProfile(uid).photo}
                              suffix=" is typing..."
                              avatarSize={16}
                              textSize={12}
                            />
                          </span>
                        ))}
                      </Group>
                    </Group>
                    <div style={{ flexGrow: 1, overflow: 'auto', minHeight: 0 }}>
                      <CodeMirror
                        height="100%"
                        onCreateEditor={(view) => {
                          teamEditorViewRef.current = view;
                          leftEditorViewRefs.current.team = view;
                        }}
                        extensions={[
                          python(),
                          yCollab(ytext, undefined),
                          runIconField,
                          sharedRunIconGutter,
                          runIconGutterTheme,
                          ...remoteCursorExtension,
                          ViewPlugin.fromClass(class {
                            update(u: ViewUpdate) {
                              if (suppressTeamSyncRef.current) return;
                              if (!u.docChanged && !u.selectionSet && !u.focusChanged) return;
                              if (u.docChanged) sendTypingEvent('team');
                              const ws = wsRef.current;
                              if (ws && ws.readyState === WebSocket.OPEN) {
                                const selection = u.view.hasFocus && u.view.dom.ownerDocument.hasFocus()
                                  ? u.state.selection.main
                                  : null;
                                ws.send(JSON.stringify({
                                  event: 'updateMaster',
                                  payload: {
                                    cursor: selection ? {
                                      anchor: selection.anchor,
                                      head: selection.head,
                                    } : null,
                                    doc: u.state.doc.toString(),
                                    name: storedUserId,
                                    timeStamp: new Date().getTime(),
                                  },
                                }));
                              }
                            }
                          }),
                        ]}
                        style={{ height: '100%' }}
                      />
                    </div>
                  </Tabs.Panel>

                  {/* Other Participants' Editor Tabs */}
                  {otherParticipants.map(p => (
                    <Tabs.Panel key={p} value={p} style={{ flexGrow: 1, display: activeTab === p ? 'flex' : 'none', flexDirection: 'column', minHeight: 0 }}>
                      <Group justify="space-between" p="xs" style={{ borderBottom: '1px solid #ccc', flexShrink: 0 }}>
                        <Group gap="xs" align="center">
                          <Title order={4}>
                            <ParticipantLabel
                              id={p}
                              name={getParticipantProfile(p).name}
                              photo={getParticipantProfile(p).photo}
                              suffix="'s Personal Editor"
                              avatarSize={20}
                              textSize={18}
                            />
                          </Title>
                          {typingUsers[p] && (
                            <span className={styles.typingIndicator}>
                              <ParticipantLabel
                                id={p}
                                name={getParticipantProfile(p).name}
                                photo={getParticipantProfile(p).photo}
                                suffix=" is typing..."
                                avatarSize={16}
                                textSize={12}
                              />
                            </span>
                          )}
                        </Group>
                      </Group>
                      <div style={{ flexGrow: 1, overflow: 'auto', minHeight: 0 }}>
                        {otherEditors[p] ? (
                          <CodeMirror
                            height="100%"
                            value={otherEditors[p]}
                            editable={false}
                            onCreateEditor={(view) => {
                              leftEditorViewRefs.current[p] = view;
                            }}
                            extensions={[python(), runIconField, sharedRunIconGutter, runIconGutterTheme]}
                            style={{ height: '100%', opacity: 0.9 }}
                          />
                        ) : (
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
                            <p style={{ fontSize: '14px', color: '#888' }}>{p} hasn't started editing yet</p>
                          </div>
                        )}
                      </div>
                    </Tabs.Panel>
                  ))}
                </Tabs>
              </Panel>

              {/* Resize Handle with copy arrows */}
              <PanelResizeHandle className={styles.ResizeHandleOuter}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 4, padding: '0 2px' }}>
                  <span style={{ fontSize: 10, fontWeight: 600, color: '#888', userSelect: 'none' }}>Copy</span>
                  <button
                    title={activeTab === 'team' ? "Copy Team Editor to My Editor" : `Copy ${activeTab}'s Editor to My Editor`}
                    onClick={(e) => { e.stopPropagation(); copyLeftToPersonal(); }}
                    className={styles.copyArrowBtn}
                  >
                    &rarr;
                  </button>
                  <button
                    title="Copy My Editor to Team Editor"
                    onClick={(e) => { e.stopPropagation(); copyPersonalToTeam(); }}
                    className={styles.copyArrowBtn}
                    disabled={activeTab !== 'team'}
                    style={activeTab !== 'team' ? { opacity: 0.3, cursor: 'not-allowed' } : {}}
                  >
                    &larr;
                  </button>
                </div>
              </PanelResizeHandle>

              {/* RIGHT SIDE: My Editor (always visible) */}
              <Panel defaultSize={50} minSize={20}>
                <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                  <Group justify="space-between" p="xs" style={{ borderBottom: '1px solid #ccc', flexShrink: 0 }}>
                    <Group gap="xs" align="center">
                      <Title order={3}>
                        <ParticipantLabel
                          id={storedUserId}
                          name={getParticipantProfile(storedUserId).name}
                          photo={getParticipantProfile(storedUserId).photo}
                          suffix="'s Personal Editor"
                          avatarSize={22}
                          textSize={20}
                        />
                      </Title>
                      {Object.entries(typingUsers).filter(([, ed]) => ed === 'personal').map(([uid]) => (
                        <span key={uid} className={styles.typingIndicator}>
                          <ParticipantLabel
                            id={uid}
                            name={getParticipantProfile(uid).name}
                            photo={getParticipantProfile(uid).photo}
                            suffix=" is typing..."
                            avatarSize={16}
                            textSize={12}
                          />
                        </span>
                      ))}
                      {helpSessionActive && (
                        <Badge color="green" variant="dot" size="sm">
                          {helpSessionHelper} is helping you
                        </Badge>
                      )}
                    </Group>
                    <Group gap="xs">
                      <Button onClick={testCodePlayground} size='compact-xs'>Test</Button>
                      {/* <Button onClick={runPersonalCode} size='compact-xs'>Run</Button> */}
                      <Button onClick={clearCode} size='compact-xs'>Clear Console</Button>
                    </Group>
                  </Group>
                  <div style={{ flexGrow: 1, overflow: 'auto', minHeight: 0, position: 'relative' }}>
                    <CodeMirror
                      height="100%"
                      onCreateEditor={(view) => {
                        personalEditorViewRef.current = view;
                        replaceEditorDoc(view, personalCode);
                      }}
                      onChange={handlePersonalEditorChange}
                      extensions={personalEditorResolvedExtensions}
                      style={{ height: '100%' }}
                    />
                    {/* Floating helper card — shown when someone requests help (incoming) */}
                    {helpCardVisible && incomingHelpRequest && (
                      <div className={styles.helperCard}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          {incomingHelpRequest.helpeePhoto ? (
                            <img
                              src={incomingHelpRequest.helpeePhoto}
                              alt={incomingHelpRequest.helpeeName}
                              style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover', border: '3px solid #ef4444' }}
                            />
                          ) : (
                            <div style={{
                              width: 36, height: 36, borderRadius: '50%', background: '#334155',
                              color: 'white', fontWeight: 700, display: 'flex', alignItems: 'center',
                              justifyContent: 'center', fontSize: 16, border: '3px solid #ef4444'
                            }}>
                              {(incomingHelpRequest.helpeeName || incomingHelpRequest.helpeeId).charAt(0)}
                            </div>
                          )}
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 700 }}>
                              {incomingHelpRequest.helpeeName || incomingHelpRequest.helpeeId}
                            </div>
                            <div style={{ fontSize: 11, color: '#ef4444', fontWeight: 600 }}>
                              Needs Help
                            </div>
                          </div>
                        </div>
                        <Button
                          size="compact-xs"
                          color="orange"
                          mt={8}
                          fullWidth
                          onClick={() => {
                            dismissHelpCard();
                            setActiveTab(incomingHelpRequest.helpeeId);
                          }}
                        >
                          Help Me When Free
                        </Button>
                        <Button
                          size="compact-xs"
                          variant="default"
                          mt={4}
                          fullWidth
                          onClick={dismissHelpCard}
                        >
                          Close
                        </Button>
                      </div>
                    )}
                    {/* Floating helper card — proactive suggestion (helpee side: who can help me) */}
                    {!helpCardVisible && selectedHelper && (
                      <div className={styles.helperCard}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          {selectedHelper.helperPhoto ? (
                            <img
                              src={selectedHelper.helperPhoto}
                              alt={selectedHelper.helperName}
                              style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover', border: '3px solid #22c55e' }}
                            />
                          ) : (
                            <div style={{
                              width: 36, height: 36, borderRadius: '50%', background: '#334155',
                              color: 'white', fontWeight: 700, display: 'flex', alignItems: 'center',
                              justifyContent: 'center', fontSize: 16, border: '3px solid #22c55e'
                            }}>
                              {selectedHelper.helperName.charAt(0)}
                            </div>
                          )}
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 700 }}>
                              {selectedHelper.helperName}
                            </div>
                            <div style={{ fontSize: 11, color: '#22c55e', fontWeight: 600 }}>
                              Can help with {selectedHelper.concepts[0]}
                            </div>
                          </div>
                        </div>
                        <Button
                          size="compact-xs"
                          color="orange"
                          mt={8}
                          fullWidth
                          onClick={() => {
                            setSelectedHelper(null);
                          }}
                        >
                          Dismiss
                        </Button>
                        <Button
                          size="compact-xs"
                          variant="default"
                          mt={4}
                          fullWidth
                          onClick={() => setSelectedHelper(null)}
                        >
                          Close
                        </Button>
                      </div>
                    )}
                    {/* Inline help popup card (triggered by clicking inline helper button) */}
                    {inlineHelpCardOpen && currentSuggestion && (
                      <div className={styles.helperCard} style={{ minWidth: 220 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                          {currentSuggestion.helperPhoto ? (
                            <img src={currentSuggestion.helperPhoto} alt={currentSuggestion.helperName}
                              style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover', border: '3px solid #ef4444' }} />
                          ) : (
                            <span style={{ fontSize: 28 }}>🧑‍💻</span>
                          )}
                          <div>
                            <div style={{ fontSize: 15, fontWeight: 700 }}>{currentSuggestion.helperName}</div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 2 }}>
                              <span style={{
                                display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                                background: '#ef4444',
                              }} />
                              <span style={{ fontSize: 13, color: '#ef4444', fontWeight: 600 }}>Deep Work</span>
                            </div>
                          </div>
                        </div>
                        <Button
                          size="compact-sm"
                          color="orange"
                          mt={10}
                          fullWidth
                          onClick={handleInlineHelpRequest}
                          style={{ fontWeight: 600 }}
                        >
                          Help Me When Free
                        </Button>
                        <Button
                          size="compact-sm"
                          variant="default"
                          mt={6}
                          fullWidth
                          onClick={() => setInlineHelpCardOpen(false)}
                          style={{ fontWeight: 500 }}
                        >
                          Close
                        </Button>
                      </div>
                    )}
                    {/* Inline suggestion chips (helpee side: clickable badges below editor toolbar) */}
                    {helperSuggestions.length > 0 && !selectedHelper && !helpCardVisible && (
                      <div className={styles.suggestionChips}>
                        {helperSuggestions.map(s => (
                          <button
                            key={s.helperId}
                            className={styles.suggestionChip}
                            onClick={() => setSelectedHelper(s)}
                          >
                            {s.helperName} can help with {s.concepts[0]}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </Panel>
            </PanelGroup>
          </Panel>

          <PanelResizeHandle />

          {/* Bottom: Graph + Output */}
          <Panel defaultSize={50} minSize={20}>
            <PanelGroup direction="horizontal">
              <Panel defaultSize={50}>
                <div style={{ padding: '10px' }}>
                  <ReactFlowProvider>
                    <GraphComponent onNodeSelect={handleNodeSelect} />
                  </ReactFlowProvider>
                </div>
              </Panel>
              <PanelResizeHandle />
              <Panel defaultSize={50}>
                <div className={styles.Output} id="output">
                  <Title order={3}>Output</Title>
                  <div style={{ overflowY: 'auto', maxHeight: '350px' }}>
                    {history.map(([timestamp, output, isCollaborative], i) => {
                      const HOURS = timestamp.getHours().toString().padStart(2, '0');
                      const MINUTES = timestamp.getMinutes().toString().padStart(2, '0');
                      const SECONDS = timestamp.getSeconds().toString().padStart(2, '0');
                      return (
                        <div key={i}>
                          <div className={`outputLine ${i % 2 === 1 ? 'active' : ''}`}>
                            <div style={{ whiteSpace: 'pre-wrap' }}>
                              <ReactAnsi logStyle={{ backgroundColor: 'white', color: 'black', fontSize: '10px' }} log={output} />
                            </div>
                            <p>{`${HOURS}:${MINUTES}:${SECONDS}`}</p>
                          </div>
                          <div className={`outputLine ${i % 2 === 1 ? 'active' : ''}`} style={{ color: 'yellow' }}>
                            <i>{isCollaborative ? 'Ran by Collaborative Editor' : 'Ran from Personal Playground'}</i>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </Panel>
            </PanelGroup>
          </Panel>
        </PanelGroup>
      </Container>

      {isSessionStartedModalOpen && (
        <HelpSessionStartedModal
          isOpen={isSessionStartedModalOpen}
          onClose={handleCloseSessionStartedModal}
          totalDurationSeconds={sessionDetails.totalDurationSeconds}
          taskContext={sessionDetails.taskContext}
          helperName={sessionDetails.helperName}
        />
      )}

      {/* LeetCode-style Task Detail Drawer */}
      <Drawer
        opened={taskDrawerOpen}
        onClose={() => setTaskDrawerOpen(false)}
        position="right"
        size="md"
        title={
          <Group gap="xs">
            <Title order={3}>{selectedTask?.name}</Title>
          </Group>
        }
        overlayProps={{ backgroundOpacity: 0.1 }}
      >
        {selectedTask && (
          <div>
            <Text size="sm" fw={600} c="dimmed" mb={4}>Concepts</Text>
            <Group gap={6} mb="md">
              {selectedTask.concepts.split(',').map((c, i) => (
                <Badge key={i} variant="light" color="blue" size="sm">{c.trim()}</Badge>
              ))}
            </Group>

            <Text size="sm" fw={600} c="dimmed" mb={4}>Description</Text>
            <Text size="sm" mb="md">{selectedTask.description}</Text>

            <Divider my="sm" />

            <Text size="sm" fw={600} c="dimmed" mb={4}>Example Input</Text>
            <Code block style={{ fontSize: 13, marginBottom: 16 }}>
              {selectedTask.example_input}
            </Code>

            <Text size="sm" fw={600} c="dimmed" mb={4}>Example Output</Text>
            <Code block style={{ fontSize: 13, marginBottom: 16 }}>
              {selectedTask.example_output}
            </Code>

            <Divider my="sm" />

            <Text size="sm" fw={600} c="dimmed" mb={4}>Starter Code</Text>
            <Code block style={{ fontSize: 13 }}>
              {selectedTask.starter_code}
            </Code>

            <Button
              mt="md"
              fullWidth
              onClick={() => {
                setPersonalCode(selectedTask.starter_code);
                setTaskDrawerOpen(false);
              }}
            >
              Load into My Editor
            </Button>
          </div>
        )}
      </Drawer>
    </>
  )
}

// Y.js Collaboration Extension
const ydoc = new Y.Doc();
const ytext = ydoc.getText('codemirror');
