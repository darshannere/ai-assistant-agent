import asyncio
import os
import aiohttp
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse
from fastapi import Response
from typing import Dict, Callable, List, Optional
from pydantic import BaseModel
import subprocess
import re
import sys
import io
import ast
from textwrap import dedent
import csv
from collections import ChainMap, defaultdict
import json
import study_problem_sol
from datetime import datetime, timedelta
import time as _time
import google.generativeai as genai
from openai import OpenAI
from concept_reference_map import CONCEPT_REFERENCE_TEMPLATES
app = FastAPI()

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

class PredictionResponse(BaseModel):
    prediction: int
    completed: int

class HelpRequest(BaseModel):
    helper: str
    time: int
    hint: str = "this is hint"

class EditorManager:
    def __init__(self):
        self.master = ""
        self.individual = {}
        self.profiles = {}
        self.help_queue = []
        self.active_help_sessions: List[Dict] = []  # tracks who is helping whom
        self.participant_concepts: Dict[str, List[str]] = {}  # accumulated concepts per participant
        self.participant_concept_evidence: Dict[str, Dict[str, List[Dict]]] = {}
        # client = genai.Client(api_key="")
        # self.client = client
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
    helper=body.helper
    time=body.time
    hint=body.hint
    connected_ids = {
        conn.id for conn in socketManager.connections if conn.id != "control"
    }
    helpee = editor_manager.help_queue[0][0]

    if helpee in connected_ids and helper in connected_ids:
        event = {
            "event": "StartHelpSession",
            "payload": {
                "helpee": helpee,
                "helper": helper,
                "time": time * 60,
                "hint": hint,
            },
        }
        await socketManager.broadcast(json.dumps(event))
        print("Starting help session between helpee ", helpee, "and helper ", helper)
        print(event)
        editor_manager.help_queue.pop(0)
        # Track the active help session
        helper_clean = helper.replace('"', '')
        helpee_clean = helpee.replace('"', '')
        helper_profile = profile_manager.get_profile(helper_clean)
        helpee_profile = profile_manager.get_profile(helpee_clean)
        editor_manager.active_help_sessions.append({
            "helperId": helper_clean,
            "helperName": helper_profile.name if helper_profile else helper_clean,
            "helperPhoto": helper_profile.photo if helper_profile else None,
            "helpeeId": helpee_clean,
            "helpeeName": helpee_profile.name if helpee_profile else helpee_clean,
            "helpeePhoto": helpee_profile.photo if helpee_profile else None,
            "duration": time * 60,
            "startedAt": int(_time.time()),
        })
        print(editor_manager.help_queue)
        return {"status": "success"}

    else:
        return {"status": "failure", "message": "One or both users not connected"}


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
    work_statuses = [
        {node: graph_manager.graph[node].work_status}
        for node in graph_manager.graph
    ]
    graph_event = {
        "event": "updateGraph",
        "payload": {
            "graph": dict(ChainMap(*work_statuses)),
            "participantStates": get_participant_states(),
        },
    }
    await socketManager.broadcast(json.dumps(graph_event))

    return Response(content=buffer.getvalue(), media_type="text/plain")


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
                editor_manager.update_individual(id, code)
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
                help_request_event = {
                    "event": "helpRequest",
                    "payload": {
                        "helpeeId": helpee_id,
                        "helpeeName": helpee_profile.name if helpee_profile else payload.get("helpeeName", helpee_id),
                        "helpeePhoto": helpee_profile.photo if helpee_profile else payload.get("helpeePhoto"),
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


@app.get("/task/{node}")
def get_task_details(node):
    """Return structured task data (description, concepts, examples, starter code) as JSON."""
    if node not in graph_manager.graph:
        return {"status": "not_found"}
    g = graph_manager.graph[node]
    signature = FUNCTION_SIGNATURES.get(node, f"{node}()")
    starter = f'def {signature}:\n    """\n    {g.desc}\n    """\n    pass\n'
    return {
        "status": "ok",
        "name": node,
        "description": g.desc,
        "concepts": g.concepts,
        "example_input": g.example_input,
        "example_output": g.example_output,
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

    # Demo: When participant B registers, auto-mark calculate_order_cost as completed by B
    pid = profile.id.replace('"', '')
    if pid == "B":
        node = graph_manager.graph.get("calculate_order_cost")
        if node and node.work_status != 2:
            node.claimed_by = pid
            node.work_status = 2
            node.completed = node.total or 1
            node.total = node.total or 1
            # Seed B's accumulated concepts so helper suggestions work
            concepts = [c.strip() for c in node.concepts.split(",") if c.strip()]
            existing = editor_manager.participant_concepts.get(pid, [])
            editor_manager.participant_concepts[pid] = list(
                dict.fromkeys(existing + concepts)
            )

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
        queue_items.append({
            "id": pid_clean,
            "name": profile.name if profile else pid_clean,
            "photo": profile.photo if profile else None,
            "helpType": help_type,
            "currentTask": current_task or None,
            "taskConcepts": task_concepts,
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
        if body.id not in editor_manager.help_queue:
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
        for idx, (existing_id, _) in enumerate(editor_manager.help_queue):
            if existing_id == body.id:
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
                    and len([t for t in editor_manager.help_queue if t[0] ==
                             value.claimed_by]) == 0
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
