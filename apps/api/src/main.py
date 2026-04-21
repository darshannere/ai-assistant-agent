import asyncio
import os
import aiohttp
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse
from fastapi import Response
from typing import Dict, Callable, List, Optional, Any
from pydantic import BaseModel
import subprocess
import re
import sys
import io
import ast
import inspect
import importlib
import difflib
from textwrap import dedent
import csv
from pathlib import Path
from collections import ChainMap, defaultdict
import json
import study_problem_sol
import study_problem_tester
from datetime import datetime, timedelta
import time as _time
from openai import OpenAI
from concept_reference_map import CONCEPT_REFERENCE_TEMPLATES
from dotenv import load_dotenv
from study_problem_classes import Menu, Order, Customer, Restaurant
app = FastAPI()

load_dotenv()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Vite's default port
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class InputBody(BaseModel):
    code: str
    channel: str


class ClaimFunctionBody(BaseModel):
    participantId: str
    functionName: str


class SampleRunBody(BaseModel):
    code: str
    channel: str
    functionName: str
    setupCode: str
    callExpression: str
    trackedExpressions: List[str] = []


class NotifyBody(BaseModel):
    users: List[str]
    options: List[str]


class ReplyBody(BaseModel):
    id: str
    choice: str
    text: Optional[str]


class ParticipantProfile(BaseModel):
    id: str
    name: str
    photo: str
    timestamp: int


class ProfileManager:
    def __init__(self):
        self.profiles: Dict[str, ParticipantProfile] = {}
    
    def save_profile(self, profile: ParticipantProfile):
        self.profiles[profile.id] = profile
        return profile
    
    def get_profile(self, participant_id: str):
        return self.profiles.get(participant_id)
    
    def get_all_profiles(self):
        return self.profiles


class SocketManager:
    def __init__(self):
        self.connections: list[WebSocket] = []
        self.total_seconds = 20 * 60
        self.countdown_task = None

    async def connect(self, ws: WebSocket, id: str):
        await ws.accept()
        ws.id = id
        self.connections.append(ws)
        global state
        if ws.id != "control":
            with open("study_problem_blank.py", "r") as file:
                starter_code = file.read()
            doc = state if state != "" else starter_code
            msg = json.dumps({"event": "initial", "payload": {"doc": doc}})
            await self.direct_message(msg, id)

    def disconnect(self, ws: WebSocket):
        self.connections.remove(ws)
        global cursor_positions, state
        if ws.id in cursor_positions:
            del cursor_positions[ws.id]
            event = {
                "event": "document_update",
                "payload": {
                    "doc": state,
                    "user": ws.id,
                    "cursors": cursor_positions,
                },
            }
            asyncio.create_task(self.broadcast(json.dumps(event)))
        conns = [conn for conn in self.connections if conn.id != "control"]
        if len(conns) == 0:
            if self.countdown_task:
                self.countdown_task = False
                print("Cancelling countdown")

    async def broadcast(self, msg: str):
        for ws in self.connections:
            await ws.send_text(msg)

    async def direct_message(self, msg: str, id: str):
        for ws in self.connections:
            if ws.id == id:
                await ws.send_text(msg)

    async def broadcast_countdown(self):
        try:
            while self.total_seconds > 0 and self.countdown_task:
                minutes, seconds = divmod(self.total_seconds, 60)
                event = {
                    "event": "countdown",
                    "payload": {"minutes": minutes, "seconds": seconds},
                }
                await self.broadcast(json.dumps(event))
                self.total_seconds -= 1
                await asyncio.sleep(1)
            await self.broadcast(json.dumps({"event": "countDownEnd"}))
        except asyncio.CancelledError:
            self.broadcast(json.dumps({"event": "timer"}))


def normalize_participant_id(participant_id: str) -> str:
    return participant_id.replace('"', '')


def parse_top_level_functions(code: str) -> Dict[str, str]:
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return {}

    function_map: Dict[str, str] = {}
    for node in tree.body:
        if isinstance(node, ast.FunctionDef):
            source = ast.get_source_segment(code, node)
            if source:
                function_map[node.name] = dedent(source).strip()
    return function_map


def _get_solution_function_code(function_name: str) -> str:
    if not function_name:
        return ""

    candidate_paths = [
        Path(__file__).resolve().parent / "study_problem_sol.py",
        Path.cwd() / "study_problem_sol.py",
    ]
    for path in candidate_paths:
        try:
            if not path.exists():
                continue
            solution_code = path.read_text()
            function_map = parse_top_level_functions(solution_code)
            if function_name in function_map:
                return function_map[function_name].strip()
        except OSError:
            continue

    try:
        module_source = inspect.getsource(study_problem_sol)
        function_map = parse_top_level_functions(module_source)
        if function_name in function_map:
            return function_map[function_name].strip()
    except (OSError, TypeError):
        pass

    fallback_obj = getattr(study_problem_sol, function_name, None)
    if fallback_obj is None:
        return ""
    try:
        return dedent(inspect.getsource(fallback_obj)).strip()
    except (OSError, TypeError):
        return ""


def _extract_function_for_share(function_name: str, code: str) -> Optional[tuple[str, str]]:
    function_map = parse_top_level_functions(code)
    if not function_map:
        return None
    if function_name and function_name in function_map:
        return function_name, function_map[function_name]
    first_name = next(iter(function_map))
    return first_name, function_map[first_name]


def _replace_top_level_function_in_code(original_code: str, function_name: str, replacement_code: str) -> Optional[str]:
    try:
        replacement_tree = ast.parse(dedent(replacement_code))
        original_tree = ast.parse(original_code)
    except SyntaxError:
        return None

    replacement_node = None
    for node in replacement_tree.body:
        if isinstance(node, ast.FunctionDef):
            replacement_node = node
            break
    if replacement_node is None:
        return None

    replaced = False
    new_body = []
    for node in original_tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == function_name:
            new_body.append(replacement_node)
            replaced = True
        else:
            new_body.append(node)

    if not replaced:
        return None

    original_tree.body = new_body
    return ast.unparse(original_tree)


def _compute_changed_line_ranges(base_code: str, next_code: str) -> List[Dict[str, int]]:
    base_lines = base_code.splitlines()
    next_lines = next_code.splitlines()
    matcher = difflib.SequenceMatcher(a=base_lines, b=next_lines)
    ranges: List[Dict[str, int]] = []

    for tag, _i1, _i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            continue
        if tag in ("replace", "insert") and j2 > j1:
            ranges.append({"start": j1 + 1, "end": j2})
        elif tag == "delete":
            fallback_start = min(j1 + 1, len(next_lines)) if next_lines else 1
            ranges.append({"start": fallback_start, "end": fallback_start})

    if not ranges and next_lines:
        return [{"start": 1, "end": len(next_lines)}]
    return ranges


def _help_variant_key(helper_id: str, helpee_id: str, function_name: str) -> str:
    return f"{normalize_participant_id(helper_id)}::{normalize_participant_id(helpee_id)}::{function_name}"


def _make_variant_entry(
    *,
    group: Dict[str, Any],
    author_id: str,
    kind: str,
    code: str,
) -> Dict[str, Any]:
    label = f"v{len(group['variants']) + 1}"
    variant_id = f"{group['sessionKey']}::{label.lower()}::{int(_time.time() * 1000)}"
    base_code = group["variants"][0]["code"] if group["variants"] else code
    return {
        "variantId": variant_id,
        "label": label,
        "authorId": normalize_participant_id(author_id),
        "kind": kind,
        "code": code.strip(),
        "changedLineRanges": [] if kind == "base" else _compute_changed_line_ranges(base_code, code.strip()),
        "createdAt": int(_time.time()),
    }


def _make_comment_entry(
    *,
    author_id: str,
    variant_id: str,
    body: str,
    concept: str,
    line_start: Optional[int],
    line_end: Optional[int],
) -> Dict[str, Any]:
    return {
        "commentId": f"{variant_id}::comment::{int(_time.time() * 1000)}",
        "variantId": variant_id,
        "authorId": normalize_participant_id(author_id),
        "body": body.strip(),
        "concept": concept,
        "lineStart": line_start,
        "lineEnd": line_end,
        "createdAt": int(_time.time()),
    }


def _resolve_help_variant_group(helper_id: str, helpee_id: str, function_name: str) -> Optional[Dict[str, Any]]:
    key = _help_variant_key(helper_id, helpee_id, function_name)
    return editor_manager.help_variant_groups.get(key)


def _ensure_help_variant_group(
    *,
    helper_id: str,
    helpee_id: str,
    function_name: str,
    concept: str,
    focus_code: str,
    focus_line_start: int,
    focus_line_end: int,
    base_function_code: str,
    session_key: str,
) -> Dict[str, Any]:
    key = _help_variant_key(helper_id, helpee_id, function_name)
    existing = editor_manager.help_variant_groups.get(key)
    if existing:
        return existing

    base_group = {
        "sessionKey": session_key,
        "functionName": function_name,
        "baseVariantId": "",
        "concept": concept,
        "focusCode": focus_code,
        "focusLineStart": focus_line_start,
        "focusLineEnd": focus_line_end,
        "variants": [],
        "comments": [],
    }
    base_variant = _make_variant_entry(
        group=base_group,
        author_id=helpee_id,
        kind="base",
        code=base_function_code,
    )
    base_group["variants"].append(base_variant)
    base_group["baseVariantId"] = base_variant["variantId"]
    editor_manager.help_variant_groups[key] = base_group
    return base_group


def _serialize_help_variant_group(group: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "sessionKey": group["sessionKey"],
        "functionName": group["functionName"],
        "baseVariantId": group["baseVariantId"],
        "concept": group.get("concept", ""),
        "focusCode": group.get("focusCode", ""),
        "focusLineStart": group.get("focusLineStart", 1),
        "focusLineEnd": group.get("focusLineEnd", 1),
        "variants": group.get("variants", []),
        "comments": group.get("comments", []),
    }


async def _broadcast_help_variant_group(group: Dict[str, Any], event_name: str, latest_payload: Dict[str, Any]):
    state_payload = _serialize_help_variant_group(group)
    helper_id, helpee_id = group["sessionKey"].split("::", 1)
    state_event = json.dumps({
        "event": "helpVariantState",
        "payload": state_payload,
    })
    latest_event = json.dumps({
        "event": event_name,
        "payload": {
            **latest_payload,
            "group": state_payload,
        },
    })
    await socketManager.direct_message(state_event, helper_id)
    await socketManager.direct_message(state_event, helpee_id)
    await socketManager.direct_message(latest_event, helper_id)
    await socketManager.direct_message(latest_event, helpee_id)


def expand_matched_block(lines: List[str], start_idx: int) -> tuple[int, int]:
    line = lines[start_idx]
    base_indent = len(line) - len(line.lstrip())
    end_idx = start_idx

    if line.rstrip().endswith(":"):
        for idx in range(start_idx + 1, len(lines)):
            candidate = lines[idx]
            if not candidate.strip():
                end_idx = idx
                continue
            indent = len(candidate) - len(candidate.lstrip())
            if indent <= base_indent:
                break
            end_idx = idx
    return start_idx, end_idx


def infer_generic_patterns(concept: str) -> List[str]:
    generic_patterns = {
        "String Interpolation": [r'f["\']', r"\.format\("],
        "Looping": [r"^\s*for\b", r"^\s*while\b"],
        "Looping (while loop)": [r"^\s*while\b"],
        "Dictionary concepts": [r"\.items\(", r"\[[^\]]+\]"],
        "Dictionary Operation": [r"\[[^\]]+\]"],
        "Dictionary Operations": [r"\[[^\]]+\]"],
        "Dictionary Lookup": [r"\[[^\]]+\]"],
        "Dictionary iteration": [r"\.items\("],
        "List Operations": [r"\.append\(", r"\.remove\(", r"\.pop\(", r"\.clear\("],
        "List concepts": [r"\.append\(", r"\.remove\(", r"\.pop\(", r"\.clear\("],
        "Conditional": [r"^\s*if\b", r"^\s*else\b"],
        "Conditional (if-else)": [r"^\s*if\b", r"^\s*else\b"],
        "Conditional Statements": [r"^\s*if\b", r"^\s*else\b"],
        "Conditional Statement (If-else)": [r"^\s*if\b", r"^\s*else\b"],
        "Conditional Statement (if-else)": [r"^\s*if\b", r"^\s*else\b"],
        "Function Calling": [r"\b[a-zA-Z_]\w*\("],
        "Tuple": [r"return\s*\("],
        "Random num generation": [r"random\.\w+\(", r"randint\("],
        "Object initialization": [r"\b[A-Z][A-Za-z_]*\("],
    }
    return generic_patterns.get(concept, [])


def infer_concept_reference(function_name: str, concept: str, implementation_code: str) -> dict:
    template = CONCEPT_REFERENCE_TEMPLATES.get(function_name, {}).get(concept, {})
    patterns = template.get("patterns", []) or infer_generic_patterns(concept)
    lines = implementation_code.splitlines()

    for pattern in patterns:
        for idx, line in enumerate(lines):
            if re.search(pattern, line):
                start_idx, end_idx = expand_matched_block(lines, idx)
                snippet = "\n".join(lines[start_idx:end_idx + 1]).rstrip()
                return {
                    "line_start": start_idx + 1,
                    "line_end": end_idx + 1,
                    "code": snippet,
                    "solution_reference": template.get("solution_snippet", ""),
                }

    return {
        "line_start": 1,
        "line_end": len(lines),
        "code": implementation_code.strip(),
        "solution_reference": template.get("solution_snippet", ""),
    }


