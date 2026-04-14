"""
End-to-end test for the keyword concept detection system.
Tests detect_concepts_from_code() against real-world code snippets
that mimic what participants would actually type in the study.

Run:  python apps/api/src/test_concept_detection.py
"""

import re
import sys
import json
from typing import Any

# ── Inline copy of detection logic (so tests don't need the server running) ──

KEYWORD_TO_CONCEPTS = {
    "while": ["Looping", "Looping (while loop)"],
    "for": ["Looping"],
    "if": ["Conditional Statement (If-else)", "Conditional (if-else)", "Conditional Statements"],
    "elif": ["Conditional Statement (If-else)", "Conditional (if-else)"],
    "else": ["Conditional Statement (If-else)", "Conditional (if-else)"],
    "dict": ["Dictionary concepts", "Dictionary Operation", "Dictionary Operations", "Dictionary Lookup", "Dictionary iteration"],
    "list": ["List Operations", "List concepts"],
    "append": ["List Operations", "List concepts"],
    "remove": ["List Operations", "List concepts"],
    "pop": ["List Operations", "List concepts"],
    ".format(": ["String Interpolation"],
    "tuple": ["Tuple"],
    "def": ["Function Calling"],
    "random": ["Random num generation"],
    "class": ["Object initialization"],
    "__init__": ["Object initialization"],
}


def detect_concepts_from_code(code: str) -> list[str]:
    detected = set()
    code_lower = code.lower()
    for keyword, concepts in KEYWORD_TO_CONCEPTS.items():
        if len(keyword) <= 3:
            if re.search(r'(?:^|[\s(.])' + re.escape(keyword) + r'(?:[\s(:"\']|$)', code_lower):
                detected.update(concepts)
        else:
            if keyword.lower() in code_lower:
                detected.update(concepts)
    if re.search(r'''f["']''', code):
        detected.add("String Interpolation")
    return sorted(detected)


# ── Test infrastructure ──

PASS = 0
FAIL = 0
EDGE_CASES: list[str] = []


def check(name: str, code: str, expected_present: list[str], expected_absent: list[str] | None = None):
    global PASS, FAIL
    result = set(detect_concepts_from_code(code))
    ok = True
    issues = []

    for concept in expected_present:
        if concept not in result:
            ok = False
            issues.append(f"  MISSING: '{concept}'")

    for concept in (expected_absent or []):
        if concept in result:
            ok = False
            issues.append(f"  FALSE POSITIVE: '{concept}'")

    if ok:
        PASS += 1
        print(f"  PASS  {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}")
        for i in issues:
            print(f"        {i}")
        print(f"        Got: {sorted(result)}")


# ── 1. BASIC KEYWORD DETECTION ──

print("\n=== 1. BASIC KEYWORD DETECTION ===\n")

check("for loop",
      "for item in menu:\n    print(item)",
      ["Looping"])

check("while loop",
      "while count > 0:\n    count -= 1",
      ["Looping", "Looping (while loop)"])

check("if statement",
      "if x > 5:\n    print('big')",
      ["Conditional Statement (If-else)", "Conditional (if-else)", "Conditional Statements"])

check("if/elif/else chain",
      "if x > 5:\n    pass\nelif x > 0:\n    pass\nelse:\n    pass",
      ["Conditional Statement (If-else)", "Conditional (if-else)"])

check("dict keyword",
      "d = dict()\nd['key'] = 1",
      ["Dictionary concepts", "Dictionary Operation"])

check("list keyword",
      "items = list()\nitems.append('a')",
      ["List Operations", "List concepts"])

check("append without list",
      "orders.append(new_order)",
      ["List Operations", "List concepts"])

check("remove call",
      "items.remove('chicken')",
      ["List Operations", "List concepts"])

check("pop call",
      "items.pop(0)",
      ["List Operations", "List concepts"])

check(".format() string",
      'msg = "Hello {}".format(name)',
      ["String Interpolation"])

