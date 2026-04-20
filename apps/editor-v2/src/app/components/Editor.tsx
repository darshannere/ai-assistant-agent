import CodeMirror from '@uiw/react-codemirror';
import { python } from '@codemirror/lang-python';
import { indentOnInput, indentUnit } from '@codemirror/language';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { keymap } from '@codemirror/view';
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
import { Extension, StateField, EditorState, RangeSetBuilder, Prec } from "@codemirror/state";
import { createPersonalEditorUpdateExtension } from './modals/extension';
import { BACKEND_URL, WS_URL } from '../config';
import ParticipantLabel from './ParticipantLabel';

// --- Copilot-style ghost comment widget (visual hint only; does not alter code) ---
class CopilotGhostCommentWidget extends WidgetType {
  constructor(private readonly text: string) { super(); }
  toDOM() {
    const wrap = document.createElement("span");
    wrap.style.marginLeft = "10px";
    wrap.style.display = "inline-flex";
    wrap.style.alignItems = "center";
    wrap.style.padding = "0 8px";
    wrap.style.borderRadius = "6px";
    wrap.style.background = "rgba(148, 163, 184, 0.10)";
    wrap.style.border = "1px dashed rgba(100, 116, 139, 0.45)";
    wrap.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
    wrap.style.fontSize = "12px";
    wrap.style.fontStyle = "italic";
    wrap.style.color = "#64748b";
    wrap.style.lineHeight = "1.8";
    wrap.textContent = `# ${this.text}`;
    return wrap;
  }
  eq(other: CopilotGhostCommentWidget) { return this.text === other.text; }
  ignoreEvent() { return true; }
}

function buildInlineHelpDecoration(state: EditorState, message: string) {
  const cursorPos = state.selection.main.head;
  return Decoration.set([
    Decoration.widget({
      widget: new CopilotGhostCommentWidget(message),
      side: 1,
    }).range(cursorPos),
  ]);
}