class GraphNode:
    def __init__(self, name: str, desc: str, concepts: str, example_input: str = "", example_output: str = ""):
        self.name = name
        self.claimed_by = ""

        # 0 - not claimed
        # 1 - working
        # 2 - done
        self.work_status = 0

        self.completed = 0
        self.total = 0
        self.desc = desc
        self.concepts = concepts
        self.example_input = example_input
        self.example_output = example_output
        self.start_time = None

    def update_status(self, id: str):
        if self.work_status != 2:
            if self.claimed_by == "" and self.work_status == 0:
                self.claimed_by = id
                self.work_status = 1
                self.start_time = datetime.now()
                editor_manager.message_history.append(
                    {
                        "role": "user",
                        "content": f"{self.claimed_by} is working on {self.name}",
                    }
                )
                editor_manager.profiles[self.claimed_by] = self.name
                print("claimed by", editor_manager.profiles)
            elif self.claimed_by == id and self.work_status == 1:
                self.claimed_by = ""
                self.work_status = 0
                editor_manager.message_history.append(
                    {
                        "role": "user",
                        "content": f"{self.claimed_by} is not working on {self.name}",
                    }
                )
                editor_manager.profiles[self.claimed_by] = ""
                self.start_time = None

    async def update_completed(self, completed: int, remaining: int):
        if self.claimed_by != "":
            if completed == remaining and remaining != 0:
                self.work_status = 2
                participant = self.claimed_by
                editor_manager.profiles[participant] = ""
                # Accumulate concepts for this participant
                new_concepts = [c.strip() for c in self.concepts.split(",") if c.strip()]
                existing = editor_manager.participant_concepts.get(participant, [])
                editor_manager.participant_concepts[participant] = list(
                    dict.fromkeys(existing + new_concepts)  # deduplicate, preserve order
                )
                if participant in editor_manager.individual:
                    editor_manager.refresh_concept_evidence_from_code(
                        participant,
                        editor_manager.individual[participant],
                        source="personal",
                    )
                if editor_manager.master:
                    editor_manager.refresh_concept_evidence_from_code(
                        participant,
                        editor_manager.master,
                        source="team",
                    )
                editor_manager.message_history.append(
                    {"role": "user", "content": f"{self.name} is complete"}
                )
                await editor_manager.send_notification(
                    id=participant,
                    task=self.name,
                    done=True,
                    time=get_time_diff(self.start_time),
                )
            else:
                self.work_status = 1
            self.total = remaining
            self.completed = completed


def get_time_diff(start_time: datetime) -> int:
    return int((datetime.now() - start_time).total_seconds())


def get_participant_states() -> dict:
    """
    Returns cognitive state for each known participant.
    'unavailable' = actively working on a task (work_status == 1)
    'available'   = idle or just finished (no active task)
    Includes profile photo/name if available.
    """
    states = {}
    for node in graph_manager.graph.values():
        if node.work_status == 1 and node.claimed_by:
            pid = node.claimed_by
            profile = profile_manager.get_profile(pid)
            if pid not in states:
                states[pid] = {
                    "status": "unavailable",
                    "currentTasks": [],
                    "name": profile.name if profile else pid,
                    "photo": profile.photo if profile else None,
                    "concepts": editor_manager.participant_concepts.get(pid, []),
                }
            states[pid]["currentTasks"].append(node.name)
    # Mark participants with known profiles who aren't working as available
    for pid, profile in profile_manager.get_all_profiles().items():
        if pid not in states:
            states[pid] = {
                "status": "available",
                "currentTasks": [],
                "name": profile.name,
                "photo": profile.photo,
                "concepts": editor_manager.participant_concepts.get(pid, []),
            }
    return states


class GraphManager:
    def __init__(self):
        self.graph: Dict[str, GraphNode] = {}
        with open("functions.csv", newline="") as csvfile:
            reader = csv.DictReader(csvfile)
            for row in reader:
                func = row.get("Function", "").strip()
                if not func or func.startswith("#"):
                    continue
                self.graph[func] = GraphNode(
                    name=row["Function"],
                    desc=row["description"],
                    concepts=row["Concepts"],
                    example_input=row.get("example_input", ""),
                    example_output=row.get("example_output", ""),
                )

    def update_status(self, node_id: str, id: str):
        if node_id in self.graph:
            self.graph[node_id].update_status(id)

    def claim_function(self, node_id: str, participant_id: str) -> bool:
        clean_id = normalize_participant_id(participant_id)
        node = self.graph.get(node_id)
        if not node:
            return False
        if node.work_status == 2:
            return normalize_participant_id(node.claimed_by) == clean_id
        if node.claimed_by and normalize_participant_id(node.claimed_by) != clean_id:
            return False

        for other_node in self.graph.values():
            if (
                other_node.name != node_id
                and other_node.work_status == 1
                and normalize_participant_id(other_node.claimed_by) == clean_id
            ):
                other_node.claimed_by = ""
                other_node.work_status = 0
                other_node.start_time = None

        if node.work_status == 1 and normalize_participant_id(node.claimed_by) == clean_id:
            return True

        node.claimed_by = clean_id
        node.work_status = 1
        node.start_time = datetime.now()
        editor_manager.profiles[clean_id] = node_id
        return True

    async def update_completed(self, node_id: str, completed: int, remaining: int):
        await self.graph[node_id].update_completed(completed, remaining)
        work_statuses = [
            {node: graph_manager.graph[node].work_status}
            for node in graph_manager.graph
        ]

        event = {
            "event": "updateGraph",
            "payload": {
                "graph": dict(ChainMap(*work_statuses)),
                "participantStates": get_participant_states(),
            },
        }
        await socketManager.broadcast(json.dumps(event))

    def percent_done(self):
        completion = 0
        for node in self.graph.values():
            completion += node.completed
        return (completion / 30) * 100

    def get_task_summary(self):
        """
        Returns a summary of how many tasks each person has completed out of the total.
        """
        user_summary = {}
        for node in self.graph.values():
            if node.claimed_by != "":
                user = node.claimed_by
                if user not in user_summary:
                    user_summary[user] = {"completed": 0, "total_assigned": 0}
                user_summary[user]["total_assigned"] += node.total
                if node.work_status == 2:
                    user_summary[user]["completed"] += node.completed
        return user_summary


def build_graph_event() -> dict:
    work_statuses = [
        {node_name: graph_manager.graph[node_name].work_status}
        for node_name in graph_manager.graph
    ]
    return {
        "event": "updateGraph",
        "payload": {
            "graph": dict(ChainMap(*work_statuses)),
            "participantStates": get_participant_states(),
        },
    }


async def broadcast_graph_event():
    await socketManager.broadcast(json.dumps(build_graph_event()))


async def _auto_sync_completed_function(participant_id: str, function_name: str, function_code: str) -> bool:
    global state
    clean_id = normalize_participant_id(participant_id)
    node = graph_manager.graph.get(function_name)
    if not node:
        return False
    if node.work_status != 2 or normalize_participant_id(node.claimed_by) != clean_id:
        return False

    current_doc = editor_manager.master or state
    if not current_doc.strip():
        return False

    next_doc = _replace_top_level_function_in_code(current_doc, function_name, function_code)
    if not next_doc or next_doc == current_doc:
        return False

    state = next_doc
    editor_manager.update_master(next_doc, clean_id)
    await socketManager.broadcast(json.dumps({
        "event": "document_update",
        "payload": {
            "doc": state,
            "user": clean_id,
            "cursors": cursor_positions,
        },
    }))
    return True

class PredictionResponse(BaseModel):
    prediction: int
    completed: int

class HelpRequest(BaseModel):
    helper: str
    time: int
    hint: str = "this is hint"
    helpeeId: Optional[str] = None


class HelpShareBody(BaseModel):
    helperId: str
    helpeeId: str
    code: str
    functionName: Optional[str] = None
    concept: Optional[str] = None
    comment: Optional[str] = None
    lineStart: Optional[int] = None
    lineEnd: Optional[int] = None


class HelpManualVariantBody(BaseModel):
    participantId: str
    helperId: str
    helpeeId: str
    functionName: str
    code: str
    concept: Optional[str] = None


class HelpCommentBody(BaseModel):
    authorId: str
    helperId: str
    helpeeId: str
    functionName: str
    variantId: str
    body: str
    concept: Optional[str] = None
    lineStart: Optional[int] = None
    lineEnd: Optional[int] = None