check("f-string double quotes",
      'msg = f"Hello {name}"',
      ["String Interpolation"])

check("f-string single quotes",
      "msg = f'Total: {cost}'",
      ["String Interpolation"])

check("tuple keyword",
      "result = tuple([1, 2, 3])",
      ["Tuple"])

check("def function",
      "def calculate_cost(order, menu):\n    pass",
      ["Function Calling"])

check("random import",
      "import random\norder_id = random.randint(1000, 9999)",
      ["Random num generation"])

check("class definition",
      "class Restaurant:\n    def __init__(self):\n        self.menu = {}",
      ["Object initialization", "Function Calling"])

check("__init__ standalone",
      "def __init__(self, name):\n    self.name = name",
      ["Object initialization", "Function Calling"])


# ── 2. REALISTIC STUDY FUNCTIONS (from functions.csv) ──

print("\n=== 2. REALISTIC STUDY FUNCTIONS ===\n")

check("view_menu implementation",
      """def view_menu(menu):
    print("item | cost")
    for item in menu.items:
        print(f"{item.name} | {item.cost}")""",
      ["Looping", "String Interpolation", "Function Calling"])

check("create_order implementation",
      """def create_order(customer):
    order_id = random.randint(1000, 9999)
    while order_id in customer.orders:
        order_id = random.randint(1000, 9999)
    customer.orders[order_id] = Order()
    return order_id""",
      ["Random num generation", "Looping", "Looping (while loop)", "Function Calling"])

check("clear_order implementation",
      """def clear_order(customer, order_id):
    order = customer.orders[order_id]
    order.items = list()
    order.cost = 0
    return "Order cleared." """,
      ["List Operations", "List concepts"])

check("add_to_order implementation",
      """def add_to_order(customer, order_id, menu, item_name):
    if item_name in menu.items:
        customer.orders[order_id].items.append(item_name)
        cost = menu.items[item_name]
        customer.orders[order_id].cost += cost
        return f"Added {item_name}: {cost}"
    else:
        return f"{item_name} not on menu" """,
      ["Conditional Statement (If-else)", "List Operations", "String Interpolation", "Function Calling"])

check("remove_from_order implementation",
      """def remove_from_order(customer, order_id, menu, item_name):
    order = customer.orders[order_id]
    if item_name in order.items:
        order.items.remove(item_name)
        order.cost -= menu.items[item_name]
        return f"Removed {item_name}"
    else:
        return f"{item_name} not in order" """,
      ["Conditional Statement (If-else)", "List Operations", "String Interpolation", "Function Calling"])

check("calculate_order_cost implementation",
      """def calculate_order_cost(order, menu):
    total = 0
    for item in order.items:
        total += menu.items[item]
    return total""",
      ["Looping", "Function Calling"])

check("cook_order implementation",
      """def cook_order(restaurant):
    if len(restaurant.order_queue) == 0:
        return (-1, 0)
    order = restaurant.order_queue.pop(0)
    cook_time = 0
    for item in order.items:
        cook_time += restaurant.cook_times[item]
    return tuple([order.id, cook_time])""",
      ["Conditional Statement (If-else)", "Looping", "List Operations", "Tuple", "Function Calling"])

check("restock_inventory implementation",
      """def restock_inventory(restaurant, item, qty):
    if item in restaurant.inventory:
        restaurant.inventory[item] += qty
        print(f"Restocked {item}. New quantity: {restaurant.inventory[item]}")
    else:
        print(f"{item} not found in inventory")""",
      ["Conditional Statement (If-else)", "String Interpolation", "Function Calling"])

check("get_receipt implementation",
      """def get_receipt(customer, menu):
    for name, orders in customer.items():
        print(f"{name}:")
        print("-----")
        for oid, order in orders.items():
            print(oid)
            for item in order.items:
                cost = menu.items[item]
                print(f"  {item} - ${cost:.2f}")
            total = calculate_order_cost(order, menu)
            print(f"Total: ${total:.2f}")""",
      ["Looping", "String Interpolation", "Function Calling"])