function createInlineHelpField(message: string) {
  return StateField.define({
    create(state) { return buildInlineHelpDecoration(state, message); },
    update(decorations, tr) {
      if (!tr.docChanged && !tr.selection) return decorations.map(tr.changes);
      return buildInlineHelpDecoration(tr.state, message);
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

function getFunctionByName(code: string, name: string): FunctionRange | null {
  if (!name) return null;
  return getFunctionRanges(code).find((fn) => fn.name === name) || null;
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

class FunctionOwnerWidget extends WidgetType {
  constructor(
    private readonly ownerName: string,
    private readonly ownerPhoto: string | null,
    private readonly isOwnedByMe: boolean
  ) { super(); }

  toDOM() {
    const wrap = document.createElement('span');
    wrap.style.display = 'inline-flex';
    wrap.style.alignItems = 'center';
    wrap.style.gap = '6px';
    wrap.style.marginRight = '8px';
    wrap.style.padding = '1px 8px';
    wrap.style.borderRadius = '999px';
    wrap.style.fontSize = '11px';
    wrap.style.fontWeight = '700';
    wrap.style.verticalAlign = 'middle';
    wrap.style.background = this.isOwnedByMe ? '#dbeafe' : '#f1f5f9';
    wrap.style.color = this.isOwnedByMe ? '#1d4ed8' : '#475569';
    wrap.style.border = this.isOwnedByMe ? '1px solid #93c5fd' : '1px solid #cbd5e1';

    if (this.ownerPhoto) {
      const img = document.createElement('img');
      img.src = this.ownerPhoto;
      img.alt = this.ownerName;
      img.style.width = '14px';
      img.style.height = '14px';
      img.style.borderRadius = '50%';
      img.style.objectFit = 'cover';
      wrap.appendChild(img);
    } else {
      const fallback = document.createElement('span');
      fallback.textContent = this.ownerName.charAt(0).toUpperCase();
      fallback.style.width = '14px';
      fallback.style.height = '14px';
      fallback.style.display = 'inline-flex';
      fallback.style.alignItems = 'center';
      fallback.style.justifyContent = 'center';
      fallback.style.borderRadius = '50%';
      fallback.style.background = this.isOwnedByMe ? '#2563eb' : '#94a3b8';
      fallback.style.color = '#fff';
      fallback.style.fontSize = '9px';
      wrap.appendChild(fallback);
    }

    const text = document.createElement('span');
    text.textContent = `${this.ownerName} editing`;
    wrap.appendChild(text);
    return wrap;
  }

  eq(other: FunctionOwnerWidget) {
    return (
      other.ownerName === this.ownerName
      && other.ownerPhoto === this.ownerPhoto
      && other.isOwnedByMe === this.isOwnedByMe
    );
  }
}

function createTeamOwnershipExtension(
  taskOwnerByFunction: Record<string, string>,
  participantProfiles: Record<string, ParticipantProfile>,
  currentUserId: string,
) {
  return StateField.define({
    create(state) {
      const doc = state.doc.toString();
      const ranges = getFunctionRanges(doc);
      const decorations = [];
      for (const range of ranges) {
        const ownerId = taskOwnerByFunction[range.name];
        if (!ownerId) continue;
        const isMine = ownerId === currentUserId;
        const profile = participantProfiles[ownerId] || { name: ownerId, photo: null };
        const markStyle = isMine
          ? 'background-color: rgba(59,130,246,0.10); border-left: 3px solid rgba(59,130,246,0.70);'
          : 'background-color: rgba(148,163,184,0.12); border-left: 3px solid rgba(100,116,139,0.55);';
        decorations.push(
          Decoration.mark({ attributes: { style: markStyle } }).range(range.from, range.to),
          Decoration.widget({
            widget: new FunctionOwnerWidget(profile.name || ownerId, profile.photo || null, isMine),
            side: -1,
          }).range(range.from),
        );
      }
      return Decoration.set(decorations, true);
    },
    update(decorations, tr) {
      if (!tr.docChanged) return decorations.map(tr.changes);
      const doc = tr.state.doc.toString();
      const ranges = getFunctionRanges(doc);
      const next = [];
      for (const range of ranges) {
        const ownerId = taskOwnerByFunction[range.name];
        if (!ownerId) continue;
        const isMine = ownerId === currentUserId;
        const profile = participantProfiles[ownerId] || { name: ownerId, photo: null };
        const markStyle = isMine
          ? 'background-color: rgba(59,130,246,0.10); border-left: 3px solid rgba(59,130,246,0.70);'
          : 'background-color: rgba(148,163,184,0.12); border-left: 3px solid rgba(100,116,139,0.55);';
        next.push(
          Decoration.mark({ attributes: { style: markStyle } }).range(range.from, range.to),
          Decoration.widget({
            widget: new FunctionOwnerWidget(profile.name || ownerId, profile.photo || null, isMine),
            side: -1,
          }).range(range.from),
        );
      }
      return Decoration.set(next, true);
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}

function createFocusCodeExtension(focusCode: string) {
  return StateField.define({
    create(state) {
      if (!focusCode) return Decoration.none;
      const doc = state.doc.toString();
      const idx = doc.indexOf(focusCode);
      if (idx < 0) return Decoration.none;
      return Decoration.set([
        Decoration.mark({
          attributes: {
            style: 'background-color: rgba(250, 204, 21, 0.18); outline: 1px solid rgba(202,138,4,0.55); border-radius: 2px;',
          },
        }).range(idx, idx + focusCode.length),
      ]);
    },
    update(decorations, tr) {
      if (!tr.docChanged) return decorations.map(tr.changes);
      if (!focusCode) return Decoration.none;
      const doc = tr.state.doc.toString();
      const idx = doc.indexOf(focusCode);
      if (idx < 0) return Decoration.none;
      return Decoration.set([
        Decoration.mark({
          attributes: {
            style: 'background-color: rgba(250, 204, 21, 0.18); outline: 1px solid rgba(202,138,4,0.55); border-radius: 2px;',
          },
        }).range(idx, idx + focusCode.length),
      ]);
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}

function createSelectedFunctionExtension(functionName: string) {
  return StateField.define({
    create(state) {
      if (!functionName) return Decoration.none;
      const doc = state.doc.toString();
      const target = getFunctionRanges(doc).find((r) => r.name === functionName);
      if (!target) return Decoration.none;
      return Decoration.set([
        Decoration.mark({
          attributes: {
            style: 'outline: 1px solid rgba(16,185,129,0.65); background-color: rgba(16,185,129,0.08);',
          },
        }).range(target.from, target.to),
      ]);
    },
    update(decorations, tr) {
      if (!tr.docChanged) return decorations.map(tr.changes);
      if (!functionName) return Decoration.none;
      const doc = tr.state.doc.toString();
      const target = getFunctionRanges(doc).find((r) => r.name === functionName);
      if (!target) return Decoration.none;
      return Decoration.set([
        Decoration.mark({
          attributes: {
            style: 'outline: 1px solid rgba(16,185,129,0.65); background-color: rgba(16,185,129,0.08);',
          },
        }).range(target.from, target.to),
      ]);
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}

function createDraftChangedLinesExtension(
  draftCode: string,
  changedLineRanges: Array<{ start: number; end: number }>
) {
  const buildDecorations = (state: EditorState) => {
    if (!draftCode || changedLineRanges.length === 0) return Decoration.none;
    const doc = state.doc.toString();
    const draftStart = doc.indexOf(draftCode);
    if (draftStart < 0) return Decoration.none;

    const draftLines = draftCode.split('\n');
    const lineOffsets: number[] = [];
    let offset = 0;
    for (const line of draftLines) {
      lineOffsets.push(offset);
      offset += line.length + 1;
    }

    const decorations = [];
    for (const range of changedLineRanges) {
      const start = Math.max(1, Math.min(range.start, draftLines.length));
      const end = Math.max(start, Math.min(range.end, draftLines.length));
      for (let lineNo = start; lineNo <= end; lineNo += 1) {
        const rel = lineOffsets[lineNo - 1];
        const abs = draftStart + rel;
        const line = state.doc.lineAt(abs);
        decorations.push(
          Decoration.line({
            attributes: {
              style: 'background: rgba(254, 240, 138, 0.38); border-left: 3px solid rgba(245, 158, 11, 0.95);',
            },
          }).range(line.from)
        );
      }
    }
    return Decoration.set(decorations, true);
  };

  return StateField.define({
    create(state) { return buildDecorations(state); },
    update(decorations, tr) {
      if (!tr.docChanged) return decorations.map(tr.changes);
      return buildDecorations(tr.state);
    },
    provide: (field) => EditorView.decorations.from(field),
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
  // `?mode=agent` disables CodeMirror features that fight keystroke-based
  // Playwright input (autocomplete, auto-indent, bracket closing). Only the
  // Personal Editor is affected; the Team Editor keeps its full feature set.
  const isAgentMode = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('mode') === 'agent';

  // Helpee-side state
  const [helpSessionActive, setHelpSessionActive] = useState(false);
  const [helpSessionHelper, setHelpSessionHelper] = useState('');
  const [helpSessionTimeLeft, setHelpSessionTimeLeft] = useState(0);

  // Helper-side queue state (visual tab highlighting, no pop-up interruption)
  const [pendingHelpRequests, setPendingHelpRequests] = useState<Array<{
    helpeeId: string;
    helpeeName: string;
    helpeePhoto: string | null;
  }>>([]);

  // Other participants' personal editor code
  const [otherEditors, setOtherEditors] = useState<Record<string, string>>({});

  // Inline copilot-style hint (visual-only ghost comment)
  const [inlineHelpExtension, setInlineHelpExtension] = useState<Extension[]>([]);
  const [copilotSuggestion, setCopilotSuggestion] = useState<{
    helperId: string;
    helperName: string;
    helperPhoto: string | null;
    concept: string;
    anchorKeyword: string;
    functionName: string;
  } | null>(null);
  const [assistWidget, setAssistWidget] = useState<{
    status: 'requested' | 'accepted';
    helperId: string;
    helperName: string;
    helperPhoto: string | null;
    concept: string;
  } | null>(null);
  const [helpeeFixHint, setHelpeeFixHint] = useState<{
    helperId: string;
    helperName: string;
    helperPhoto: string | null;
    concept: string;
    focusCode: string;
    focusExplanation: string;
  } | null>(null);

  // Helper session generation state
  const [activeHelpAsHelper, setActiveHelpAsHelper] = useState<{
    helpeeId: string;
    helpeeName: string;
    helpeePhoto: string | null;
  } | null>(null);
  const [helperGuidanceLoading, setHelperGuidanceLoading] = useState(false);
  const [helperGuidance, setHelperGuidance] = useState<{
    displayCode: string;
    functionName: string;
    focusExplanation: string;
    helperMessage: string;
    changedLines: string[];
    changedLineRanges: Array<{ start: number; end: number }>;
    concept: string;
  } | null>(null);
  const [autoStartingHelpFor, setAutoStartingHelpFor] = useState<string | null>(null);

  // Proactive helper suggestions (for app-shell helper list)
  const [helperSuggestions, setHelperSuggestions] = useState<Array<{
    helperId: string; helperName: string; helperPhoto: string | null; concepts: string[];
  }>>([]);
  const [teamParticipantStates, setTeamParticipantStates] = useState<Record<string, { status: string; currentTasks: string[]; name: string; photo?: string | null }>>({});
  const [selectedTeamFunction, setSelectedTeamFunction] = useState<string>('');

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

  // When the header "<helpee> needs help" pill is clicked, switch the left
  // tab to that helpee so the helper sees their live personal editor.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const helpeeId = detail?.helpeeId;
      if (typeof helpeeId === 'string' && helpeeId !== storedUserId) {
        setActiveTab(helpeeId);
      }
    };
    window.addEventListener('canary-focus-helpee', handler);
    return () => window.removeEventListener('canary-focus-helpee', handler);
  }, [storedUserId]);
  const assistRequestActiveRef = useRef(false);

  const requestPeerAssist = useCallback((source: 'copilot-tab' | 'button') => {
    if (assistRequestActiveRef.current) return;
    const ws = wsRef.current;
    const helpeeProfile = participantProfilesRef.current[storedUserId];
    const personalView = personalEditorViewRef.current;
    const activeFunction = personalView
      ? getFunctionAtPosition(personalCode, personalView.state.selection.main.head)
      : null;
    const helperConcept = copilotSuggestion?.concept || 'this task';
    const helperId = copilotSuggestion?.helperId || '';
    const helperName = copilotSuggestion?.helperName || 'Peer helper';
    const helperPhoto = copilotSuggestion?.helperPhoto || null;
    const anchorKeyword = copilotSuggestion?.anchorKeyword || 'pass';
    const functionName = copilotSuggestion?.functionName || activeFunction?.name || '';

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        event: 'helpRequest',
        payload: {
          helpeeId: storedUserId,
          helpeeName: helpeeProfile?.name || storedUserId,
          helpeePhoto: helpeeProfile?.photo || null,
          helperId,
          concept: helperConcept,
          anchorKeyword,
          functionName,
          message: source === 'copilot-tab'
            ? `Requested from copilot ghost hint for ${helperConcept}.`
            : 'Manual help request from toolbar.',
        }
      }));
    }
    setAssistWidget({
      status: 'requested',
      helperId,
      helperName,
      helperPhoto,
      concept: helperConcept,
    });
    setCopilotSuggestion(null);
    setHelpeeFixHint(null);
    setInlineHelpExtension([]);
    assistRequestActiveRef.current = true;
  }, [copilotSuggestion, personalCode, storedUserId]);

  const [personalEditorExtensions, setPersonalEditorExtensions] = useState<Extension[]>(() => [python(), ...pythonIndent]);
  const [taskSuggestionOptions, setTaskSuggestionOptions] = useState<unknown[]>([]);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSuggestionKeyRef = useRef<string | null>(null);
  const helpersStaleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [typingUsers, setTypingUsers] = useState<Record<string, string>>({});
  const [participantProfiles, setParticipantProfiles] = useState<Record<string, ParticipantProfile>>({});
  const [remoteTeamCursors, setRemoteTeamCursors] = useState<RemoteCursor[]>([]);
  const suppressTeamSyncRef = useRef(false);
  const participantProfilesRef = useRef<Record<string, ParticipantProfile>>({});
  const teamEditorViewRef = useRef<EditorView | null>(null);
  const personalEditorViewRef = useRef<EditorView | null>(null);
  const leftEditorViewRefs = useRef<Record<string, EditorView | null>>({});

  const otherParticipants = ALL_PARTICIPANTS.filter(p => p !== storedUserId && participantProfiles[p]);
  const pendingHelpIds = useMemo(() => new Set(pendingHelpRequests.map((r) => r.helpeeId)), [pendingHelpRequests]);
  const taskOwnerByFunction = useMemo(() => {
    const map: Record<string, string> = {};
    Object.entries(teamParticipantStates).forEach(([pid, state]) => {
      (state.currentTasks || []).forEach((fn) => {
        map[fn] = pid;
      });
    });
    return map;
  }, [teamParticipantStates]);

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
        setParticipantProfiles(() => {
          participantProfilesRef.current = backendProfiles;
          return backendProfiles;
        });
      })
      .catch((error) => {
        console.warn('Failed to load participant profiles:', error);
      });
  }, []);

  useEffect(() => {
    fetch(`${BACKEND_URL}/debug/states`)
      .then((response) => response.json())
      .then((data) => {
        setTeamParticipantStates(data?.participantStates || {});
      })
      .catch(() => {
        // backend may be temporarily unavailable
      });
  }, []);

  // Auto-start help session when a helper opens a pending helpee tab.
  useEffect(() => {
    if (!activeTab || activeTab === 'team' || activeTab === storedUserId) return;
    if (!pendingHelpIds.has(activeTab)) return;
    if (activeHelpAsHelper?.helpeeId === activeTab) return;
    if (autoStartingHelpFor === activeTab) return;

    setAutoStartingHelpFor(activeTab);
    fetch(`${BACKEND_URL}/StartHelpSession`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        helper: storedUserId,
        helpeeId: activeTab,
        time: 3,
        hint: 'Auto-started from helper view.',
      }),
    })
      .catch((error) => {
        console.error('Failed to auto-start help session:', error);
      })
      .finally(() => {
        setAutoStartingHelpFor((prev) => (prev === activeTab ? null : prev));
      });
  }, [activeTab, storedUserId, pendingHelpIds, activeHelpAsHelper, autoStartingHelpFor]);

  const getParticipantProfile = useCallback((participantId: string) => {
    return participantProfiles[participantId] || { name: participantId, photo: null };
  }, [participantProfiles]);

  const remoteCursorExtension = useMemo(
    () => createRemoteCursorExtension(remoteTeamCursors),
    [remoteTeamCursors]
  );
  const teamOwnershipExtension = useMemo(
    () => [createTeamOwnershipExtension(taskOwnerByFunction, participantProfiles, storedUserId)],
    [taskOwnerByFunction, participantProfiles, storedUserId]
  );
  const selectedTeamFunctionExtension = useMemo(
    () => selectedTeamFunction ? [createSelectedFunctionExtension(selectedTeamFunction)] : [],
    [selectedTeamFunction]
  );
  const helpeeFocusExtension = useMemo(
    () => helpeeFixHint?.focusCode ? [createFocusCodeExtension(helpeeFixHint.focusCode)] : [],
    [helpeeFixHint]
  );
  const helperDraftChangedExtension = useMemo(
    () => (helperGuidance?.displayCode && helperGuidance?.changedLineRanges?.length)
      ? [createDraftChangedLinesExtension(helperGuidance.displayCode, helperGuidance.changedLineRanges)]
      : [],
    [helperGuidance]
  );
  const copilotTabExtension = useMemo(
    () => Prec.high(keymap.of([{
      key: 'Tab',
      run: () => {
        if (!copilotSuggestion || assistWidget || helpSessionActive) return false;
        requestPeerAssist('copilot-tab');
        return true;
      },
    }])),
    [copilotSuggestion, assistWidget, helpSessionActive, requestPeerAssist]
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
      copilotTabExtension,
      runIconField,
      personalRunIconGutter,
      runIconGutterTheme,
      ...inlineHelpExtension,
      ...helpeeFocusExtension,
      ...helperDraftChangedExtension,
    ],
    [personalEditorExtensions, copilotTabExtension, personalRunIconGutter, inlineHelpExtension, helpeeFocusExtension, helperDraftChangedExtension]
  );

  // Help session countdown timer (helpee side)
  useEffect(() => {
    if (!helpSessionActive || helpSessionTimeLeft <= 0) return;
    const interval = setInterval(() => {
      setHelpSessionTimeLeft(prev => {
        if (prev <= 1) {
          setHelpSessionActive(false);
          assistRequestActiveRef.current = false;
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
        setPersonalEditorExtensions([python(), ...pythonIndent, playgroundUpdateExtension]);
      };

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        console.log("Received message:", data);
        if (data['event'] === 'run') {
          console.log(data);
          appendToHistory(data['stdout'], data['all']);
        }
        if (data['event'] === 'participantsCleared') {
          localStorage.removeItem('participant-id');
          ['A', 'B', 'C'].forEach((p) => localStorage.removeItem(`participant_${p}`));
          window.location.href = '/';
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
          const { helper, helpee, time } = data['payload'];
          if (helper === storedUserId || helpee === storedUserId) {
            const totalDurationSeconds = time;

            if (helpee === storedUserId) {
              setHelpSessionActive(true);
              setHelpSessionHelper(helper);
              setHelpSessionTimeLeft(totalDurationSeconds);
            }

            if (helper === storedUserId) {
              const helpeeProfile = participantProfilesRef.current[helpee] || { name: helpee, photo: null };
              setActiveHelpAsHelper({
                helpeeId: helpee,
                helpeeName: helpeeProfile.name || helpee,
                helpeePhoto: helpeeProfile.photo || null,
              });
              setHelperGuidance(null);
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
          // Agent-mode helpers can write to our personal editor slot; when
          // the broadcast carries a value that differs from what we have
          // locally, sync it so our own editor reflects the helper's edit.
          const mine = editors[storedUserId];
          if (typeof mine === 'string' && mine !== personalCode) {
            setPersonalCode(mine);
          }
        }
        if (data['event'] === 'profileUpdate') {
          const { id: pid, name, photo } = data['payload'] || {};
          if (typeof pid === 'string' && pid !== storedUserId) {
            setParticipantProfiles((prev) => {
              const cleanId = pid.replace(/"/g, '');
              const next = {
                ...prev,
                [cleanId]: { name: name || cleanId, photo: photo || null },
              };
              participantProfilesRef.current = next;
              return next;
            });
          }
        }
        if (data['event'] === 'updateGraph') {
          setTeamParticipantStates(data?.payload?.participantStates || {});
        }
        if (data['event'] === 'helpRequest') {
          const { helpeeId, helpeeName, helpeePhoto } = data['payload'];
          // Ensure the helpee has a profile entry so their editor tab renders;
          // otherSelection via setActiveTab won't work if the tab doesn't exist.
          setParticipantProfiles((prev) => {
            if (prev[helpeeId]) return prev;
            const next = { ...prev, [helpeeId]: { name: helpeeName || helpeeId, photo: helpeePhoto || null } };
            participantProfilesRef.current = next;
            return next;
          });
          // Add to persistent pending list (dedup by helpeeId). The header
          // pill keeps showing this request even after the floating card is
          // auto-dismissed, so a helper who missed the pop-up can still act.
          // Fire for the helpee too so their own header updates in real time
          // (app.tsx shows the pill for everyone in the queue).
          setPendingHelpRequests((prev) => {
            const existing = prev.find((p) => p.helpeeId === helpeeId);
            const next = existing
              ? prev
              : [...prev, { helpeeId, helpeeName, helpeePhoto }];
            window.dispatchEvent(new CustomEvent('canary-help-needed-updated', { detail: { requests: next } }));
            return next;
          });
        }
        if (data['event'] === 'helpRequestDismissed') {
          const { helpeeId } = data['payload'] || {};
          if (helpeeId) {
            setPendingHelpRequests((prev) => prev.filter((p) => p.helpeeId !== helpeeId));
          }
        }
        if (data['event'] === 'StartHelpSession') {
          // Once a help session starts, remove that helpee from the pending pill.
          const { helpee } = data['payload'] || {};
          if (helpee) {
            setPendingHelpRequests((prev) => {
              const next = prev.filter((p) => p.helpeeId !== helpee);
              window.dispatchEvent(new CustomEvent('canary-help-needed-updated', { detail: { requests: next } }));
              return next;
            });
          }
        }
        if (data['event'] === 'helpAccepted') {
          const { helperId, helpeeId, concept } = data['payload'] || {};
          if (helpeeId === storedUserId) {
            const helperProfile = participantProfilesRef.current[helperId] || { name: helperId, photo: null };
            assistRequestActiveRef.current = true;
            setCopilotSuggestion(null);
            setInlineHelpExtension([]);
            setAssistWidget({
              status: 'accepted',
              helperId,
              helperName: helperProfile.name || helperId,
              helperPhoto: helperProfile.photo || null,
              concept: concept || copilotSuggestion?.concept || 'this task',
            });
          }
        }
        if (data['event'] === 'helpGuidanceGenerating') {
          const { helperId } = data['payload'] || {};
          if (helperId === storedUserId) {
            setHelperGuidanceLoading(true);
          }
        }
        if (data['event'] === 'helpGuidanceReady') {
          const payload = data['payload'] || {};
          if (payload.helperId === storedUserId) {
            const displayCode = (payload.solutionFunctionCode || payload.correctedCode || '').trim();
            setHelperGuidanceLoading(false);
            setHelperGuidance({
              displayCode,
              functionName: payload.function || '',
              focusExplanation: payload.focusExplanation || '',
              helperMessage: payload.helperMessage || '',
              changedLines: payload.changedLines || [],
              changedLineRanges: payload.changedLineRanges || [],
              concept: payload.concept || '',
            });
            if (displayCode) {
              setPersonalCode((prev) => {
                const marker = "# --- Peer Assist Draft";
                const nextDraft = `${marker} for ${payload.helpeeId}\n${displayCode}\n# --- End Peer Assist Draft ---\n\n`;
                if (prev.includes(marker)) {
                  return prev.replace(/# --- Peer Assist Draft[\s\S]*?# --- End Peer Assist Draft ---\n\n/, nextDraft);
                }
                return `${nextDraft}${prev}`;
              });
            }
          }
          if (payload.helpeeId === storedUserId) {
            const helperProfile = participantProfilesRef.current[payload.helperId] || { name: payload.helperId, photo: null };
            assistRequestActiveRef.current = true;
            setCopilotSuggestion(null);
            setInlineHelpExtension([]);
            setAssistWidget(null);
            setHelpeeFixHint({
              helperId: payload.helperId,
              helperName: helperProfile.name || payload.helperId,
              helperPhoto: helperProfile.photo || null,
              concept: payload.concept || '',
              focusCode: payload.focusCode || '',
              focusExplanation: payload.focusExplanation || '',
            });
          }
        }
        if (data['event'] === 'helpDraftShared') {
          const { helpeeId } = data['payload'] || {};
          if (helpeeId === storedUserId) {
            assistRequestActiveRef.current = false;
            setInlineHelpExtension([]);
            setHelpeeFixHint(null);
          }
        }
        if (data['event'] === 'helperSuggestion') {
          const { suggestion, detectedConcepts, anchorKeyword } = data['payload'];
          if (suggestion) {
            if (assistRequestActiveRef.current) {
              return;
            }
            const conceptLabel = detectedConcepts[0] || 'this';
            const key = `${suggestion.helperId || suggestion.helperName}::${conceptLabel}`;

            // Aggregate into the helper list for the header button (dedup per helper+concept).
            setHelperSuggestions((prev) => {
              const existing = prev.find(
                (s) => s.helperId === suggestion.helperId && s.concepts?.[0] === conceptLabel
              );
              const next = existing ? prev : [...prev, { ...suggestion, concepts: [conceptLabel] }];
              window.dispatchEvent(new CustomEvent('canary-helpers-updated', { detail: { helpers: next } }));
              return next;
            });

            // Backend keeps re-sending suggestions while the user needs help. If 15s
            // elapse without a new one (user moved to another task or finished),
            // clear the list so the header button goes away.
            if (helpersStaleTimerRef.current) clearTimeout(helpersStaleTimerRef.current);
            helpersStaleTimerRef.current = setTimeout(() => {
              setHelperSuggestions([]);
              lastSuggestionKeyRef.current = null;
              window.dispatchEvent(new CustomEvent('canary-helpers-updated', { detail: { helpers: [] } }));
            }, 15000);

            // Only show the inline editor badge ONCE per unique helper+concept.
            if (lastSuggestionKeyRef.current !== key) {
              lastSuggestionKeyRef.current = key;
              const anchor = anchorKeyword || detectedConcepts[0] || 'pass';
              setCopilotSuggestion({
                helperId: suggestion.helperId,
                helperName: suggestion.helperName,
                helperPhoto: suggestion.helperPhoto || null,
                concept: conceptLabel,
                anchorKeyword: anchor,
                functionName: '',
              });
              setInlineHelpExtension([
                createInlineHelpField(
                  `${suggestion.helperName} can help with ${conceptLabel}. Press Tab to request peer assist.`
                ),
              ]);
            }
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
    if (activeTab === 'team') {
      const owner = taskOwnerByFunction[sourceFunction.name];
      if (owner && owner !== storedUserId) {
        console.warn(`Function '${sourceFunction.name}' is currently owned by ${owner}; selection is disabled.`);
        return;
      }
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
    const targetOwner = taskOwnerByFunction[targetFunction.name];
    if (targetOwner && targetOwner !== storedUserId) {
      console.warn(`Cannot overwrite '${targetFunction.name}' because ${targetOwner} is currently working on it.`);
      return;
    }

    ytext.delete(targetFunction.from, targetFunction.to - targetFunction.from);
    ytext.insert(targetFunction.from, `${sourceFunction.text}\n\n`);
    syncTeamEditorToBackend(ytext.toString());
  };

  const shareDraftWithHelpee = useCallback(async () => {
    if (!activeHelpAsHelper) return;
    const requestedFunctionName = helperGuidance?.functionName || '';
    const selectedFunction = getFunctionByName(personalCode, requestedFunctionName);
    const fallbackAtCursor = personalEditorViewRef.current
      ? getFunctionAtPosition(personalCode, personalEditorViewRef.current.state.selection.main.head)
      : null;
    const functionToShare = selectedFunction || fallbackAtCursor;
    if (!functionToShare) {
      console.warn('No function found to share with helpee.');
      return;
    }

    try {
      await fetch(`${BACKEND_URL}/help/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          helperId: storedUserId,
          helpeeId: activeHelpAsHelper.helpeeId,
          functionName: functionToShare.name,
          code: functionToShare.text,
        }),
      });
    } catch (error) {
      console.error('Failed to share draft with helpee:', error);
    }
  }, [activeHelpAsHelper, helperGuidance, personalCode, storedUserId]);

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
          <Panel defaultSize={55} minSize={20}>
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
                      <Tabs.Tab
                        key={p}
                        value={p}
                        title={pendingHelpIds.has(p) ? `${getParticipantProfile(p).name} requested help` : undefined}
                        style={pendingHelpIds.has(p) ? {
                          background: '#fef2f2',
                          borderColor: '#fca5a5',
                          color: '#b91c1c',
                          borderRadius: 8,
                        } : undefined}
                      >
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
                        <Badge size="xs" variant="light" color="gray">Read-only</Badge>
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
                        editable={false}
                        onCreateEditor={(view) => {
                          teamEditorViewRef.current = view;
                          leftEditorViewRefs.current.team = view;
                          const activeFn = getFunctionAtPosition(view.state.doc.toString(), view.state.selection.main.head);
                          setSelectedTeamFunction(activeFn?.name || '');
                        }}
                        extensions={[
                          python(),
                          ...pythonIndent,
                          yCollab(ytext, undefined),
                          runIconField,
                          sharedRunIconGutter,
                          runIconGutterTheme,
                          ...teamOwnershipExtension,
                          ...selectedTeamFunctionExtension,
                          ...remoteCursorExtension,
                          ViewPlugin.fromClass(class {
                            update(u: ViewUpdate) {
                              if (suppressTeamSyncRef.current) return;
                              if (!u.docChanged && !u.selectionSet && !u.focusChanged) return;
                              if (u.docChanged) sendTypingEvent('team');
                              if (u.selectionSet || u.focusChanged || u.docChanged) {
                                const activeFn = getFunctionAtPosition(
                                  u.state.doc.toString(),
                                  u.state.selection.main.head,
                                );
                                setSelectedTeamFunction(activeFn?.name || '');
                              }
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
                          {pendingHelpIds.has(p) && (
                            <Badge color="red" variant="light" size="xs" title="This peer requested help">
                              Needs help
                            </Badge>
                          )}
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
                            editable={isAgentMode}
                            onChange={(value) => {
                              if (!isAgentMode) return;
                              setOtherEditors((prev) => ({ ...prev, [p]: value }));
                              const ws = wsRef.current;
                              if (ws && ws.readyState === WebSocket.OPEN) {
                                ws.send(JSON.stringify({
                                  event: 'updatePlayground',
                                  payload: {
                                    userId: p,
                                    doc: value,
                                    timeStamp: new Date().getTime(),
                                  },
                                }));
                              }
                            }}
                            onCreateEditor={(view) => {
                              leftEditorViewRefs.current[p] = view;
                            }}
                            extensions={[python(), runIconField, sharedRunIconGutter, runIconGutterTheme]}
                            style={{ height: '100%', opacity: isAgentMode ? 1 : 0.9 }}
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
                    title={
                      activeHelpAsHelper && activeTab === activeHelpAsHelper.helpeeId
                        ? `Share draft with ${activeHelpAsHelper.helpeeName}`
                        : "Copy My Editor to Team Editor"
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      if (activeHelpAsHelper && activeTab === activeHelpAsHelper.helpeeId) {
                        void shareDraftWithHelpee();
                        return;
                      }
                      copyPersonalToTeam();
                    }}
                    className={styles.copyArrowBtn}
                    disabled={activeTab !== 'team' && !(activeHelpAsHelper && activeTab === activeHelpAsHelper.helpeeId)}
                    style={activeTab !== 'team' && !(activeHelpAsHelper && activeTab === activeHelpAsHelper.helpeeId) ? { opacity: 0.3, cursor: 'not-allowed' } : {}}
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
                      {helperGuidanceLoading && (
                        <Badge color="blue" variant="light" size="sm">
                          Generating peer-assist draft...
                        </Badge>
                      )}
                    </Group>
                    <Group gap="xs">
                      <Button
                        onClick={() => requestPeerAssist('button')}
                        size='compact-xs'
                        color='red'
                        variant='light'
                      >
                        Request Help
                      </Button>
                      {activeHelpAsHelper && (
                        <Button
                          onClick={() => { void shareDraftWithHelpee(); }}
                          size='compact-xs'
                          color='teal'
                          variant='light'
                        >
                          Share with {activeHelpAsHelper.helpeeName}
                        </Button>
                      )}
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
                        if (isAgentMode) {
                          // Expose for Playwright fallback: `window.__personalEditorView.dispatch(...)`
                          (window as any).__personalEditorView = view;
                        }
                      }}
                      onChange={handlePersonalEditorChange}
                      extensions={personalEditorResolvedExtensions}
                      basicSetup={isAgentMode ? {
                        autocompletion: false,
                        bracketMatching: false,
                        closeBrackets: false,
                      } : undefined}
                      style={{ height: '100%' }}
                    />
                    {assistWidget && (
                      <div className={styles.helperCard} style={{
                        border: assistWidget.status === 'accepted' ? '1px solid #22c55e' : '1px solid #f59e0b',
                        background: assistWidget.status === 'accepted' ? '#f0fdf4' : '#fffbeb',
                      }}>
                        <ParticipantLabel
                          id={assistWidget.helperId}
                          name={assistWidget.helperName}
                          photo={assistWidget.helperPhoto}
                          avatarSize={28}
                          textSize={13}
                        />
                        <div style={{ fontSize: 12, marginTop: 6, color: assistWidget.status === 'accepted' ? '#166534' : '#92400e', fontWeight: 600 }}>
                          {assistWidget.status === 'accepted'
                            ? `${assistWidget.helperName} accepted (${assistWidget.concept}).`
                            : `Waiting for ${assistWidget.helperName} (${assistWidget.concept}).`}
                        </div>
                      </div>
                    )}
                    {helpeeFixHint && (
                      <div className={styles.helperCard} style={{ top: 92, border: '1px solid #22c55e', background: '#f0fdf4', minWidth: 260, paddingTop: 18 }}>
                        <button
                          onClick={() => setHelpeeFixHint(null)}
                          aria-label="Close helper hint"
                          style={{
                            position: 'absolute',
                            top: 6,
                            right: 8,
                            border: 'none',
                            background: 'transparent',
                            cursor: 'pointer',
                            fontSize: 16,
                            lineHeight: 1,
                            color: '#166534',
                            fontWeight: 700,
                          }}
                        >
                          ×
                        </button>
                        <div style={{ fontSize: 12, color: '#166534', fontWeight: 700, marginBottom: 4 }}>
                          Talk to {helpeeFixHint.helperName}
                        </div>
                        <div style={{ fontSize: 11, color: '#166534' }}>
                          {helpeeFixHint.focusExplanation || `Review the highlighted ${helpeeFixHint.concept} lines.`}
                        </div>
                      </div>
                    )}
                    {helperGuidance && activeHelpAsHelper && (
                      <div style={{
                        position: 'absolute',
                        top: 8,
                        left: 8,
                        right: 8,
                        background: '#eff6ff',
                        border: '1px solid #bfdbfe',
                        borderRadius: 8,
                        padding: '8px 10px',
                        zIndex: 12,
                      }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: '#1d4ed8' }}>
                          Peer-assist draft for {activeHelpAsHelper.helpeeName} ({helperGuidance.concept || 'focused fix'})
                        </div>
                        <div style={{ fontSize: 11, color: '#1e3a8a', marginTop: 3 }}>
                          {helperGuidance.focusExplanation || helperGuidance.helperMessage}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </Panel>
            </PanelGroup>
          </Panel>

          <PanelResizeHandle />

          {/* Bottom: Graph + Output */}
          <Panel defaultSize={45} minSize={20}>
            <PanelGroup direction="horizontal">
              <Panel defaultSize={50}>
                <div style={{ padding: '10px', height: '100%', boxSizing: 'border-box' }}>
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

// Shared Python auto-indent extensions for all editable editors.
const pythonIndent: Extension[] = [
  indentUnit.of("    "),
  indentOnInput(),
  keymap.of([...defaultKeymap, indentWithTab]),
];

// Y.js Collaboration Extension
const ydoc = new Y.Doc();
const ytext = ydoc.getText('codemirror');