class EditorManager:
    def __init__(self):
        self.master = ""
        self.individual = {}
        self.profiles = {}
        self.help_queue = []
        self.active_help_sessions: List[Dict] = []  # tracks who is helping whom
        self.pending_help_context: Dict[str, Dict[str, Any]] = {}
        self.active_help_context: Dict[str, Dict[str, Any]] = {}
        self.help_variant_groups: Dict[str, Dict[str, Any]] = {}
        self.generated_help_drafts: Dict[str, Dict[str, Any]] = {}
        self.participant_concepts: Dict[str, List[str]] = {}  # accumulated concepts per participant
        self.participant_concept_evidence: Dict[str, Dict[str, List[Dict]]] = {}
        client = OpenAI(
            api_key=os.environ["OPENROUTER_API_KEY"],
            base_url="https://openrouter.ai/api/v1"
        )
        self.client = client
        # openai.api_key = ""
        self.message_history = [
            {"role": "system", "content": ("Keep all responses 1 sentence long. ")},
            {
                "role": "system",
                "content": (
                    """The test is 20 minutes long and each
                                           task is estimated to be finished in 3
                                           minutes or less"""
                ),
            },
            {
                "role": "system",
                "content": """
                            You are a task helping assistant. The project is
                            linked like a graph

                            The tasks are linked like this:
                            (Customer, view_menu)
                            (Customer, create_order)
                            (Restaurant, inventory_helper)
                            (Restaurant, restock_inventory)
                            (Restaurant, cook_time_helper)
                            (create_order, view_order_summary)
                            (create_order, calculate_order_cost)
                            (create_order, clear_order)
                            (create_order, add_to_queue)
                            (view_order_summary, get_receipt)
                            (calculate_order_cost, add_to_order)
                            (calculate_order_cost, remove_from_order)
                            (inventory_helper, cook_order)
                            (cook_time_helper, cook_order)
                            (add_to_queue, cook_order)
                            (cook_time_helper, average_cook_time)
                            """,
            },
            {
                "role": "system",
                "content": """
                            You are a task helping assistant. The tasks lised
                            before also have concepts

                            The tasks have concepts maps like this:
                            (view_menu, String Interpolation + Looping + Dictionary concepts)
                            (create_order, Random num generation + Object Initiation + Dictionary Operations)
                            (clear_order, List Operations + Dictionary Lookup)
                            (view_order_summary, Looping + String Interpolation)
                            (add_to_order, Conditional Statement (If-else) + List concepts + String Interpolation)
                            (remove_from_order, Conditional Statement (If-else) + List concepts + String Interpolation + Function Calling)
                            (calculate_order_cost, Looping + Dictionary concepts)
                            (get_receipt, String Interpolation + Looping)
                            (add_to_queue, List Operations)
                            (cook_order, List Operations + Tuple + Looping + Function calling)
                            (restock_inventory, Conditional Statement (if-else) + String Interpolation + Dictionary concepts)
                            (cook_time_helper, Dictionary Operations)
                            (inventory_helper, Conditional Statements + Dictionary Operations)
                            (average_cook_time, Looping + Function Calling)

                            """,
                
        
            },
        ]

    def update_profile(self, id, concepts):
        self.profiles[id] = state

    def update_master(self, state, participant_id: Optional[str] = None):
        self.master = state
        if participant_id:
            self.refresh_concept_evidence_from_code(participant_id, state, source="team")

    def update_individual(self, id, state):
        self.individual[id] = state
        self.refresh_concept_evidence_from_code(id, state, source="personal")

    def refresh_concept_evidence(self, participant_id: str, function_name: str, function_code: str, source: str):
        participant_id = normalize_participant_id(participant_id)
        if function_name not in graph_manager.graph:
            return

        node = graph_manager.graph[function_name]
        if node.work_status != 2 or normalize_participant_id(node.claimed_by) != participant_id:
            return

        concepts = [c.strip() for c in node.concepts.split(",") if c.strip()]
        participant_store = self.participant_concept_evidence.setdefault(participant_id, {})
        timestamp = int(_time.time())

        for concept in concepts:
            inferred_reference = infer_concept_reference(function_name, concept, function_code)
            evidence_entry = {
                "function": function_name,
                "code": inferred_reference["code"],
                "line_start": inferred_reference["line_start"],
                "line_end": inferred_reference["line_end"],
                "source": source,
                "updated_at": timestamp,
                "implemented_by": participant_id,
                "solution_reference": inferred_reference["solution_reference"],
            }

            existing_entries = participant_store.get(concept, [])
            existing_entries = [entry for entry in existing_entries if entry.get("function") != function_name]
            existing_entries.append(evidence_entry)
            existing_entries.sort(key=lambda entry: entry.get("updated_at", 0), reverse=True)
            participant_store[concept] = existing_entries

    def refresh_concept_evidence_from_code(self, participant_id: str, code: str, source: str):
        participant_id = normalize_participant_id(participant_id)
        for function_name, function_code in parse_top_level_functions(code).items():
            self.refresh_concept_evidence(participant_id, function_name, function_code, source)

    def update_concept_evidence_manual(
        self,
        participant_id: str,
        concept: str,
        function_name: str,
        line_start: int,
        line_end: int,
        code: str,
    ):
        participant_id = normalize_participant_id(participant_id)
        lines = code.splitlines()
        if not lines:
            return None

        safe_start = max(1, min(line_start, len(lines)))
        safe_end = max(safe_start, min(line_end, len(lines)))
        snippet = "\n".join(lines[safe_start - 1:safe_end]).rstrip()
        participant_store = self.participant_concept_evidence.setdefault(participant_id, {})
        existing_entries = participant_store.get(concept, [])
        solution_reference = CONCEPT_REFERENCE_TEMPLATES.get(function_name, {}).get(concept, {}).get("solution_snippet", "")
        manual_entry = {
            "function": function_name,
            "code": snippet,
            "line_start": safe_start,
            "line_end": safe_end,
            "source": "team-manual",
            "updated_at": int(_time.time()),
            "implemented_by": participant_id,
            "solution_reference": solution_reference,
        }
        existing_entries = [entry for entry in existing_entries if entry.get("function") != function_name]
        existing_entries.append(manual_entry)
        existing_entries.sort(key=lambda entry: entry.get("updated_at", 0), reverse=True)
        participant_store[concept] = existing_entries
        return manual_entry

    def extract_json(text):
                pattern = r'```json(.*?)```'
                matches = re.findall(pattern, text, re.DOTALL)
                return [match.strip() for match in matches]


    async def send_notification(self, id, task, done, time=0):
        if done:
            response = await self.generate_options_for_new_task(id, task, time)
            res = graph_manager.get_task_summary()
            if len(self.help_queue) == 0:
                print("no help queue")
                
                def extract_json(text):
                    pattern = r'```json(.*?)```'
                    matches = re.findall(pattern, text, re.DOTALL)
                    return [match.strip() for match in matches]
                
                opt=extract_json(response)

                event = {
                    "event": "Suggestion",
                    "payload": {
                        "context": f"Great work finishing {task} here are some suggestions for next steps",
                        "help": "doneNoHelp",
                        "options":response,
                    },
                }
                id = id.replace('"', '')
                await socketManager.direct_message(id=id, msg=json.dumps(event))
            else:
                helpee = self.help_queue[0]
                print("helpee", helpee)
                # print("sellf.individual", self.individual)
                prompt2 = f"""Here is {helpee[0]}s code: \n
                # {self.individual[helpee[0]]}"""

                # how likely is it that the group will finish at the end of 20
                # minutes if the person spends 5 minutes helping?

                prompt2 += f"""Organize help sessions of 1 minute, 2 minutes, 3
                minutes, 4 minutes, and 5 minutes to help {helpee[0]} and """
                prompt2 += f"""return to me an array of options formatted {{
                    number_of_tasks_i_could_be_doing call this field individual_disruption,
                    estimated_percent_team_can_do_in_{socketManager.total_seconds}_seconds_if_complete,
                  call this field prediction,
                    what_to_focus_to_solve_the_problem call this field focus
           
                    }}\n"""
                prompt2 += """Return this an array called options.
                
                    ONLY RETURN THIS ARRAY without any \n
                    "properties": {
                        "focus": {"type": "string", "description": "A short description of the focus. and hint to solve the problem."},
                        "individual_disruption": {"type": "number", "description": "Numeric value for individual disruption."},
                        "prediction": {"type": "number", "description": "Numeric prediction value."}
                    },
                """                
                def extract_json(text):
                    pattern = r'```json(.*?)```'
                    matches = re.findall(pattern, text, re.DOTALL)
                    return [match.strip() for match in matches]




                suggestions = self.get_open_ai_response(prompt2)
                hel='"'+helpee[0]+'"'

                # Fetch helpee's profile information
                helpee_profile = profile_manager.get_profile(helpee[0])
                helpee_name = helpee_profile.name if helpee_profile else helpee[0]
                helpee_photo = helpee_profile.photo if helpee_profile else None

                event = {
                    "event": "notification",
                    "payload": {
                        "context": f"{helpee_name} needs {helpee[1]} help with {self.profiles[hel]}",
                        "help": "doneHelp",
                        # "options": json.loads(response).get("options"),
                        # "options":response,
                        "suggestions": extract_json(suggestions),
                        "percentDone": graph_manager.percent_done(),
                        "helpeeId": helpee[0],
                        "helpeeName": helpee_name,
                        "helpeePhoto": helpee_photo,
                    },
                }
                id = id.replace('"', ''); 
                await socketManager.direct_message(id=id, msg=json.dumps(event))
                print("sent",id)
        
        else:
            event = {
                "event": "notification",
                "payload": {
                    "context": "",
                    "help": "helpSystem",
                    "options": [
                        {"task_title": "Quick Help 💡"},
                        {
                            "task_title": "I am fully stuck 🆘",
                        },
                        {"task_title": "No Help 🚫"},
                    ],
                    "progress": graph_manager.get_task_summary(),
                },
            }
            print("Seding help notification", event)
            await socketManager.direct_message(id=id, msg=json.dumps(event))

    def get_open_ai_response(self, prompt=""):
        self.message_history.append({"role": "user", "content": prompt})
        response= self.client.chat.completions.create(
            model="google/gemini-2.0-flash-001",
            messages=self.message_history,
            temperature=0,
            max_tokens=1500,
        )
        asisntant_response = response.choices[0].message
        self.message_history.append(asisntant_response)
        # print(asisntant_response)
        return asisntant_response.content
          
        
    async def get_ollama_response(self, prompt=""):
        api_url = "http://prime-lab.cs.vt.edu:11434/api/chat"
        self.message_history.append({"role": "user", "content": prompt})
        headers = {"Content-Type": "application/json"}
        payload = {
            "model": "gemma3:27b",
            "messages": self.message_history,
            "format": "json",
            "stream": False,
        }

        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    api_url, json=payload, headers=headers
                ) as response:
                    if response.status == 200:
                        data = await response.json()
                        self.message_history.append(data.get("message"))
                        return data.get("message").get("content")
                    else:
                        text = await response.text()
                        return {
                            "error": f"Request failed with status code {response.status}",
                            "details": text,
                        }
        except aiohttp.ClientError as e:
            return {"error": str(e)}

    async def generate_options_for_new_task(self, id: str, task: str, time: int) -> str:
        """
        Generates help options for the user to choose from
        """
        prompt = f"User {id} has completed {task} in {time} seconds \n"

        known_concepts = self.participant_concepts.get(id, [])
        if known_concepts:
            prompt += f"{id} has mastered these concepts so far: {', '.join(known_concepts)}.\n"

        prompt += (
            f"""Suggest 3 options for {id} using their concept knowledge
                   and best benefits the team. """
            "Return as JSON named options "
            f"""{{task_title,
                  estimated_percent_team_can_do_in_{socketManager.total_seconds}_seconds_if_complete
                  call this field prediction,
                  estimated_time_to_complete_in_seconds call this field estimated_time_in_seconds,
                  reasoning}}"""
            "Only return this array"
        )

        response = self.get_open_ai_response(prompt=prompt)
        return response

    async def get_prediction_data(self, id: str, min: str):
        prompt = f"User {id} is trying to help his teammate {self.help_queue[0]}."
        prompt += f"Give a json Prediction response of format  {{prediction: 80, completed: 20}} for {min} mins."
        prompt += "The prediction is the end goal completion of the team tasks."
        prompt += "Give response in json format only which is given above."
        response = await self.get_ollama_response(prompt)
        return response


class FunctionReplacer:
    def __init__(self, main_file: str, main_copy_file: str):
        self.main_file = main_file
        self.main_copy_file = main_copy_file
        self.function_name = ""
        self.test_full = False

    def replace_whole_file(self, new_code: str):
        with open(self.main_file, "w") as f:
            f.write(new_code)
        self.test_full = True
        print(f"Replaced {self.main_file} with new code")

    def replace_function_in_file(self, function_code: str):
        self.test_full = False
        try:
            parsed_code = ast.parse(dedent(function_code))
        except SyntaxError as e:
            print(f"Error: Invalid Python syntax in function code.\n{e}")
            return

        function_node = None
        for node in parsed_code.body:
            if isinstance(node, ast.FunctionDef):
                function_node = node
                break

        if function_node is None:
            print("Error: Provided code does not contain a valid function definition.")
            return

        function_name = function_node.name
        self.function_name = function_name

        with open(self.main_file, "r") as f:
            content = f.read()
            tree = ast.parse(content)

        class FunctionTransformer(ast.NodeTransformer):
            def visit_FunctionDef(self, node):
                if node.name == function_name:
                    return function_node
                return node

        new_tree = FunctionTransformer().visit(tree)
        new_code = ast.unparse(new_tree)

        with open(self.main_file, "w") as f:
            f.write(new_code)

    def parse_pytest_output(self, output: str) -> str:
        results = []
        lines = output.splitlines()

        is_failed = False
        failure_lines = []
        print(lines)
        for line in lines:
            stripped = line.strip()
            if "::" in stripped and ("PASSED" in stripped or "FAILED" in stripped):
                test_status = "✅" if "PASSED" in stripped else "❌"
                current_test = stripped.replace(" PASSED", "").replace(" FAILED", "")
                if test_status == "✅":
                    results.append(f"{test_status} {current_test}")
                    is_failed = False
                else:
                    results.append(f"{test_status} {current_test}")
                    is_failed = True
                    failure_lines = []

            elif is_failed:
                # Accumulate lines until next test or end
                if line.startswith(" " * 2) or line.strip().startswith("E   ") or line.strip().startswith(">"):
                    failure_lines.append(line)
                elif "::" in stripped:
                    # End of failure block
                    if failure_lines:
                        results[-1] += "\n" + "\n".join(f"   {l.strip()}" for l in failure_lines)
                    is_failed = False

        # In case last failure block never closed
        if is_failed and failure_lines:
            results[-1] += "\n" + "\n".join(f"   {l.strip()}" for l in failure_lines)
        return "\n".join(results)

    async def run_tests(self, user):
        try:
            test_cases = ""
            if not self.test_full:
                parts = re.split(r"_", self.function_name, maxsplit=2)
                test_cases = f"{parts[0]}_{parts[1]}"

            if graph_manager.graph[self.function_name].work_status == 2:
                print(f"{self.function_name} Already complete")
                return

            result = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "pytest",
                    "-v",
                    "--disable-warnings",
                    "test_study_problem.py",
                    "-k",
                    test_cases,
                    "--color=yes",
                    # "--tb=short",
                    # "-q",
                ],
                capture_output=True,
                text=True,
            )
            # def sanitize_line(line):
            #     if re.match(r"^[=]{3,}", line):
            #         return '=== FAILURES ==='
            #     if re.match(r"^[_]{3,}", line):
            #         return '___ TEST SECTION ___'
            #     return line

            # raw_lines = result.stdout.splitlines()
            # clean_lines = [sanitize_line(ln) for ln in raw_lines]

            # # Print sanitized output preserving newlines
            # print("\n".join(clean_lines))
            print(result.stdout)
            if result.stderr:
                print(f"stderr: {result.stderr[:500]}")
            if not self.test_full:
                match = re.search(
                    r"=+ (\d+) passed.*(?:, (\d+) failed)?", result.stdout
                )
                passed = int(match.group(1)) if match else 0
                passed_match = re.search(r"(\d+)\s+passed", result.stdout)
                pass_final= int(passed_match.group(1)) if passed_match else 0

                selected_match = re.search(
                    r"collected (\d+) items / (\d+) deselected / (\d+) selected",
                    result.stdout,
                )
                total_selected = int(selected_match.group(3)) if selected_match else 0

                # Fallback: if no deselected line, try "collected N items" directly
                if total_selected == 0 and pass_final > 0:
                    collected_match = re.search(r"collected (\d+) items?\b", result.stdout)
                    if collected_match:
                        total_selected = int(collected_match.group(1))
                        print(f"Fallback: used 'collected N items' → total_selected={total_selected}")

                await graph_manager.update_completed(
                    node_id=self.function_name,
                    completed=pass_final,
                    remaining=total_selected,
                )
                print(
                    f"Completed {pass_final} out of {total_selected} tests for {self.function_name}"

                )
            # test = self.parse_pytest_output(result.stdout)
            # print(test)
            # print(result.stderr)
        except Exception as e:
            print("Error running tests:", e)

    def restore_main_file(self):
        with open(self.main_copy_file, "r") as src, open(self.main_file, "w") as dest:
            dest.write(src.read())
        # print(f"Restored {self.main_file} to its original state")


socketManager = SocketManager()

templates = Jinja2Templates(directory="templates")

graph_manager = GraphManager()

editor_manager = EditorManager()

profile_manager = ProfileManager()

# --- Keyword-to-concept mapping for detecting concepts from code ---
# Maps Python keywords/patterns to the concept names used in functions.csv
KEYWORD_TO_CONCEPTS = {
    # Looping
    "while": ["Looping", "Looping (while loop)"],
    "for": ["Looping"],
    # Conditionals
    "if": ["Conditional Statement (If-else)", "Conditional (if-else)", "Conditional Statements", "Conditional", "Conditional Statement (if-else)"],
    "elif": ["Conditional Statement (If-else)", "Conditional (if-else)", "Conditional", "Conditional Statement (if-else)"],
    "else": ["Conditional Statement (If-else)", "Conditional (if-else)", "Conditional", "Conditional Statement (if-else)"],
    # Dictionary
    "dict": ["Dictionary concepts", "Dictionary Operation", "Dictionary Operations", "Dictionary Lookup", "Dictionary iteration"],
    # List
    "list": ["List Operations", "List concepts"],
    "append": ["List Operations", "List concepts"],
    "remove": ["List Operations", "List concepts"],
    "pop": ["List Operations", "List concepts"],
    # String interpolation
    ".format(": ["String Interpolation"],
    # Tuple
    "tuple": ["Tuple"],
    # Function calling
    "def": ["Function Calling"],
    # Random
    "random": ["Random num generation"],
    # Object init
    "class": ["Object initialization"],
    "__init__": ["Object initialization"],
}