check("average_cook_time implementation",
      """def average_cook_time(restaurant):
    total = 0
    count = 0
    for order in restaurant.order_queue:
        for item in order.items:
            total += cook_time_helper(restaurant, item)
            count += 1
    avg = total / count if count else 0
    print(f"Average cooking time: {avg:.2f} minutes.")""",
      ["Looping", "String Interpolation", "Function Calling"])


# ── 3. EDGE CASES & FALSE POSITIVES ──

print("\n=== 3. EDGE CASES & FALSE POSITIVES ===\n")

check("empty string",
      "",
      [],
      ["Looping", "Conditional Statement (If-else)"])

check("just a comment",
      "# this is a comment about formatting",
      [],
      ["String Interpolation"])

check("'for' inside variable name should NOT match",
      "information = 42\nperformance = 'good'",
      [],
      ["Looping"])

# This one is a known weakness — 'for' inside 'information' with the regex
# Let's see if the regex boundary check prevents it

check("'if' inside variable name should NOT match",
      "notification = True\nverification = False",
      [],
      ["Conditional Statement (If-else)"])

check("'class' inside 'classname' variable",
      "classname = 'Restaurant'",
      ["Object initialization"],  # substring match will trigger — this is a known limitation
      [])

check("multiline string with keywords",
      '''help_text = """
To use this program:
- for each order, call add_to_order
- if you want to remove, call remove_from_order
"""''',
      ["Looping", "Conditional Statement (If-else)"],  # keywords appear in string literals
      [])

check("dict comprehension",
      "costs = {item: menu[item] for item in order.items}",
      ["Looping"])  # 'for' present; no 'dict' keyword though

check("list comprehension",
      "names = [item.name for item in menu.items]",
      ["Looping"])  # 'for' is there; 'list' is not keyword form

check("f-string with no content",
      'x = f""',
      ["String Interpolation"])

check("format method on non-string",
      "result = template.format(name=n, cost=c)",
      ["String Interpolation"])

check("import random at top",
      "import random\n\nx = 5",
      ["Random num generation"])

check("random in comment only",
      "# random approach to solving\nx = 5",
      ["Random num generation"])  # known limitation: keyword in comments triggers

check("nested if inside for",
      "for item in items:\n    if item > 0:\n        total += item",
      ["Looping", "Conditional Statement (If-else)", "Conditional (if-else)", "Conditional Statements"])

check("tuple literal without keyword",
      "result = (order_id, cook_time)",
      [],
      ["Tuple"])  # parens alone don't trigger — need 'tuple' keyword

check("dictionary literal without keyword",
      "menu = {'chicken': 12.0, 'pork': 10.0}",
      [],
      ["Dictionary concepts"])  # curly braces don't trigger — need 'dict' keyword

check("single character 'if' at start of line",
      "if True:\n    pass",
      ["Conditional Statement (If-else)"])

check("'else' after 'if' on same line (ternary)",
      "x = 5 if condition else 10",
      ["Conditional Statement (If-else)", "Conditional (if-else)"])

check("while True infinite loop",
      "while True:\n    data = input()\n    if data == 'quit':\n        break",
      ["Looping", "Looping (while loop)", "Conditional Statement (If-else)"])

check("def with decorator",
      "@staticmethod\ndef helper():\n    pass",
      ["Function Calling"])

check("pop and append together",
      "item = queue.pop(0)\nresults.append(item)",
      ["List Operations", "List concepts"])


# ── 4. PARTIAL / IN-PROGRESS CODE (mimics real-time typing) ──

print("\n=== 4. PARTIAL / IN-PROGRESS CODE (real-time typing) ===\n")

check("just typed 'for '",
      "for ",
      ["Looping"])

check("just typed 'if '",
      "if ",
      ["Conditional Statement (If-else)", "Conditional (if-else)", "Conditional Statements"])

check("just typed 'def '",
      "def ",
      ["Function Calling"])

