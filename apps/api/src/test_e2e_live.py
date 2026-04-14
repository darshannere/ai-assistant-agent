"""
Live end-to-end test — acts as real users against the running server.
Requires: server running at localhost:8000

Simulates:
  1. Register 3 participants (A=Alice, B=Bob, C=Carol)
  2. Participant B completes a task (seeds concepts)
  3. Participant A connects via WebSocket and types code
  4. Verify A receives helperSuggestion from backend
  5. A requests help via helpMe endpoint
  6. Verify help queue shows A
  7. B accepts and starts help session
  8. Verify queue is cleared
  9. Test /detectHelper with AI fallback
  10. Test debounce (rapid-fire updates should NOT all trigger detection)
"""

import requests
import json
import time
import asyncio
import websockets

BASE = "http://localhost:8000"
WS_BASE = "ws://localhost:8000"


def step(n, desc):
    print(f"\n{'='*60}")
    print(f"  STEP {n}: {desc}")
    print(f"{'='*60}")


def check(label, condition, detail=""):
    status = "PASS" if condition else "FAIL"
    print(f"  [{status}] {label}")
    if detail:
        print(f"         {detail}")
    return condition


# ── STEP 1: Register participants ──

step(1, "Register 3 participants")

for pid, name in [("A", "Alice"), ("B", "Bob"), ("C", "Carol")]:
    r = requests.post(f"{BASE}/profile", json={
        "id": pid, "name": name, "photo": "", "timestamp": int(time.time())
    })
    check(f"Register {name} ({pid})", r.status_code == 200, f"status={r.status_code}")

# Verify profiles exist
r = requests.get(f"{BASE}/profiles")
profiles = r.json()
check("All profiles saved", profiles["status"] == "success" and len(profiles["profiles"]) >= 3,
      f"got {len(profiles.get('profiles', {}))} profiles")


# ── STEP 2: Verify B has seeded concepts (auto-marked on register) ──

step(2, "Verify B's auto-seeded concepts")

r = requests.get(f"{BASE}/debug/states")
data = r.json()
b_concepts = data.get("accumulatedConcepts", {}).get("B", [])
check("B has seeded concepts", len(b_concepts) > 0, f"B concepts: {b_concepts}")


# ── STEP 3-4: WebSocket — A types code, gets helperSuggestion ──

step(3, "A connects via WebSocket and types code with matching concepts")

async def test_ws_helper_suggestion():
    received_events = []

    async with websockets.connect(f"{WS_BASE}/ws/A") as ws:
        # Read initial messages (updateMaster etc)
        try:
            for _ in range(5):
                msg = await asyncio.wait_for(ws.recv(), timeout=2)
                data = json.loads(msg)
                received_events.append(data.get("event"))
        except asyncio.TimeoutError:
            pass

        check("A connected, got initial events", len(received_events) > 0,
              f"events: {received_events}")

        # Simulate typing code with "for" loop (should match B's "Looping" concept)
        code = "for item in order.items:\n    total += menu.items[item]"
        await ws.send(json.dumps({
            "event": "updatePlayground",
            "payload": {"doc": code}
        }))
        print(f"  Sent updatePlayground with code: {code[:50]}...")

        # Wait for helperSuggestion event
        got_suggestion = False
        suggestion_data = None
        try:
            for _ in range(10):
                msg = await asyncio.wait_for(ws.recv(), timeout=3)
                data = json.loads(msg)
                if data.get("event") == "helperSuggestion":
                    got_suggestion = True
                    suggestion_data = data["payload"]
                    break
        except asyncio.TimeoutError:
            pass

        check("A received helperSuggestion", got_suggestion,
              f"suggestion: {json.dumps(suggestion_data, indent=2) if suggestion_data else 'NONE'}")

        if suggestion_data:
            check("Helper is Bob (B)",
                  suggestion_data.get("suggestion", {}).get("helperId") == "B",
                  f"helperId={suggestion_data.get('suggestion', {}).get('helperId')}")
            check("Detected concepts include Looping",
                  "Looping" in suggestion_data.get("detectedConcepts", []),
                  f"concepts={suggestion_data.get('detectedConcepts')}")
            check("Anchor keyword is 'for'",
                  suggestion_data.get("anchorKeyword") == "for",
                  f"anchor={suggestion_data.get('anchorKeyword')}")

asyncio.get_event_loop().run_until_complete(test_ws_helper_suggestion())


# ── STEP 5: Debounce test — rapid fire updates ──

step(4, "Debounce: rapid-fire updates should be throttled")

async def test_debounce():
    suggestion_count = 0

    async with websockets.connect(f"{WS_BASE}/ws/A") as ws:
        # Drain initial messages
        try:
            for _ in range(10):
                await asyncio.wait_for(ws.recv(), timeout=1)
        except asyncio.TimeoutError:
            pass

        # Send 10 rapid updates in < 1 second
        for i in range(10):
            code = f"for item in order.items:\n    total += {i}"
            await ws.send(json.dumps({
                "event": "updatePlayground",
                "payload": {"doc": code}
            }))
            await asyncio.sleep(0.05)  # 50ms between each

        # Collect responses for a few seconds
        try:
            for _ in range(30):
                msg = await asyncio.wait_for(ws.recv(), timeout=2)
                data = json.loads(msg)
                if data.get("event") == "helperSuggestion":
                    suggestion_count += 1
        except asyncio.TimeoutError:
            pass

    # With 3s debounce, 10 rapid updates should produce at most 1-2 suggestions
    check(f"Debounce working: {suggestion_count} suggestions for 10 rapid updates",
          suggestion_count <= 2,
          f"Expected <=2, got {suggestion_count}")

asyncio.get_event_loop().run_until_complete(test_debounce())