# All unique concept names in our system (normalized for matching)
ALL_CONCEPTS = set()
for node in graph_manager.graph.values():
    for c in node.concepts.split(","):
        c = c.strip()
        if c:
            ALL_CONCEPTS.add(c)


def detect_concepts_from_code(code: str) -> list[str]:
    """Detect programming concepts from code using keyword matching."""
    detected = set()
    code_lower = code.lower()
    for keyword, concepts in KEYWORD_TO_CONCEPTS.items():
        # Use word boundary check for short keywords to avoid false positives
        if len(keyword) <= 3:
            # Check as a standalone token (preceded by whitespace/start, followed by whitespace/punctuation)
            if re.search(r'(?:^|[\s(.])' + re.escape(keyword) + r'(?:[\s(:"\']|$)', code_lower):
                detected.update(concepts)
        else:
            if keyword.lower() in code_lower:
                detected.update(concepts)
    # f-string detection (f"..." or f'...')
    if re.search(r'''f["']''', code):
        detected.add("String Interpolation")
    return list(detected)


def find_helper_for_concepts(requester_id: str, concepts: list[str]) -> dict | None:
    """Find ONE helper who has completed a task with matching concepts.
    Returns the best match (most overlapping concepts) or None."""
    requester_id = requester_id.replace('"', '')
    best_match = None
    best_count = 0

    for other_id, their_concepts in editor_manager.participant_concepts.items():
        if other_id.replace('"', '') == requester_id:
            continue
        matching = set(concepts) & set(their_concepts)
        if matching and len(matching) > best_count:
            best_count = len(matching)
            other_profile = profile_manager.get_profile(other_id.replace('"', ''))
            best_match = {
                "helperId": other_id.replace('"', ''),
                "helperName": other_profile.name if other_profile else other_id,
                "helperPhoto": other_profile.photo if other_profile else None,
                "concepts": list(matching),
            }

    return best_match


# Debounce tracking: last time we ran concept detection per participant
_last_concept_detect: Dict[str, float] = {}
CONCEPT_DETECT_COOLDOWN = 1.0  # seconds

msgs = []
state = ""
cursor_positions = {}
draw_states={"A": {"isDone":False}, "B": {"isDone":False}, "C": {"isDone":False}}