check("just typed 'while '",
      "while ",
      ["Looping", "Looping (while loop)"])

check("incomplete for loop",
      "for item in",
      ["Looping"])

check("incomplete if with comparison",
      "if x >",
      ["Conditional Statement (If-else)", "Conditional (if-else)", "Conditional Statements"])

check("typing .append(",
      "orders.append(",
      ["List Operations", "List concepts"])

check("typing f-string opening",
      "msg = f'",
      ["String Interpolation"])

check("blank personal playground template",
      """# Personal Playground
# Code will not be shared with others
from study_problem_classes import Menu, Order, Customer, Restaurant

def view_menu(menu: Menu):
    pass""",
      ["Function Calling"],
      [])  # 'pass' shouldn't trigger anything weird


# ── 5. AI FALLBACK TEST (requires running server) ──

print("\n=== 5. AI FALLBACK (POST /detectHelper — requires server at localhost:8000) ===\n")

try:
    import requests

    # Test 1: Code with clear keywords — should use keyword path
    resp = requests.post("http://localhost:8000/detectHelper", json={
        "participant_id": "A",
        "code": "for item in order.items:\n    total += menu.items[item]"
    }, timeout=5)
    data = resp.json()
    print(f"  Keyword path: detected={data.get('detectedConcepts', [])}, suggestion={data.get('suggestion')}")

    # Test 2: Code with no obvious keywords — should fall through to AI
    resp2 = requests.post("http://localhost:8000/detectHelper", json={
        "participant_id": "A",
        "code": """
# Calculate the total price of all items ordered
total_price = sum(menu_prices[item_name] for item_name in ordered_items)
receipt_text = "\\n".join(
    "{}: ${:.2f}".format(name, menu_prices[name]) for name in ordered_items
)
"""
    }, timeout=15)
    data2 = resp2.json()
    print(f"  AI path:      detected={data2.get('detectedConcepts', [])}, suggestion={data2.get('suggestion')}")

    # Test 3: Empty code — should return nothing
    resp3 = requests.post("http://localhost:8000/detectHelper", json={
        "participant_id": "A",
        "code": ""
    }, timeout=5)
    data3 = resp3.json()
    print(f"  Empty code:   detected={data3.get('detectedConcepts', [])}, suggestion={data3.get('suggestion')}")

    # Test 4: Very short code — should skip AI
    resp4 = requests.post("http://localhost:8000/detectHelper", json={
        "participant_id": "A",
        "code": "x = 5"
    }, timeout=5)
    data4 = resp4.json()
    print(f"  Short code:   detected={data4.get('detectedConcepts', [])}, suggestion={data4.get('suggestion')}")

    # Test 5: Help queue endpoint
    resp5 = requests.get("http://localhost:8000/helpQueue", timeout=5)
    data5 = resp5.json()
    print(f"  Help queue:   {len(data5.get('queue', []))} in queue, {len(data5.get('connectedParticipants', []))} connected")

except requests.exceptions.ConnectionError:
    print("  SKIP  Server not running at localhost:8000 — start it to test AI fallback + endpoints")
except ImportError:
    print("  SKIP  'requests' not installed — pip install requests")
except Exception as e:
    print(f"  ERROR {e}")


# ── SUMMARY ──

print(f"\n{'='*50}")
print(f"RESULTS: {PASS} passed, {FAIL} failed out of {PASS + FAIL} tests")

if FAIL > 0:
    print("\nKNOWN LIMITATIONS (by design):")
    print("  - Keywords in comments/strings trigger detection (no AST parsing)")
    print("  - Substring matches for long keywords (e.g., 'class' in 'classname')")
    print("  - Dict/list literals ({}/[]) don't trigger without 'dict'/'list' keyword")
    print("  - Tuple literals (x, y) don't trigger without 'tuple' keyword")
    print("  - No detection for: set operations, exception handling, generators")

sys.exit(1 if FAIL > 0 else 0)