# ── STEP 6: A requests help via /helpMe ──

step(5, "A flags for help via /helpMe")

r = requests.post(f"{BASE}/helpMe", json={"id": "A", "choice": "Help", "text": ""})
check("helpMe call succeeded", r.status_code == 200, f"status={r.status_code}")

# helpMe broadcasts the request but does NOT add to queue yet —
# the user must submit their help type via /replyToHelp first
time.sleep(0.5)
r = requests.get(f"{BASE}/helpQueue")
queue = r.json()
check("Queue still empty (user hasn't chosen help type yet)", len(queue["queue"]) == 0,
      f"queue: {json.dumps(queue['queue'])}")


# ── STEP 7: A submits help type ──

step(6, "A submits 'fully stuck' help type")

r = requests.post(f"{BASE}/replyToHelp", json={"id": "A", "choice": "I am fully stuck 🆘", "text": ""})
check("replyToHelp succeeded", r.status_code == 200)

r = requests.get(f"{BASE}/helpQueue")
queue = r.json()
found_a = [q for q in queue["queue"] if q["id"] == "A"]
check("A in queue with helpType", len(found_a) > 0,
      f"entry: {found_a[0] if found_a else 'NOT FOUND'}")
if found_a:
    check("Help type is 'a lot of'", found_a[0]["helpType"] == "a lot of",
          f"got: {found_a[0]['helpType']}")


# ── STEP 8: B starts help session ──

step(7, "B starts help session with A")

async def test_help_session():
    # Connect both A and B via WebSocket
    async with websockets.connect(f"{WS_BASE}/ws/A") as ws_a, \
               websockets.connect(f"{WS_BASE}/ws/B") as ws_b:

        # Drain initial messages
        for ws in [ws_a, ws_b]:
            try:
                for _ in range(10):
                    await asyncio.wait_for(ws.recv(), timeout=1)
            except asyncio.TimeoutError:
                pass

        # B starts help session
        r = requests.post(f"{BASE}/StartHelpSession", json={
            "helper": "B", "time": 3, "hint": "Check looping patterns"
        })
        check("StartHelpSession succeeded", r.status_code == 200 and r.json().get("status") == "success",
              f"response: {r.json()}")

        # Both should receive StartHelpSession event
        for label, ws in [("A", ws_a), ("B", ws_b)]:
            got_it = False
            try:
                for _ in range(5):
                    msg = await asyncio.wait_for(ws.recv(), timeout=2)
                    data = json.loads(msg)
                    if data.get("event") == "StartHelpSession":
                        got_it = True
                        payload = data["payload"]
                        check(f"{label} received StartHelpSession",
                              payload["helpee"] == "A" and payload["helper"] == "B",
                              f"helpee={payload['helpee']}, helper={payload['helper']}, time={payload['time']}s")
                        break
            except asyncio.TimeoutError:
                pass
            if not got_it:
                check(f"{label} received StartHelpSession", False, "Timeout — no event received")

asyncio.get_event_loop().run_until_complete(test_help_session())

# Verify queue is now empty
r = requests.get(f"{BASE}/helpQueue")
queue = r.json()
check("Help queue cleared after session start", len(queue["queue"]) == 0,
      f"queue has {len(queue['queue'])} items")


# ── STEP 9: Test /detectHelper with AI fallback ──

step(8, "Test /detectHelper (keyword + AI fallback)")

# Keyword path
r = requests.post(f"{BASE}/detectHelper", json={
    "participant_id": "A",
    "code": "for item in order.items:\n    if item in menu:\n        total += menu[item]"
})
data = r.json()
check("Keyword detection found concepts", len(data.get("detectedConcepts", [])) > 0,
      f"concepts: {data.get('detectedConcepts')}")

# AI fallback path — code with no obvious keywords
r2 = requests.post(f"{BASE}/detectHelper", json={
    "participant_id": "A",
    "code": "total_price = sum(menu_prices[name] for name in ordered_items)\nreceipt = '\\n'.join('{}: ${:.2f}'.format(n, menu_prices[n]) for n in ordered_items)"
}, timeout=20)
data2 = r2.json()
check("AI fallback detected concepts", len(data2.get("detectedConcepts", [])) > 0,
      f"AI concepts: {data2.get('detectedConcepts')}")

# Empty code
r3 = requests.post(f"{BASE}/detectHelper", json={"participant_id": "A", "code": ""})
data3 = r3.json()
check("Empty code returns no concepts", data3.get("detectedConcepts") == [] and data3.get("suggestion") is None)

# Short code (should skip AI)
r4 = requests.post(f"{BASE}/detectHelper", json={"participant_id": "A", "code": "x = 5"})
data4 = r4.json()
check("Short code returns no concepts (no AI)", len(data4.get("detectedConcepts", [])) == 0)


# ── STEP 10: helpQueue enrichment ──

step(9, "Help queue data enrichment")

# Put A back in queue for this test
requests.post(f"{BASE}/replyToHelp", json={"id": "A", "choice": "Quick Help 💡", "text": ""})
time.sleep(0.3)
r = requests.get(f"{BASE}/helpQueue")
queue = r.json()

if len(queue["queue"]) > 0:
    entry = queue["queue"][0]
    check("Queue entry has name", entry.get("name") == "Alice", f"name={entry.get('name')}")
    check("Queue entry has helpType", entry.get("helpType") == "quick", f"helpType={entry.get('helpType')}")
    check("connectedParticipants is a list", isinstance(queue.get("connectedParticipants"), list),
          f"connected={queue.get('connectedParticipants')}")
else:
    check("A is in queue", False, "Queue is empty")


# ── SUMMARY ──

print(f"\n{'='*60}")
print(f"  E2E LIVE TEST COMPLETE")
print(f"{'='*60}")