@app.get("/", response_class=HTMLResponse)
def get(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/dash", response_class=HTMLResponse)
def dashboard(request: Request):
    return templates.TemplateResponse(
        "dash.html", {"request": request, "connections": socketManager.connections}
    )


@app.get("/startTimer", response_class=HTMLResponse)
def start_timer(request: Request, background_tasks: BackgroundTasks):
    if socketManager.countdown_task:
        socketManager.countdown_task = False
    else:
        socketManager.countdown_task = True
    socketManager.total_seconds = 20 * 60
    background_tasks.add_task(socketManager.broadcast_countdown)

    return "ok"


@app.get("/stopTimer", response_class=HTMLResponse)
def stop_timer(request: Request):
    if socketManager.countdown_task:
        socketManager.countdown_task = False
    return "ok"


@app.post("/StartHelpSession")
async def start_help_session(body: HelpRequest):
    helper_clean = normalize_participant_id(body.helper)
    requested_helpee = normalize_participant_id(body.helpeeId or "")
    hint = body.hint
    duration_seconds = body.time * 60

    queue_target = requested_helpee
    if not queue_target and editor_manager.help_queue:
        queue_target = _queue_entry_parts(editor_manager.help_queue[0])[0]
    if not queue_target:
        return {"status": "failure", "message": "No helpee in queue"}

    queue_idx, helpee_clean, _help_type = _find_help_queue_entry(queue_target)
    if queue_idx is None or not helpee_clean:
        return {"status": "failure", "message": f"Helpee '{queue_target}' is not in queue"}

    connected_ids = {
        normalize_participant_id(conn.id)
        for conn in socketManager.connections
        if conn.id != "control"
    }
    if helpee_clean not in connected_ids or helper_clean not in connected_ids:
        return {"status": "failure", "message": "One or both users not connected"}

    # Build fine-grained help context for generation.
    pending_context = editor_manager.pending_help_context.get(helpee_clean, {})
    current_task = (
        editor_manager.profiles.get(f'"{helpee_clean}"', "")
        or editor_manager.profiles.get(helpee_clean, "")
        or ""
    )
    helpee_code = editor_manager.individual.get(helpee_clean, "")
    focus = _extract_focus_for_concept(
        current_task=current_task,
        helpee_code=helpee_code,
        concept=_select_help_concept(
            helper_id=helper_clean,
            helpee_id=helpee_clean,
            current_task=current_task,
            helpee_function_code=helpee_code,
            pending_context=pending_context,
        ),
    )
    concept = _select_help_concept(
        helper_id=helper_clean,
        helpee_id=helpee_clean,
        current_task=current_task,
        helpee_function_code=focus.get("function_code", helpee_code),
        pending_context=pending_context,
    )
    target_function_name = focus.get("function_name", "") or current_task or ""
    helper_evidence = _select_helper_evidence(
        helper_id=helper_clean,
        concept=concept,
        function_name=target_function_name,
    )
    solution_function_code = _get_solution_function_code(target_function_name)
    solution_reference = helper_evidence.get("solution_reference") or CONCEPT_REFERENCE_TEMPLATES.get(
        target_function_name, {}
    ).get(concept, {}).get("solution_snippet", "")

    session_key = _help_session_key(helper_clean, helpee_clean)
    editor_manager.active_help_context[session_key] = {
        "helperId": helper_clean,
        "helpeeId": helpee_clean,
        "functionName": target_function_name,
        "concept": concept,
        "focusLineStart": focus.get("line_start", 1),
        "focusLineEnd": focus.get("line_end", 1),
        "focusCode": focus.get("focus_code", ""),
        "helpeeFunctionCode": focus.get("function_code", ""),
        "helperEvidenceCode": helper_evidence.get("code", ""),
        "solutionFunctionCode": solution_function_code,
        "solutionReference": solution_reference,
        "hint": hint or pending_context.get("message", ""),
        "createdAt": int(_time.time()),
    }

    event = {
        "event": "StartHelpSession",
        "payload": {
            "helpee": helpee_clean,
            "helper": helper_clean,
            "time": duration_seconds,
            "hint": hint,
            "concept": concept,
            "function": target_function_name,
            "sessionKey": session_key,
        },
    }
    await socketManager.broadcast(json.dumps(event))

    # Remove the specific helpee from queue.
    editor_manager.help_queue.pop(queue_idx)
    editor_manager.pending_help_context.pop(helpee_clean, None)

    # Track the active help session.
    helper_profile = profile_manager.get_profile(helper_clean)
    helpee_profile = profile_manager.get_profile(helpee_clean)
    editor_manager.active_help_sessions.append({
        "helperId": helper_clean,
        "helperName": helper_profile.name if helper_profile else helper_clean,
        "helperPhoto": helper_profile.photo if helper_profile else None,
        "helpeeId": helpee_clean,
        "helpeeName": helpee_profile.name if helpee_profile else helpee_clean,
        "helpeePhoto": helpee_profile.photo if helpee_profile else None,
        "duration": duration_seconds,
        "startedAt": int(_time.time()),
        "sessionKey": session_key,
    })

    # Kick off guidance generation asynchronously.
    asyncio.create_task(_generate_help_guidance_for_session(helper_clean, helpee_clean))
    return {"status": "success", "sessionKey": session_key, "concept": concept}


@app.post("/notify")
async def push_notification(id: str, task: str, done: bool, test: bool):
    if test:
        editor_manager.individual["P"] = """
# Personal Playground
# Code will not be shared with others
from study_problem_classes import Menu, Order, Customer, Restaurant

def view_menu(menu: Menu):
    \"""
    Display the menu items with their cost in the following format:

    item | cost
    chicken | 12.00

    The first line is a header followed by each item and its corresponding cost on a new line.
    \"""
    for k,v in menu.dishes:
        """

        editor_manager.profiles["P"] = "create_order"
        editor_manager.message_history.append(
            {"role": "user", "content": "P working on create_order"}
        )
        editor_manager.help_queue.append(("P", "quick"))
    # else:
        # editor_manager.help_queue = []
    await editor_manager.send_notification(id, task, done)


@app.post("/testFunction")
async def testFunction(rawCode: InputBody):
    buffer = io.StringIO()
    sys.stdout = buffer
    sys.stderr = buffer
    if rawCode.channel == "all":
        replacer = FunctionReplacer("study_problem_tester.py", "study_problem_sol.py")
        replacer.replace_whole_file(rawCode.code)
        await replacer.run_tests(rawCode.channel)
        replacer.restore_main_file()

    else:
        replacer = FunctionReplacer("study_problem_tester.py", "study_problem_sol.py")
        replacer.replace_function_in_file(rawCode.code)
        await replacer.run_tests(rawCode.channel)
        editor_manager.refresh_concept_evidence(
            rawCode.channel,
            replacer.function_name,
            rawCode.code,
            source="test",
        )
        await _auto_sync_completed_function(
            rawCode.channel,
            replacer.function_name,
            rawCode.code,
        )
        replacer.restore_main_file()

    sys.stdout = sys.__stdout__
    sys.stderr = sys.__stderr__

    event = {
        "event": "run",
        "stdout": buffer.getvalue(),
        "all": rawCode.channel == "all",
    }

    if rawCode.channel == "all":
        await socketManager.broadcast(json.dumps(event))
    else:
        await socketManager.direct_message(json.dumps(event), rawCode.channel)

    # Re-broadcast graph state after test (ensures nodes update in real-time)
    await broadcast_graph_event()

    return Response(content=buffer.getvalue(), media_type="text/plain")


@app.get("/sampleCase/{function_name}")
def get_sample_case_config(function_name: str):
    if function_name not in FUNCTION_SIGNATURES:
        return {"status": "not_found"}
    return {
        "status": "ok",
        "sample": get_sample_case(function_name),
    }


@app.post("/claimFunction")
async def claim_function(body: ClaimFunctionBody):
    participant_id = normalize_participant_id(body.participantId)
    function_name = body.functionName.strip()
    claimed = graph_manager.claim_function(function_name, participant_id)
    if not claimed:
        return {"status": "error", "message": "That function is unavailable."}
    await broadcast_graph_event()
    return {"status": "ok", "functionName": function_name, "participantId": participant_id}


@app.post("/runSampleCase")
async def run_sample_case(body: SampleRunBody):
    replacer = FunctionReplacer("study_problem_tester.py", "study_problem_sol.py")
    buffer = io.StringIO()
    original_stdout = sys.stdout
    original_stderr = sys.stderr

    try:
        replacer.replace_function_in_file(body.code)
        function_name = body.functionName.strip() or replacer.function_name
        if not replacer.function_name:
            return {
                "status": "error",
                "message": "No valid function definition was found in the editor.",
            }

        testfile = importlib.reload(study_problem_tester)
        scope = {
            "__builtins__": __builtins__,
            "Menu": Menu,
            "Order": Order,
            "Customer": Customer,
            "Restaurant": Restaurant,
            "random": __import__("random"),
            "testfile": testfile,
            "study_problem_tester": testfile,
        }

        exec(body.setupCode or "", scope)

        sys.stdout = buffer
        sys.stderr = buffer
        actual_output = eval(body.callExpression, scope)
        scope["result"] = actual_output
        tracked_values = []
        for expression in body.trackedExpressions:
            expr = expression.strip()
            if not expr:
                continue
            tracked_values.append({
                "expression": expr,
                "value": _repr_value(eval(expr, scope)),
            })
    except Exception as exc:
        return {
            "status": "error",
            "functionName": body.functionName.strip() or replacer.function_name,
            "consoleOutput": buffer.getvalue(),
            "message": str(exc),
        }
    finally:
        sys.stdout = original_stdout
        sys.stderr = original_stderr
        replacer.restore_main_file()

    return {
        "status": "ok",
        "functionName": function_name,
        "consoleOutput": buffer.getvalue(),
        "actualOutput": _repr_value(actual_output),
        "trackedValues": tracked_values,
    }


@app.post("/test")
async def test(rawCode: InputBody):
    # redirect the sysout and syserr to custom buffer
    buffer = io.StringIO()
    sys.stdout = buffer
    sys.stderr = buffer

    # run the code
    # probably should implement this later: https://restrictedpython.readthedocs.io/en/latest/
    try:
        exec(rawCode.code, {"__builtins__": __builtins__})
    except Exception as err:
        print(err)

    sys.stdout = sys.__stdout__

    event = {
        "event": "run",
        "stdout": buffer.getvalue(),
        "all": rawCode.channel == "all",
    }

    if rawCode.channel == "all":
        await socketManager.broadcast(json.dumps(event))
    else:
        await socketManager.direct_message(json.dumps(event), rawCode.channel)

    return Response(content=buffer.getvalue(), media_type="text/plain")


@app.websocket("/ws/{id}")
async def websocket_text_endpoint(websocket: WebSocket, id: str):
    await socketManager.connect(websocket, id)
    global state
    try:
        while True:
            data = await websocket.receive_text()
            loaded = json.loads(data)
            if loaded["event"] == "updateMaster":
                msgs.append(loaded["payload"])
                incoming_doc = loaded["payload"].get("doc", state)
                incoming_cursor = loaded["payload"].get("cursor")
                doc_changed = incoming_doc != state
                cursor_changed = cursor_positions.get(id) != incoming_cursor

                if doc_changed:
                    state = incoming_doc
                    editor_manager.update_master(state, id)
                if cursor_changed:
                    cursor_positions[id] = incoming_cursor

                if doc_changed or cursor_changed:
                    event = {
                        "event": "document_update",
                        "payload": {
                            "doc": state,
                            "user": id,
                            "cursors": cursor_positions,
                        },
                    }
                    await socketManager.broadcast(json.dumps(event))

                work_statuses = [
                    {node: graph_manager.graph[node].work_status}
                    for node in graph_manager.graph
                ]
                event = {
                    "event": "updateGraph",
                    "payload": {
                        "graph": dict(ChainMap(*work_statuses)),
                        "participantStates": get_participant_states(),
                    },
                }
                await socketManager.broadcast(json.dumps(event))

            if loaded["event"] == "updatePlayground":
                print("updating playground", editor_manager.individual, loaded)
                code = loaded["payload"]["doc"]
                # Agent-mode helpers write to the helpee's slot by passing
                # the target userId in the payload. Fall back to the sender
                # id for normal self-edits.
                target_id = loaded["payload"].get("userId") or id
                editor_manager.update_individual(target_id, code)
                event = {
                    "event": "monitorPlayground",
                    "payload": {"editors": editor_manager.individual},
                }
                await socketManager.broadcast(json.dumps(event))

                # Detect concepts from code and push helper suggestion (debounced)
                now = _time.time()
                last = _last_concept_detect.get(id, 0)
                if now - last >= CONCEPT_DETECT_COOLDOWN:
                    _last_concept_detect[id] = now
                    detected = detect_concepts_from_code(code)
                    if detected:
                        suggestion = find_helper_for_concepts(id, detected)
                        if suggestion:
                            helper_event = {
                                "event": "helperSuggestion",
                                "payload": {
                                    "suggestion": suggestion,
                                    "detectedConcepts": detected,
                                    "anchorKeyword": None,
                                },
                            }
                            # Find the keyword that triggered this
                            for kw in KEYWORD_TO_CONCEPTS:
                                kw_lower = kw.lower()
                                if len(kw) <= 3:
                                    if re.search(r'(?:^|[\s(.])' + re.escape(kw_lower) + r'(?:[\s(:"\']|$)', code.lower()):
                                        helper_event["payload"]["anchorKeyword"] = kw
                                        break
                                elif kw_lower in code.lower():
                                    helper_event["payload"]["anchorKeyword"] = kw
                                    break
                            await socketManager.direct_message(json.dumps(helper_event), id)

            if loaded["event"] in ("typing", "stoppedTyping"):
                print(f"[typing] {loaded['event']} from {id}: {loaded.get('payload', {})}")
                await socketManager.broadcast(data)

            if loaded["event"] == "helpRequest":
                print(f"[helpRequest] from {id}: {loaded.get('payload', {})}")
                payload = loaded.get("payload", {}) or {}
                helpee_id = normalize_participant_id(payload.get("helpeeId", id))
                helpee_profile = profile_manager.get_profile(helpee_id)
                editor_manager.pending_help_context[helpee_id] = {
                    "requestedBy": helpee_id,
                    "recommendedHelperId": normalize_participant_id(payload.get("helperId", "")),
                    "concept": payload.get("concept", ""),
                    "anchorKeyword": payload.get("anchorKeyword", ""),
                    "functionName": payload.get("functionName", ""),
                    "message": payload.get("message", ""),
                    "requestedAt": int(_time.time()),
                }
                # Persist to the help queue so helpers who reconnect later (or
                # whose WS missed the broadcast) still see the request via the
                # `/helpQueue` poll. Dedup by id.
                existing_ids = {
                    normalize_participant_id(entry[0] if isinstance(entry, tuple) else entry)
                    for entry in editor_manager.help_queue
                }
                if helpee_id not in existing_ids:
                    editor_manager.help_queue.append((helpee_id, "quick"))
                help_request_event = {
                    "event": "helpRequest",
                    "payload": {
                        "helpeeId": helpee_id,
                        "helpeeName": helpee_profile.name if helpee_profile else payload.get("helpeeName", helpee_id),
                        "helpeePhoto": helpee_profile.photo if helpee_profile else payload.get("helpeePhoto"),
                        "helperId": payload.get("helperId"),
                        "concept": payload.get("concept"),
                        "anchorKeyword": payload.get("anchorKeyword"),
                        "functionName": payload.get("functionName"),
                    },
                }
                await socketManager.broadcast(json.dumps(help_request_event))

            if loaded["event"] == "updateNode":
                graph_manager.update_status(
                    node_id=loaded["payload"]["node"], id=loaded["payload"]["id"]
                )
                work_statuses = [
                    {node: graph_manager.graph[node].work_status}
                    for node in graph_manager.graph
                ]
                event = {
                    "event": "updateGraph",
                    "payload": {
                        "graph": dict(ChainMap(*work_statuses)),
                        "participantStates": get_participant_states(),
                    },
                }
                await socketManager.broadcast(json.dumps(event))

    except WebSocketDisconnect:
        socketManager.disconnect(websocket)


@app.get("/fetch")
def get_editors():
    users = [conn.id for conn in socketManager.connections if conn.id != "control"]
    event = {
        "users": set(users),
        "state": state,
        "individual": editor_manager.individual,
    }
    return event

@app.post("/DrawDone")
def draw_done(id: str, completed_time: int, remaining_time: int):
    if id in draw_states:
        draw_states[id]["isDone"] = True
        draw_states[id]["completed_time"] = completed_time
    
    
    if all([draw_states[key]["isDone"] for key in draw_states]):
        event = {
            "event": "draw",
            "payload": {"status": "done","draw_states": draw_states},
        }
        asyncio.run(socketManager.broadcast(json.dumps(event)))
    else:
        event = {
            "event": "draw",
            "payload": {"status": "not_done", "draw_states": draw_states},
        }
        asyncio.run(socketManager.broadcast(json.dumps(event)))
    return {"status": "success"}

FUNCTION_SIGNATURES = {
    "view_menu": "view_menu(menu)",
    "create_order": "create_order(customer)",
    "clear_order": "clear_order(customer, order_id)",
    "view_order_summary": "view_order_summary(order, menu)",
    "add_to_order": "add_to_order(customer, order_id, menu, item)",
    "remove_from_order": "remove_from_order(customer, order_id, menu, item)",
    "calculate_order_cost": "calculate_order_cost(order, menu)",
    "get_receipt": "get_receipt(customer, menu)",
    "add_to_queue": "add_to_queue(restaurant, customer)",
    "cook_order": "cook_order(restaurant)",
    "restock_inventory": "restock_inventory(restaurant, item, quantity)",
    "cook_time_helper": "cook_time_helper(restaurant, item)",
    "inventory_helper": "inventory_helper(restaurant, item)",
    "average_cook_time": "average_cook_time(restaurant)",
}


SAMPLE_CASES = {
    "view_menu": {
        "label": "Preview a regular menu",
        "setupCode": "menu = Menu()",
        "callExpression": "testfile.view_menu(menu)",
        "trackedExpressions": [],
        "exampleInput": "menu = Menu()\nview_menu(menu)",
        "exampleOutput": "None",
        "examplePrint": "item | cost\nchicken | 12.0\npork | 10.0\nvegetables | 9.0\nrice | 12.0",
    },
    "create_order": {
        "label": "Create a new order id",
        "setupCode": (
            "customer = Customer('amy')\n"
            "customer.order[1234] = Order(1234)\n"
            "testfile.random.randint = lambda _a, _b: 5678"
        ),
        "callExpression": "testfile.create_order(customer)",
        "trackedExpressions": [
            "list(customer.order.keys())",
            "customer.order[5678].items",
            "customer.order[5678].cost",
        ],
        "exampleInput": (
            "customer = Customer('amy')\n"
            "customer.order[1234] = Order(1234)\n"
            "create_order(customer)"
        ),
        "exampleOutput": "5678",
        "examplePrint": "None",
    },
    "clear_order": {
        "label": "Clear an existing order",
        "setupCode": (
            "customer = Customer('amy')\n"
            "customer.order[1234] = Order(1234, ['chicken', 'rice'], 17.0)"
        ),
        "callExpression": "testfile.clear_order(customer, 1234)",
        "trackedExpressions": [
            "customer.order[1234].items",
            "customer.order[1234].cost",
        ],
        "exampleInput": (
            "customer = Customer('amy')\n"
            "customer.order[1234] = Order(1234, ['chicken', 'rice'], 17.0)\n"
            "clear_order(customer, 1234)"
        ),
        "exampleOutput": "None",
        "examplePrint": "Order cleared.",
    },
    "view_order_summary": {
        "label": "Print a short order summary",
        "setupCode": (
            "menu = Menu()\n"
            "order = Order('Bobby', ['chicken', 'vegetables'], 21)"
        ),
        "callExpression": "testfile.view_order_summary(order, menu)",
        "trackedExpressions": [],
        "exampleInput": (
            "menu = Menu()\n"
            "order = Order('Bobby', ['chicken', 'vegetables'], 21)\n"
            "view_order_summary(order, menu)"
        ),
        "exampleOutput": "None",
        "examplePrint": "Order Summary:\nchicken - $12.00\nvegetables - $9.00\nTotal: $21.00",
    },
    "add_to_order": {
        "label": "Add one valid menu item",
        "setupCode": (
            "customer = Customer('amy')\n"
            "customer.order[1234] = Order(1234)\n"
            "menu = Menu()"
        ),
        "callExpression": "testfile.add_to_order(customer, 1234, menu, 'chicken')",
        "trackedExpressions": [
            "customer.order[1234].items",
            "customer.order[1234].cost",
        ],
        "exampleInput": (
            "customer = Customer('amy')\n"
            "customer.order[1234] = Order(1234)\n"
            "menu = Menu()\n"
            "add_to_order(customer, 1234, menu, 'chicken')"
        ),
        "exampleOutput": "'chicken'",
        "examplePrint": "Added chicken: 12.0",
    },
    "remove_from_order": {
        "label": "Remove an ordered item",
        "setupCode": (
            "customer = Customer('bob')\n"
            "customer.order[1234] = Order(1234, ['chicken', 'rice'], 24.0)\n"
            "menu = Menu()"
        ),
        "callExpression": "testfile.remove_from_order(customer, 1234, menu, 'chicken')",
        "trackedExpressions": [
            "customer.order[1234].items",
            "customer.order[1234].cost",
        ],
        "exampleInput": (
            "customer = Customer('bob')\n"
            "customer.order[1234] = Order(1234, ['chicken', 'rice'], 24.0)\n"
            "menu = Menu()\n"
            "remove_from_order(customer, 1234, menu, 'chicken')"
        ),
        "exampleOutput": "True",
        "examplePrint": "Removed chicken",
    },
    "calculate_order_cost": {
        "label": "Calculate a two-item total",
        "setupCode": (
            "menu = Menu()\n"
            "order = Order(1234, ['chicken', 'rice'], 0)"
        ),
        "callExpression": "testfile.calculate_order_cost(order, menu)",
        "trackedExpressions": [],
        "exampleInput": (
            "menu = Menu()\n"
            "order = Order(1234, ['chicken', 'rice'], 0)\n"
            "calculate_order_cost(order, menu)"
        ),
        "exampleOutput": "24.0",
        "examplePrint": "None",
    },
    "get_receipt": {
        "label": "Print a receipt for two orders",
        "setupCode": (
            "menu = Menu()\n"
            "customer = Customer('bob')\n"
            "customer.order[1234] = Order(1234, ['chicken', 'rice'], 24.0)\n"
            "customer.order[5678] = Order(5678, ['rice'], 12.0)"
        ),
        "callExpression": "testfile.get_receipt(customer, menu)",
        "trackedExpressions": [],
        "exampleInput": (
            "menu = Menu()\n"
            "customer = Customer('bob')\n"
            "customer.order[1234] = Order(1234, ['chicken', 'rice'], 24.0)\n"
            "customer.order[5678] = Order(5678, ['rice'], 12.0)\n"
            "get_receipt(customer, menu)"
        ),
        "exampleOutput": "None",
        "examplePrint": (
            "bob\n-----\n1234\nOrder Summary:\nchicken - $12.00\nrice - $12.00\n"
            "Total: $24.00\n-----\n5678\nOrder Summary:\nrice - $12.00\nTotal: $12.00\n-----\n$36.00"
        ),
    },
    "add_to_queue": {
        "label": "Queue a customer's orders",
        "setupCode": (
            "restaurant = Restaurant()\n"
            "customer = Customer('bob')\n"
            "customer.order[1234] = Order(1234, ['chicken', 'rice'], 24.0)\n"
            "customer.order[5678] = Order(5678, ['rice'], 12.0)"
        ),
        "callExpression": "testfile.add_to_queue(restaurant, customer)",
        "trackedExpressions": [
            "[order.id for order in restaurant.order_queue]",
        ],
        "exampleInput": (
            "restaurant = Restaurant()\n"
            "customer = Customer('bob')\n"
            "customer.order[1234] = Order(1234, ['chicken', 'rice'], 24.0)\n"
            "customer.order[5678] = Order(5678, ['rice'], 12.0)\n"
            "add_to_queue(restaurant, customer)"
        ),
        "exampleOutput": "None",
        "examplePrint": "None",
    },
    "cook_order": {
        "label": "Cook the first queued order",
        "setupCode": (
            "restaurant = Restaurant()\n"
            "restaurant.cook_time_in_minutes = {'chicken': 3, 'rice': 2, 'vegetables': 1}\n"
            "restaurant.inventory = {'chicken': 1, 'rice': 1, 'vegetables': 1}\n"
            "customer = Customer('bob')\n"
            "customer.order[1234] = Order(1234, ['chicken', 'rice'], 24.0)\n"
            "customer.order[5678] = Order(5678, ['rice'], 12.0)\n"
            "testfile.add_to_queue(restaurant, customer)"
        ),
        "callExpression": "testfile.cook_order(restaurant)",
        "trackedExpressions": [
            "[order.id for order in restaurant.order_queue]",
            "restaurant.inventory",
        ],
        "exampleInput": (
            "restaurant = Restaurant()\n"
            "restaurant.cook_time_in_minutes = {'chicken': 3, 'rice': 2, 'vegetables': 1}\n"
            "restaurant.inventory = {'chicken': 1, 'rice': 1, 'vegetables': 1}\n"
            "customer = Customer('bob')\n"
            "customer.order[1234] = Order(1234, ['chicken', 'rice'], 24.0)\n"
            "customer.order[5678] = Order(5678, ['rice'], 12.0)\n"
            "add_to_queue(restaurant, customer)\n"
            "cook_order(restaurant)"
        ),
        "exampleOutput": "(5678, 2)",
        "examplePrint": "None",
    },
    "restock_inventory": {
        "label": "Restock a known item",
        "setupCode": (
            "restaurant = Restaurant()\n"
            "restaurant.inventory = {'chicken': 1, 'rice': 1, 'vegetables': 1}"
        ),
        "callExpression": "testfile.restock_inventory(restaurant, 'chicken', 2)",
        "trackedExpressions": [
            "restaurant.inventory['chicken']",
        ],
        "exampleInput": (
            "restaurant = Restaurant()\n"
            "restaurant.inventory = {'chicken': 1, 'rice': 1, 'vegetables': 1}\n"
            "restock_inventory(restaurant, 'chicken', 2)"
        ),
        "exampleOutput": "None",
        "examplePrint": "Restocked chicken. New quantity: 3",
    },
    "cook_time_helper": {
        "label": "Look up one cook time",
        "setupCode": (
            "restaurant = Restaurant()\n"
            "restaurant.cook_time_in_minutes = {'chicken': 3, 'rice': 2, 'vegetables': 1}"
        ),
        "callExpression": "testfile.cook_time_helper(restaurant, 'chicken')",
        "trackedExpressions": [],
        "exampleInput": (
            "restaurant = Restaurant()\n"
            "restaurant.cook_time_in_minutes = {'chicken': 3, 'rice': 2, 'vegetables': 1}\n"
            "cook_time_helper(restaurant, 'chicken')"
        ),
        "exampleOutput": "3",
        "examplePrint": "None",
    },
    "inventory_helper": {
        "label": "Use one inventory item",
        "setupCode": (
            "restaurant = Restaurant()\n"
            "restaurant.inventory = {'chicken': 1, 'rice': 1, 'vegetables': 1}"
        ),
        "callExpression": "testfile.inventory_helper(restaurant, 'rice')",
        "trackedExpressions": [
            "restaurant.inventory['rice']",
        ],
        "exampleInput": (
            "restaurant = Restaurant()\n"
            "restaurant.inventory = {'chicken': 1, 'rice': 1, 'vegetables': 1}\n"
            "inventory_helper(restaurant, 'rice')"
        ),
        "exampleOutput": "True",
        "examplePrint": "None",
    },
    "average_cook_time": {
        "label": "Average a populated queue",
        "setupCode": (
            "restaurant = Restaurant()\n"
            "restaurant.cook_time_in_minutes = {'chicken': 3, 'rice': 2, 'vegetables': 1}\n"
            "customer = Customer('bob')\n"
            "customer.order[1234] = Order(1234, ['chicken', 'rice'], 24.0)\n"
            "customer.order[5678] = Order(5678, ['rice'], 12.0)\n"
            "testfile.add_to_queue(restaurant, customer)"
        ),
        "callExpression": "testfile.average_cook_time(restaurant)",
        "trackedExpressions": [
            "[order.id for order in restaurant.order_queue]",
        ],
        "exampleInput": (
            "restaurant = Restaurant()\n"
            "restaurant.cook_time_in_minutes = {'chicken': 3, 'rice': 2, 'vegetables': 1}\n"
            "customer = Customer('bob')\n"
            "customer.order[1234] = Order(1234, ['chicken', 'rice'], 24.0)\n"
            "customer.order[5678] = Order(5678, ['rice'], 12.0)\n"
            "add_to_queue(restaurant, customer)\n"
            "average_cook_time(restaurant)"
        ),
        "exampleOutput": "3.5",
        "examplePrint": "Average cooking time: 3.50 minutes.",
    },
}


def get_sample_case(function_name: str) -> dict:
    sample = SAMPLE_CASES.get(function_name, {})
    return {
        "functionName": function_name,
        "label": sample.get("label", "Try this function with editable input"),
        "setupCode": sample.get("setupCode", ""),
        "callExpression": sample.get("callExpression", f"testfile.{function_name}()"),
        "trackedExpressions": sample.get("trackedExpressions", []),
        "exampleInput": sample.get("exampleInput", ""),
        "exampleOutput": sample.get("exampleOutput", ""),
        "examplePrint": sample.get("examplePrint", "None"),
    }


def _repr_value(value: Any) -> str:
    return repr(value)


def _get_signature_params(function_name: str) -> List[str]:
    signature = FUNCTION_SIGNATURES.get(function_name, "")
    if "(" not in signature or ")" not in signature:
        return []
    params = signature.split("(", 1)[1].rsplit(")", 1)[0]
    return [param.strip() for param in params.split(",") if param.strip()]


def _indent_block(text: str, indent: str = "        ") -> str:
    lines = text.splitlines() or [text]
    return "\n".join(f"{indent}{line}" if line else indent.rstrip() for line in lines)


def build_starter_code(function_name: str, graph_node: GraphNode) -> str:
    signature = FUNCTION_SIGNATURES.get(function_name, f"{function_name}()")
    sample = get_sample_case(function_name)
    example_input = sample.get("exampleInput", graph_node.example_input or signature)
    example_output = sample.get("exampleOutput", graph_node.example_output or "None")
    example_print = sample.get("examplePrint", "None")
    params = _get_signature_params(function_name)

    doc_lines = [
        '    """',
        f"    {graph_node.desc}",
        "",
        "    Example:",
        "        Input:",
        _indent_block(example_input, "            "),
        "",
        "        Returns:",
        _indent_block(example_output, "            "),
        "",
        "        Prints:",
        _indent_block(example_print, "            "),
    ]

    if params:
        doc_lines.extend([
            "",
            "    Args:",
            *[f"        {param}" for param in params],
        ])

    doc_lines.extend([
        '    """',
        "    pass",
    ])
    return f"def {signature}:\n" + "\n".join(doc_lines) + "\n"


@app.get("/task/{node}")
def get_task_details(node):
    """Return structured task data (description, concepts, examples, starter code) as JSON."""
    if node not in graph_manager.graph:
        return {"status": "not_found"}
    g = graph_manager.graph[node]
    sample = get_sample_case(node)
    starter = build_starter_code(node, g)
    return {
        "status": "ok",
        "name": node,
        "description": g.desc,
        "concepts": g.concepts,
        "example_input": sample.get("exampleInput", g.example_input),
        "example_output": sample.get("exampleOutput", g.example_output),
        "example_print": sample.get("examplePrint", "None"),
        "starter_code": starter,
    }


@app.get("/concept-map")
def get_concept_map():
    return {
        "status": "ok",
        "functions": [
            {
                "name": node.name,
                "description": node.desc,
                "concepts": [
                    {
                        "name": concept,
                        "solution_reference": CONCEPT_REFERENCE_TEMPLATES.get(node.name, {}).get(concept, {}).get("solution_snippet", ""),
                    }
                    for concept in [c.strip() for c in node.concepts.split(",") if c.strip()]
                ],
            }
            for node in graph_manager.graph.values()
        ],
    }


@app.get("/team-editor-code")
def get_team_editor_code():
    return {
        "status": "ok",
        "code": editor_manager.master or state,
    }


@app.post("/concept-evidence/update")
def update_concept_evidence(body: dict):
    participant_id = body.get("participantId", "")
    concept = body.get("concept", "")
    function_name = body.get("function", "")
    line_start = int(body.get("lineStart", 1))
    line_end = int(body.get("lineEnd", line_start))
    source = body.get("source", "team")

    if source != "team":
        return {"status": "error", "message": "Only live Team Editor manual updates are supported."}

    code = editor_manager.master or state
    if not participant_id or not concept or not function_name or not code:
        return {"status": "error", "message": "Missing required fields or Team Editor code is empty."}

    updated_entry = editor_manager.update_concept_evidence_manual(
        participant_id=participant_id,
        concept=concept,
        function_name=function_name,
        line_start=line_start,
        line_end=line_end,
        code=code,
    )
    return {"status": "ok", "entry": updated_entry}


@app.get("/study-problem-template")
def get_study_problem_template():
    with open("study_problem_blank.py", "r") as file:
        starter_code = file.read()
    return {"status": "ok", "starter_code": starter_code}


@app.get("/lookup/{node}")
def lookup_description(node):
    if node in graph_manager.graph:
        looked_up = graph_manager.graph[node]
        html_str = f"<p>{looked_up.desc}</p><i>{looked_up.concepts}</i>"
        if looked_up.example_input or looked_up.example_output:
            html_str += "<hr style='margin:6px 0;border-color:#555;'/>"
        if looked_up.example_input:
            html_str += f"<p style='margin:2px 0;'><b>Example input:</b><br><code style='font-size:11px;'>{looked_up.example_input}</code></p>"
        if looked_up.example_output:
            output_formatted = looked_up.example_output.replace("\n", "<br>")
            html_str += f"<p style='margin:2px 0;'><b>Example output:</b><br><code style='font-size:11px;'>{output_formatted}</code></p>"
        if looked_up.claimed_by != "":
            # Get profile from backend and show avatar
            profile = profile_manager.get_profile(looked_up.claimed_by)
            if profile:
                html_str += f'''<p>Claimed by <b>
                    <span style="display:inline-flex;align-items:center;gap:6px;">
                        <img src="{profile.photo}" alt="{profile.name}" 
                             style="width:20px;height:20px;border-radius:50%;object-fit:cover;border:2px solid #ddd;vertical-align:middle;">
                        <span>{profile.name}</span>
                    </span>
                </b></p>'''
            else:
                html_str += f"<p>Claimed by <b>{looked_up.claimed_by}</b></p>"
        if looked_up.total != 0:
            html_str += (
                f"<p>Progress: <b>{looked_up.completed}/{looked_up.total}</b></p>"
            )

        return {"html": html_str}
    return {"html": ""}


@app.post("/profile")
async def save_profile(profile: ParticipantProfile):
    """Save participant profile to backend"""
    profile_manager.save_profile(profile)

    # Broadcast so already-connected clients can add the new participant's tab
    # without needing a reload.
    pid_broadcast = profile.id.replace('"', '')
    await socketManager.broadcast(json.dumps({
        "event": "profileUpdate",
        "payload": {
            "id": pid_broadcast,
            "name": profile.name,
            "photo": profile.photo,
        },
    }))

    work_statuses = [
        {node_name: graph_manager.graph[node_name].work_status}
        for node_name in graph_manager.graph
    ]
    event = {
        "event": "updateGraph",
        "payload": {
            "graph": dict(ChainMap(*work_statuses)),
            "participantStates": get_participant_states(),
        },
    }
    await socketManager.broadcast(json.dumps(event))
    return {"status": "success", "profile": profile}


@app.get("/profile/{participant_id}")
def get_profile(participant_id: str):
    """Get participant profile from backend"""
    profile = profile_manager.get_profile(participant_id)
    if profile:
        return {"status": "success", "profile": profile}
    return {"status": "not_found", "profile": None}


@app.get("/helperSuggestions/{participant_id}")
def get_helper_suggestions(participant_id: str):
    """Return inline helper suggestions: who can help with what concept for the current user's task."""
    participant_id = participant_id.replace('"', '')

    # Find what function this participant is currently working on
    current_task = editor_manager.profiles.get(f'"{participant_id}"', '') or editor_manager.profiles.get(participant_id, '')
    if not current_task:
        return {"suggestions": []}

    # Get concepts for the current task
    task_concepts = []
    if current_task in graph_manager.graph:
        task_concepts = [c.strip() for c in graph_manager.graph[current_task].concepts.split(",") if c.strip()]

    if not task_concepts:
        return {"suggestions": []}

    # Find other participants who have completed functions with matching concepts
    suggestions = []
    for other_id, their_concepts in editor_manager.participant_concepts.items():
        if other_id.replace('"', '') == participant_id:
            continue
        matching = set(task_concepts) & set(their_concepts)
        if matching:
            other_profile = profile_manager.get_profile(other_id.replace('"', ''))
            suggestions.append({
                "helperId": other_id.replace('"', ''),
                "helperName": other_profile.name if other_profile else other_id,
                "helperPhoto": other_profile.photo if other_profile else None,
                "concepts": list(matching),
            })

    return {"suggestions": suggestions, "currentTask": current_task, "taskConcepts": task_concepts}


def _ai_detect_concepts(code: str) -> list[str]:
    """Synchronous AI concept detection — run via asyncio.to_thread to avoid blocking."""
    concept_list = ", ".join(ALL_CONCEPTS)
    prompt = (
        f"Given this Python code snippet, identify which programming concepts from this list are being used: [{concept_list}]. "
        f"Return ONLY a JSON array of matching concept names, nothing else.\n\nCode:\n```\n{code}\n```"
    )
    response = editor_manager.client.chat.completions.create(
        model="google/gemini-2.0-flash-001",
        messages=[{"role": "user", "content": prompt}],
    )
    ai_text = response.choices[0].message.content.strip()
    if "```" in ai_text:
        ai_text = ai_text.split("```json")[-1] if "```json" in ai_text else ai_text.split("```")[1]
        ai_text = ai_text.split("```")[0].strip()
    if ai_text.startswith("["):
        ai_concepts = json.loads(ai_text)
        return [c for c in ai_concepts if c in ALL_CONCEPTS]
    return []


@app.post("/detectHelper")
async def detect_helper_from_code(body: dict):
    """Detect concepts from code and find ONE helper who can assist.
    POST { "participant_id": "A", "code": "while x > 0:\\n    ..." }

    1. Keyword scan the code for known concept patterns
    2. If no keyword match, use AI to detect concepts
    3. Find the best single helper who has completed matching concepts
    """
    participant_id = body.get("participant_id", "").replace('"', '')
    code = body.get("code", "")

    if not code or not participant_id:
        return {"suggestion": None, "detectedConcepts": []}

    # Step 1: keyword-based concept detection
    detected = detect_concepts_from_code(code)

    # Step 2: if no keywords matched, try AI detection (non-blocking)
    if not detected and len(code.strip()) > 20:
        try:
            detected = await asyncio.to_thread(_ai_detect_concepts, code)
        except Exception as e:
            print(f"[detectHelper] AI concept detection failed: {e}")

    if not detected:
        return {"suggestion": None, "detectedConcepts": []}

    # Step 3: find ONE helper
    suggestion = find_helper_for_concepts(participant_id, detected)

    return {
        "suggestion": suggestion,
        "detectedConcepts": detected,
    }


def _help_session_key(helper_id: str, helpee_id: str) -> str:
    helper_clean = normalize_participant_id(helper_id)
    helpee_clean = normalize_participant_id(helpee_id)
    return f"{helper_clean}::{helpee_clean}"


def _queue_entry_parts(entry: Any) -> tuple[str, str]:
    if isinstance(entry, tuple):
        return normalize_participant_id(entry[0]), entry[1]
    return normalize_participant_id(entry), "quick"


def _find_help_queue_entry(helpee_id: str) -> tuple[Optional[int], Optional[str], Optional[str]]:
    helpee_clean = normalize_participant_id(helpee_id)
    for idx, entry in enumerate(editor_manager.help_queue):
        entry_id, help_type = _queue_entry_parts(entry)
        if entry_id == helpee_clean:
            return idx, entry_id, help_type
    return None, None, None


def _select_help_concept(
    helper_id: str,
    helpee_id: str,
    current_task: str,
    helpee_function_code: str,
    pending_context: Dict[str, Any],
) -> str:
    helper_known = set(editor_manager.participant_concepts.get(helper_id, []))
    requested = (pending_context.get("concept") or "").strip()
    if requested and (not helper_known or requested in helper_known):
        return requested

    task_concepts = []
    if current_task in graph_manager.graph:
        task_concepts = [c.strip() for c in graph_manager.graph[current_task].concepts.split(",") if c.strip()]

    overlap = [c for c in task_concepts if c in helper_known] if helper_known else task_concepts
    if overlap:
        return overlap[0]

    detected = detect_concepts_from_code(helpee_function_code)
    for concept in detected:
        if not helper_known or concept in helper_known:
            return concept

    return requested or (task_concepts[0] if task_concepts else "Looping")


def _extract_focus_for_concept(current_task: str, helpee_code: str, concept: str) -> Dict[str, Any]:
    function_map = parse_top_level_functions(helpee_code)
    function_name = current_task if current_task in function_map else ""
    if not function_name and function_map:
        function_name = next(iter(function_map.keys()))
    function_code = function_map.get(function_name, helpee_code).strip()

    inferred = infer_concept_reference(function_name, concept, function_code) if function_name else {
        "line_start": 1,
        "line_end": len(function_code.splitlines()) if function_code else 1,
        "code": function_code,
        "solution_reference": "",
    }
    return {
        "function_name": function_name,
        "function_code": function_code,
        "line_start": inferred.get("line_start", 1),
        "line_end": inferred.get("line_end", 1),
        "focus_code": inferred.get("code", function_code),
    }


def _select_helper_evidence(helper_id: str, concept: str, function_name: str) -> Dict[str, Any]:
    store = editor_manager.participant_concept_evidence.get(helper_id, {})
    entries = store.get(concept, [])
    if not entries:
        return {
            "function": function_name,
            "code": "",
            "line_start": 1,
            "line_end": 1,
            "solution_reference": CONCEPT_REFERENCE_TEMPLATES.get(function_name, {}).get(concept, {}).get("solution_snippet", ""),
        }

    same_fn = [entry for entry in entries if entry.get("function") == function_name]
    selected = same_fn[0] if same_fn else entries[0]
    return {
        "function": selected.get("function", function_name),
        "code": selected.get("code", ""),
        "line_start": selected.get("line_start", 1),
        "line_end": selected.get("line_end", 1),
        "solution_reference": selected.get("solution_reference", ""),
    }


def _extract_first_json_obj(text: str) -> Dict[str, Any]:
    if not text:
        return {}
    block_match = re.search(r"```json\s*(\{[\s\S]*?\})\s*```", text)
    if block_match:
        try:
            return json.loads(block_match.group(1))
        except json.JSONDecodeError:
            pass

    object_match = re.search(r"(\{[\s\S]*\})", text)
    if object_match:
        try:
            return json.loads(object_match.group(1))
        except json.JSONDecodeError:
            return {}
    return {}


def _ai_generate_help_guidance_sync(payload: Dict[str, Any]) -> Dict[str, Any]:
    concept = payload["concept"]
    function_name = payload["function_name"]
    helpee_function_code = payload["helpee_function_code"]
    focus_line_start = payload["focus_line_start"]
    focus_line_end = payload["focus_line_end"]
    solution_function_code = (
        payload.get("solution_function_code")
        or _get_solution_function_code(function_name)
        or ""
    ).strip()

    corrected_code = solution_function_code
    if not corrected_code:
        return {
            "corrected_code": "",
            "focus_explanation": f"Reference solution for `{function_name}` was not found in study_problem_sol.py.",
            "helper_message": "Reference solution unavailable for this function.",
            "changed_lines": [],
            "changed_line_ranges": [],
        }

    changed_lines = [f"Review {concept} around lines {focus_line_start}-{focus_line_end}."]
    normalized_ranges: List[Dict[str, int]] = []

    if not normalized_ranges:
        old_lines = helpee_function_code.splitlines()
        new_lines = corrected_code.splitlines()
        matcher = difflib.SequenceMatcher(a=old_lines, b=new_lines)
        for tag, _i1, _i2, j1, j2 in matcher.get_opcodes():
            if tag == "equal":
                continue
            if tag in ("replace", "insert") and j2 > j1:
                normalized_ranges.append({"start": j1 + 1, "end": j2})
            elif tag == "delete":
                fallback_start = min(j1 + 1, len(new_lines)) if len(new_lines) > 0 else 1
                normalized_ranges.append({"start": fallback_start, "end": fallback_start})

    if not normalized_ranges:
        normalized_ranges = [{"start": 1, "end": max(1, len(corrected_code.splitlines()))}]

    return {
        "corrected_code": corrected_code,
        "focus_explanation": f"Full reference solution for `{function_name}` is shown below with highlight on lines that differ.",
        "helper_message": "Walk the helpee through only the highlighted diffs.",
        "changed_lines": changed_lines,
        "changed_line_ranges": normalized_ranges,
    }


async def _generate_help_guidance_for_session(helper_id: str, helpee_id: str):
    helper_clean = normalize_participant_id(helper_id)
    helpee_clean = normalize_participant_id(helpee_id)
    key = _help_session_key(helper_clean, helpee_clean)
    session = editor_manager.active_help_context.get(key, {})
    if not session:
        print(f"[help-guidance] no session context for key={key}")
        return
    print(
        f"[help-guidance] generating key={key} concept={session.get('concept','')} function={session.get('functionName','')}"
    )

    await socketManager.direct_message(
        json.dumps({
            "event": "helpGuidanceGenerating",
            "payload": {
                "helperId": helper_clean,
                "helpeeId": helpee_clean,
                "concept": session.get("concept", ""),
                "function": session.get("functionName", ""),
            },
        }),
        helper_clean,
    )

    await socketManager.direct_message(
        json.dumps({
            "event": "helpAccepted",
            "payload": {
                "helperId": helper_clean,
                "helpeeId": helpee_clean,
                "concept": session.get("concept", ""),
            },
        }),
        helpee_clean,
    )

    guidance = await asyncio.to_thread(
        _ai_generate_help_guidance_sync,
        {
            "helper_id": helper_clean,
            "helpee_id": helpee_clean,
            "concept": session.get("concept", ""),
            "function_name": session.get("functionName", ""),
            "helpee_function_code": session.get("helpeeFunctionCode", ""),
            "focus_code": session.get("focusCode", ""),
            "focus_line_start": session.get("focusLineStart", 1),
            "focus_line_end": session.get("focusLineEnd", 1),
            "helper_evidence": session.get("helperEvidenceCode", ""),
            "solution_function_code": session.get("solutionFunctionCode", ""),
            "solution_reference": session.get("solutionReference", ""),
        },
    )

    session["guidance"] = guidance
    editor_manager.generated_help_drafts[key] = guidance

    ready_event = json.dumps({
        "event": "helpGuidanceReady",
        "payload": {
            "helperId": helper_clean,
            "helpeeId": helpee_clean,
            "function": session.get("functionName", ""),
            "concept": session.get("concept", ""),
            "focusLineStart": session.get("focusLineStart", 1),
            "focusLineEnd": session.get("focusLineEnd", 1),
            "focusCode": session.get("focusCode", ""),
            "helperEvidenceCode": session.get("helperEvidenceCode", ""),
            "solutionFunctionCode": session.get("solutionFunctionCode", ""),
            "solutionReference": session.get("solutionReference", ""),
            "correctedCode": guidance.get("corrected_code", ""),
            "focusExplanation": guidance.get("focus_explanation", ""),
            "helperMessage": guidance.get("helper_message", ""),
            "changedLines": guidance.get("changed_lines", []),
            "changedLineRanges": guidance.get("changed_line_ranges", []),
        },
    })
    await socketManager.direct_message(ready_event, helper_clean)
    await socketManager.direct_message(ready_event, helpee_clean)
    print(f"[help-guidance] ready key={key}")


@app.post("/helpQueue/dismiss/{helpee_id}")
async def dismiss_help_request(helpee_id: str):
    """Remove a helpee from the help queue (called when any helper clicks
    their 'X needs help' pill). Broadcasts so every connected client clears
    the pill immediately, not just on the next poll."""
    helpee_clean = normalize_participant_id(helpee_id)
    editor_manager.help_queue = [
        entry for entry in editor_manager.help_queue
        if (entry[0] if isinstance(entry, tuple) else entry) != helpee_clean
    ]
    editor_manager.pending_help_context.pop(helpee_clean, None)
    await socketManager.broadcast(json.dumps({
        "event": "helpRequestDismissed",
        "payload": {"helpeeId": helpee_clean},
    }))
    return {"status": "success", "helpeeId": helpee_clean}


@app.get("/helpQueue")
def get_help_queue():
    """Return the current help queue with enriched participant data."""
    queue_items = []
    for entry in editor_manager.help_queue:
        # help_queue entries can be (id, helpType) tuples or bare id strings
        if isinstance(entry, tuple):
            pid, help_type = entry[0], entry[1]
        else:
            pid, help_type = entry, "quick"
        pid_clean = pid.replace('"', '')
        profile = profile_manager.get_profile(pid_clean)
        # Find what task this participant is working on
        current_task = (
            editor_manager.profiles.get(f'"{pid_clean}"', '')
            or editor_manager.profiles.get(pid_clean, '')
        )
        task_concepts = []
        if current_task and current_task in graph_manager.graph:
            task_concepts = [
                c.strip()
                for c in graph_manager.graph[current_task].concepts.split(",")
                if c.strip()
            ]
        pending = editor_manager.pending_help_context.get(pid_clean, {})
        queue_items.append({
            "id": pid_clean,
            "name": profile.name if profile else pid_clean,
            "photo": profile.photo if profile else None,
            "helpType": help_type,
            "currentTask": current_task or None,
            "taskConcepts": task_concepts,
            "requestedConcept": pending.get("concept", ""),
            "recommendedHelperId": pending.get("recommendedHelperId", ""),
            "anchorKeyword": pending.get("anchorKeyword", ""),
        })

    # Also return all connected participant IDs (excluding control)
    connected = [
        conn.id.replace('"', '')
        for conn in socketManager.connections
        if conn.id != "control"
    ]

    # Clean up expired sessions (older than duration + 30s buffer)
    now = int(_time.time())
    editor_manager.active_help_sessions = [
        s for s in editor_manager.active_help_sessions
        if now - s["startedAt"] < s["duration"] + 30
    ]

    return {
        "queue": queue_items,
        "connectedParticipants": connected,
        "activeSessions": editor_manager.active_help_sessions,
    }


@app.post("/help/share")
async def share_help_to_helpee(body: HelpShareBody):
    helper_id = normalize_participant_id(body.helperId)
    helpee_id = normalize_participant_id(body.helpeeId)
    shared_code = body.code
    function_name = (body.functionName or "").strip()
    concept = (body.concept or "").strip()
    line_start = body.lineStart
    line_end = body.lineEnd
    comment = (body.comment or "").strip()

    if not helper_id or not helpee_id or not shared_code.strip():
        return {"status": "error", "message": "Missing helperId, helpeeId, or code."}

    session_key = _help_session_key(helper_id, helpee_id)
    session = editor_manager.active_help_context.get(session_key)
    if not session:
        return {"status": "error", "message": "No active help context for this helper/helpee pair."}

    resolved_share = _extract_function_for_share(function_name, shared_code)
    if not resolved_share:
        return {"status": "error", "message": "Shared code must include a valid top-level function."}
    resolved_name, resolved_function_code = resolved_share

    expected_function = session.get("functionName", "")
    if expected_function and resolved_name != expected_function:
        return {
            "status": "error",
            "message": f"Share target mismatch. Expected '{expected_function}' but received '{resolved_name}'.",
        }

    helpee_current_code = editor_manager.individual.get(helpee_id, "")
    helpee_function_map = parse_top_level_functions(helpee_current_code)
    base_function_code = (
        helpee_function_map.get(resolved_name)
        or session.get("helpeeFunctionCode", "")
        or resolved_function_code
    )
    group = _ensure_help_variant_group(
        helper_id=helper_id,
        helpee_id=helpee_id,
        function_name=resolved_name,
        concept=concept or session.get("concept", ""),
        focus_code=session.get("focusCode", ""),
        focus_line_start=session.get("focusLineStart", 1),
        focus_line_end=session.get("focusLineEnd", 1),
        base_function_code=base_function_code,
        session_key=session_key,
    )
    variant = _make_variant_entry(
        group=group,
        author_id=helper_id,
        kind="helper_share",
        code=resolved_function_code,
    )
    group["variants"].append(variant)

    if comment:
        group["comments"].append(_make_comment_entry(
            author_id=helper_id,
            variant_id=variant["variantId"],
            body=comment,
            concept=concept or group.get("concept", ""),
            line_start=line_start,
            line_end=line_end,
        ))

    await _broadcast_help_variant_group(
        group,
        "helpVariantShared",
        {
            "helperId": helper_id,
            "helpeeId": helpee_id,
            "functionName": resolved_name,
            "variant": variant,
        },
    )
    await socketManager.direct_message(json.dumps({
        "event": "helpDraftShared",
        "payload": {
            "helperId": helper_id,
            "helpeeId": helpee_id,
            "functionName": resolved_name,
            "variantId": variant["variantId"],
        },
    }), helpee_id)
    return {"status": "success", "sessionKey": session_key, "functionName": resolved_name, "variantId": variant["variantId"]}


@app.post("/help/variant/manual")
async def create_manual_help_variant(body: HelpManualVariantBody):
    participant_id = normalize_participant_id(body.participantId)
    helper_id = normalize_participant_id(body.helperId)
    helpee_id = normalize_participant_id(body.helpeeId)
    function_name = body.functionName.strip()
    code = body.code.strip()
    concept = (body.concept or "").strip()

    if not participant_id or not helper_id or not helpee_id or not function_name or not code:
        return {"status": "error", "message": "Missing participant, helper, helpee, functionName, or code."}

    session_key = _help_session_key(helper_id, helpee_id)
    session = editor_manager.active_help_context.get(session_key)
    if not session:
        return {"status": "error", "message": "No active help context for this helper/helpee pair."}

    group = _resolve_help_variant_group(helper_id, helpee_id, function_name)
    if not group:
        helpee_function_map = parse_top_level_functions(editor_manager.individual.get(helpee_id, ""))
        base_function_code = (
            helpee_function_map.get(function_name)
            or session.get("helpeeFunctionCode", "")
            or code
        )
        group = _ensure_help_variant_group(
            helper_id=helper_id,
            helpee_id=helpee_id,
            function_name=function_name,
            concept=concept or session.get("concept", ""),
            focus_code=session.get("focusCode", ""),
            focus_line_start=session.get("focusLineStart", 1),
            focus_line_end=session.get("focusLineEnd", 1),
            base_function_code=base_function_code,
            session_key=session_key,
        )

    variant = _make_variant_entry(
        group=group,
        author_id=participant_id,
        kind="manual",
        code=code,
    )
    group["variants"].append(variant)
    await _broadcast_help_variant_group(
        group,
        "helpVariantCreated",
        {
            "participantId": participant_id,
            "helperId": helper_id,
            "helpeeId": helpee_id,
            "functionName": function_name,
            "variant": variant,
        },
    )
    return {"status": "success", "variantId": variant["variantId"]}


@app.post("/help/comment")
async def add_help_variant_comment(body: HelpCommentBody):
    author_id = normalize_participant_id(body.authorId)
    helper_id = normalize_participant_id(body.helperId)
    helpee_id = normalize_participant_id(body.helpeeId)
    function_name = body.functionName.strip()
    variant_id = body.variantId.strip()
    comment_body = body.body.strip()

    if not author_id or not helper_id or not helpee_id or not function_name or not variant_id or not comment_body:
        return {"status": "error", "message": "Missing author, helper, helpee, function, variant, or comment body."}

    group = _resolve_help_variant_group(helper_id, helpee_id, function_name)
    if not group:
        return {"status": "error", "message": "No local variants exist for this function."}

    comment = _make_comment_entry(
        author_id=author_id,
        variant_id=variant_id,
        body=comment_body,
        concept=(body.concept or group.get("concept", "")).strip(),
        line_start=body.lineStart,
        line_end=body.lineEnd,
    )
    group["comments"].append(comment)
    await _broadcast_help_variant_group(
        group,
        "helpCommentAdded",
        {
            "authorId": author_id,
            "helperId": helper_id,
            "helpeeId": helpee_id,
            "functionName": function_name,
            "comment": comment,
        },
    )
    return {"status": "success", "commentId": comment["commentId"]}


@app.get("/profiles")
def get_all_profiles():
    """Get all participant profiles"""
    return {"status": "success", "profiles": profile_manager.get_all_profiles()}


@app.post("/debug/clear-participants")
async def clear_participants():
    """Wipe all participant-keyed in-memory state and tell connected clients to reset."""
    global cursor_positions, state
    cleared = {
        "profiles": len(profile_manager.profiles),
        "individual_editors": len(editor_manager.individual),
        "active_profiles": len(editor_manager.profiles),
        "help_queue": len(editor_manager.help_queue),
        "active_help_sessions": len(editor_manager.active_help_sessions),
        "pending_help_context": len(editor_manager.pending_help_context),
        "active_help_context": len(editor_manager.active_help_context),
        "help_variant_groups": len(editor_manager.help_variant_groups),
        "generated_help_drafts": len(editor_manager.generated_help_drafts),
        "participant_concepts": len(editor_manager.participant_concepts),
        "participant_concept_evidence": len(editor_manager.participant_concept_evidence),
        "cursors": len(cursor_positions),
        "graph_nodes_reset": len(graph_manager.graph),
    }
    profile_manager.profiles.clear()
    editor_manager.individual.clear()
    editor_manager.profiles.clear()
    editor_manager.help_queue.clear()
    editor_manager.active_help_sessions.clear()
    editor_manager.pending_help_context.clear()
    editor_manager.active_help_context.clear()
    editor_manager.help_variant_groups.clear()
    editor_manager.generated_help_drafts.clear()
    editor_manager.participant_concepts.clear()
    editor_manager.participant_concept_evidence.clear()
    editor_manager.master = ""
    cursor_positions.clear()
    state = ""
    # Reset every graph node's progress so tests can run fresh for next participants.
    for node in graph_manager.graph.values():
        node.claimed_by = ""
        node.work_status = 0
        node.completed = 0
        node.total = 0
    await socketManager.broadcast(json.dumps({"event": "participantsCleared"}))
    return {"status": "success", "cleared": cleared}


@app.get("/debug/states")
def debug_states():
    """Debug endpoint: returns current participant cognitive states and accumulated concepts."""
    return {
        "participantStates": get_participant_states(),
        "accumulatedConcepts": editor_manager.participant_concepts,
        "conceptEvidence": editor_manager.participant_concept_evidence,
        "activeProfiles": editor_manager.profiles,
    }


@app.post("/debug/simulate-concepts")
def debug_simulate_concepts(body: dict):
    """Debug: simulate a participant having completed concepts so helper suggestions work.
    POST { "participant": "B", "concepts": ["Dictionary Lookup", "List Operations"] }
    """
    pid = body.get("participant", "")
    concepts = body.get("concepts", [])
    existing = editor_manager.participant_concepts.get(pid, [])
    editor_manager.participant_concepts[pid] = list(set(existing + concepts))
    return {"status": "ok", "participant_concepts": editor_manager.participant_concepts}


@app.post("/debug/simulate-task")
def debug_simulate_task(body: dict):
    """Debug: simulate a participant working on a task.
    POST { "participant": "A", "task": "calculate_order_cost" }
    """
    pid = body.get("participant", "")
    task = body.get("task", "")
    editor_manager.profiles[pid] = task
    return {"status": "ok", "profiles": editor_manager.profiles}


@app.post("/reply")
async def reply_to_notif(body: ReplyBody):
    # user_response(body.id, body.choice)
    print(body.id, body.choice)
    if body.choice == "Help":
        body_id_clean = normalize_participant_id(body.id)
        queue_ids = {
            _queue_entry_parts(entry)[0]
            for entry in editor_manager.help_queue
        }
        if body_id_clean not in queue_ids:
            editor_manager.help_queue.append(body.id)
        print("help queu is ", editor_manager.help_queue)
        await editor_manager.send_notification(body.id, task="", done=False)


@app.post("/replyToHelp")
async def reply_to_help(body: ReplyBody):
    print("help queue is ", editor_manager.help_queue)
    helpType = ""
    if body.choice == "Quick Help 💡":
        helpType = "quick"
    elif body.choice == "I am fully stuck 🆘":
        helpType = "a lot of"
    else:
        helpType = "none"

    if helpType != "none":
        # Check if id is already in the queue
        for idx, entry in enumerate(editor_manager.help_queue):
            existing_id, _ = _queue_entry_parts(entry)
            if existing_id == normalize_participant_id(body.id):
                # Update the existing entry
                editor_manager.help_queue[idx] = (body.id, helpType)
                break
        else:
            # ID not found — add new entry
            editor_manager.help_queue.append((body.id, helpType))

    print("help queue is ", editor_manager.help_queue)


@app.post("/helpMe")
async def helpMe(body: ReplyBody):
    # Send help-type options back to the helpee
    await editor_manager.send_notification(body.id, task="", done=False)

    # Immediately broadcast to all OTHER participants that this user needs help
    helpee_id = body.id.replace('"', '')
    helpee_profile = profile_manager.get_profile(helpee_id)
    helpee_name = helpee_profile.name if helpee_profile else helpee_id
    helpee_photo = helpee_profile.photo if helpee_profile else None

    broadcast_event = {
        "event": "helpRequest",
        "payload": {
            "helpeeId": helpee_id,
            "helpeeName": helpee_name,
            "helpeePhoto": helpee_photo,
        },
    }
    for ws in socketManager.connections:
        if ws.id != helpee_id:
            await ws.send_text(json.dumps(broadcast_event))


async def _monitor_progress_loop():
    while True:
        await asyncio.sleep(10)
        try:
            for key, value in graph_manager.graph.items():
                if (
                    value.start_time is not None
                    and get_time_diff(value.start_time) > 150
                    and value.work_status == 1
                    and len([
                        t for t in editor_manager.help_queue
                        if _queue_entry_parts(t)[0] == normalize_participant_id(value.claimed_by)
                    ]) == 0
                ):
                    await editor_manager.send_notification(value.claimed_by, "", False)
                    graph_manager.graph[key].start_time = datetime.now()
        except Exception as e:
            print(f"[monitor_progress] error: {e}")


@app.on_event("startup")
async def startup_event():
    asyncio.create_task(_monitor_progress_loop())


class Chat(BaseModel):
    chat: str
    time: int
    task: str

@app.get("/percent")
def percent():
    print(len(graph_manager.graph))
    return graph_manager.percent_done()

@app.post("/ollama")
async def ollama(flex: Chat):
    # response = editor_manager.generate_options_for_helping(
    #     flex.chat, flex.task, flex.time
    # )
    # response = editor_manager.completeness_check(flex.chat)
    # response = await editor_manager.get_open_ai_response(flex.chat)
    response =editor_manager.get_open_ai_response(flex.chat)

    return response
